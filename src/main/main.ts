import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  MessageChannelMain,
  nativeImage,
  powerMonitor,
  type MessagePortMain,
  type WebContents
} from "electron";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import type {
  ControlCommand,
  Diagnostics,
  OcrFallbackFrame,
  OcrResult,
  OcrSnapshot,
  ScreenPlaceholder,
  StartOptions,
  VideoDiagnostics,
  VideoRecoveryRequest,
  VideoStage
} from "../shared/types";
import { isVideoPortReadyMessage } from "../shared/videoPort";
import { HdcClient, parseHdcVersion } from "./hdc";
import { captureForDevice } from "./deviceCapture";
import { discoverDevices } from "./deviceDiscovery";
import { AdbClient } from "./adb";
import { ApkInstaller } from "./apkInstaller";
import { validateImage } from "./deviceSnapshot";
import { RecordingFile } from "./recordingFile";
import { createRecordingPath } from "./recordingDestination";
import { AdbMirror } from "./adbMirror";
import { inspectScrcpy } from "./androidTools";
import { MirrorBridge, type VideoPacket } from "./mirrorBridge";
import { OcrService } from "./ocrService";
import { androidToolSettingsFile, resolveRuntimePaths } from "./paths";

import { WindowController } from "./windowController";

let windowController: WindowController | null = null;
let mainWindow: BrowserWindow | null = null;
let videoPort: MessagePortMain | null = null;
let videoPortReady = false;
const paths = resolveRuntimePaths();
const hdc = paths.hdc ? new HdcClient(paths.hdc) : null;
const harmonyMirror = new MirrorBridge(paths);
const androidMirror = new AdbMirror(paths, {
  prepare: prepareAndroidVideo,
  visible: () => !!mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()
});
let mirror: MirrorBridge | AdbMirror = harmonyMirror;
let mirrorBusy = false;
let mirrorStartTask: Promise<void> | null = null;
const apkInstaller = new ApkInstaller(() => paths.adb ? new AdbClient(paths.adb) : null, (serial) => {
  if (mirrorBusy) throw new Error("正在连接设备，请等待连接完成后再安装 APK");
  if (!["idle", "error"].includes(mirror.status.state)
    && (mirror !== androidMirror || androidMirror.serial !== serial || mirror.status.state === "stopping")) {
    throw new Error("请将 APK 拖到当前正在投屏的 Android 设备，或先停止投屏再选择设备");
  }
});
let closeAfterInstall = false;
let quitAfterInstall = false;
let recordingStartPending = false;
let closeAfterRecording = false;
const recordings = new RecordingFile();
const ocr = new OcrService(hdc, (progress) => {
  mainWindow?.webContents.send("ocr:progress", progress);
}, (key) => captureForDevice(paths, hdc, key, "ocr"));

function createWindow(): void {
  mainWindow = new BrowserWindow({
    frame: true,
    width: 1180,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: "#0a0d12",
    show: false,
    title: "鸿蒙 / Android 投屏助手",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  windowController = new WindowController(mainWindow, join(app.getPath("userData"), "window-state.json"));
  mainWindow.removeMenu();
  void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    androidMirror.cancelAutomaticRecovery();
    if (apkInstaller.busy) {
      event.preventDefault();
      if (!closeAfterInstall) {
        closeAfterInstall = true;
        void apkInstaller.wait().catch(() => {}).then(() => {
          closeAfterInstall = false;
          mainWindow?.close();
        });
      }
      return;
    }
    if (recordings.active && mainWindow && !mainWindow.webContents.isDestroyed()) {
      event.preventDefault();
      closeAfterRecording = true;
      mainWindow.webContents.send("recording:stop-request");
    }
  });
  mainWindow.on("closed", () => {
    videoPort?.close();
    videoPort = null;
    videoPortReady = false;
    windowController = null;
    mainWindow = null;
  });
}

let videoPreparation: {
  sessionId: number;
  acknowledged: boolean;
  finish(error?: Error): void;
} | null = null;

function prepareAndroidVideo(request: VideoRecoveryRequest): Promise<void> {
  videoPreparation?.finish(new Error("视频恢复请求已替换"));
  const target = mainWindow?.webContents;
  if (!target || target.isDestroyed()) return Promise.reject(new Error("投屏窗口已关闭"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => pending.finish(new Error("电脑端视频恢复准备超时")), 2_000);
    const pending = {
      sessionId: request.sessionId,
      acknowledged: false,
      finish(error?: Error) {
        if (videoPreparation !== pending) return;
        clearTimeout(timer);
        videoPreparation = null;
        error ? reject(error) : resolve();
      }
    };
    videoPreparation = pending;
    target.send("video:recover", request);
    attachVideoPort(target);
  });
}

ipcMain.on("video:recovery-ready", (event, sessionId: unknown) => {
  const pending = videoPreparation;
  if (mainWindow?.webContents !== event.sender || !pending || pending.sessionId !== sessionId) return;
  pending.acknowledged = true;
  if (videoPortReady) pending.finish();
});

function attachVideoPort(target: WebContents): void {
  const previousPort = videoPort;
  videoPort = null;
  videoPortReady = false;
  previousPort?.close();
  const channel = new MessageChannelMain();
  const port = channel.port2;
  videoPort = port;
  port.on("message", (event) => {
    if (videoPort === port && isVideoPortReadyMessage(event.data)) {
      videoPortReady = true;
      if (videoPreparation?.acknowledged) videoPreparation.finish();
    }
  });
  port.on("close", () => {
    if (videoPort === port) {
      videoPort = null;
      videoPortReady = false;
    }
  });
  port.start();
  target.postMessage("video-port", null, [channel.port1]);
}

for (const backend of [harmonyMirror, androidMirror]) {
  backend.on("status", (status) => {
    if (mirror === backend) mainWindow?.webContents.send("mirror:status", status);
  });
  backend.on("video", (packet: VideoPacket) => {
    if (mirror !== backend) return;
    if (!videoPort || !videoPortReady) {
      return;
    }
    const bytes = Uint8Array.from(packet.data);
    try {
      videoPort.postMessage({
        ...(backend === androidMirror ? { sessionId: androidMirror.videoSessionId } : {}),
        data: bytes.buffer,
        timestampUs: Number(packet.timestampUs),
        sequence: packet.sequence,
        flags: packet.flags
      });
    } catch (error) {
      const failedPort = videoPort;
      videoPort = null;
      failedPort?.close();
      videoPortReady = false;
      console.error(`[video-port] ${String(error)}`);
    }
  });
  backend.on("log", (line: string) => console.error(`[bridge] ${line}`));
}

function requireWindowController(sender: WebContents): WindowController {
  if (!mainWindow || mainWindow.webContents !== sender || !windowController) throw new Error("窗口不可用");
  return windowController;
}

ipcMain.handle("window:get-state", (event) => requireWindowController(event.sender).state);
ipcMain.handle("window:mode", (event, mode: unknown) => {
  if (mode !== "full" && mode !== "compact") throw new Error("窗口模式无效");
  return requireWindowController(event.sender).setMode(mode);
});
ipcMain.handle("window:action", (event, action: unknown) => {
  if (action !== "close" && action !== "minimize" && action !== "maximize-toggle") throw new Error("窗口操作无效");
  requireWindowController(event.sender).action(action);
});
ipcMain.on("window:video-size", (event, value: unknown) => {
  if (mainWindow?.webContents === event.sender) windowController?.reportVideoSize(value);
});

ipcMain.handle("apk:install", async (event, key: unknown, path: unknown) => {
  requireWindowController(event.sender);
  await apkInstaller.install(key, path);
});

ipcMain.handle("devices:list", async () => {
  return discoverDevices(hdc, paths.adb ? new AdbClient(paths.adb) : null);
});

ipcMain.handle("app:diagnostics", async (): Promise<Diagnostics> => {
  let hdcVersion: string | null = null;
  let hdcCompatible = false;
  if (hdc) {
    try {
      const parsed = parseHdcVersion(await hdc.version());
      hdcVersion = parsed.raw;
      hdcCompatible = parsed.compatible;
    } catch {
      hdcVersion = "无法读取";
    }
  }
  const scrcpyVersion = paths.scrcpy
    ? await inspectScrcpy(paths.scrcpy).then((tool) => tool.version).catch(() => null) : null;
  return {
    adbPath: paths.adb ?? null,
    scrcpyPath: paths.scrcpy ?? null,
    scrcpyVersion,
    appVersion: app.getVersion(),
    platform: `${process.platform} ${process.arch}`,
    hdcPath: paths.hdc,
    hdcVersion,
    hdcCompatible,
    sdkAvailable: existsSync(paths.sdkJar),
    javaPath: paths.java
  };
});

ipcMain.handle("android:configure", async () => {
  if (apkInstaller.busy) throw new Error("请等待 APK 安装完成后再更换工具");
  if (mirrorBusy || !["idle", "error"].includes(mirror.status.state)) throw new Error("请先停止投屏再更换工具");
  const selection = await dialog.showOpenDialog({
    title: "选择官方完整解压目录中的 scrcpy.exe", properties: ["openFile"],
    filters: [{ name: "scrcpy", extensions: ["exe"] }]
  });
  const executable = selection.filePaths[0];
  if (selection.canceled || !executable) return false;
  await inspectScrcpy(executable);
  const settingsFile = androidToolSettingsFile();
  await mkdir(dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, JSON.stringify({ scrcpyPath: executable }), "utf8");
  Object.assign(paths, resolveRuntimePaths());
  return true;
});

ipcMain.handle("mirror:start", async (_event, options: StartOptions) => {
  if (apkInstaller.busy) throw new Error("请等待 APK 安装完成后再切换设备");
  if (mirrorBusy) throw new Error("连接正在处理中，请稍候");
  mirrorBusy = true;
  try {
    if (options.backend !== undefined && options.backend !== "hdc" && options.backend !== "adb") throw new Error("设备类型无效");
    if (options.backend !== "adb") {
      if (!hdc) throw new Error("未找到 HDC");
      const info = parseHdcVersion(await hdc.version());
      if (!info.compatible) throw new Error(`HDC ${info.raw || "未知版本"} 过低，需要 3.2.0b 或更高版本`);
    }
    await ocr.cancel();
    await mirror.stop();
    mirror = options.backend === "adb" ? androidMirror : harmonyMirror;
    mirrorStartTask = mirror.start(options);
    await mirrorStartTask;
  } finally { mirrorBusy = false; mirrorStartTask = null; }
});
ipcMain.handle("mirror:stop", async () => {
  if (apkInstaller.busy) throw new Error("请等待 APK 安装完成后再断开投屏");
  await ocr.cancel();
  await mirror.stop();
});
function requireCurrentControlSession(sessionId: unknown, command?: ControlCommand): void {
  if (mirror !== androidMirror || sessionId === androidMirror.videoSessionId) return;
  const release = (command?.kind === "touch" && command.phase === "up") || (command?.kind === "wheel" && command.direction === "stop");
  if (release && mirror.status.state === "reconnecting" && sessionId === androidMirror.videoSessionId - 1) return;
  throw new Error("旧投屏会话的输入已取消，请在恢复画面后重新操作");
}
ipcMain.handle("mirror:control", async (_event, command: ControlCommand, sessionId: unknown) => {
  requireCurrentControlSession(sessionId, command);
  await mirror.control(command);
});
ipcMain.handle("clipboard:paste", async (_event, sessionId: unknown) => {
  requireCurrentControlSession(sessionId);
  const text = clipboard.readText();
  validateClipboardText(text);
  await mirror.control({ kind: "paste", text });
});
ipcMain.handle("clipboard:write", async (_event, text: unknown) => {
  if (typeof text !== "string") {
    throw new Error("复制内容必须是文本");
  }
  validateClipboardText(text);
  clipboard.writeText(text);
});
ipcMain.handle(
  "screen:capture-placeholder",
  async (_event, serial: string): Promise<ScreenPlaceholder> => {
    const snapshot = await captureForDevice(paths, hdc, serial, "placeholder");
    return {
      image: Uint8Array.from(snapshot.image).buffer,
      mimeType: snapshot.mimeType,
      width: snapshot.width,
      height: snapshot.height
    };
  }
);
ipcMain.handle(
  "ocr:capture",
  async (_event, serial: string, fallback?: OcrFallbackFrame): Promise<OcrSnapshot> =>
    ocr.capture(serial, fallback)
);
ipcMain.handle(
  "ocr:recognize",
  async (_event, snapshotId: string): Promise<OcrResult> => ocr.recognize(snapshotId)
);
ipcMain.handle("ocr:cancel", async (_event, snapshotId?: string) => ocr.cancel(snapshotId));

async function captureScreenshotImage(key: string, fallback?: OcrFallbackFrame): Promise<Electron.NativeImage> {
  let image: Buffer;
  try { image = (await captureForDevice(paths, hdc, key, "placeholder")).image; }
  catch {
    if (!fallback || !(fallback.image instanceof ArrayBuffer)) throw new Error("无法截图，请等待投屏画面恢复后重试");
    image = Buffer.from(fallback.image);
    validateImage(image, fallback.mimeType);
  }
  const result = nativeImage.createFromBuffer(image);
  if (result.isEmpty()) throw new Error("截图图像无效，请重新截图");
  return result;
}

let screenshotBusy = false;
ipcMain.handle("screen:copy", async (_event, key: string, fallback?: OcrFallbackFrame) => {
  if (screenshotBusy) throw new Error("截图正在处理中，请稍候");
  screenshotBusy = true;
  try {
    const image = await captureScreenshotImage(key, fallback);
    try { clipboard.writeImage(image); }
    catch {
      console.error("[screenshot] Clipboard image write failed");
      throw new Error("截图复制失败，请稍后重试");
    }
  } finally { screenshotBusy = false; }
});
ipcMain.handle("screen:save", async (_event, key: string, fallback?: OcrFallbackFrame) => {
  if (screenshotBusy) throw new Error("截图正在处理中，请稍候");
  screenshotBusy = true;
  try {
    const image = await captureScreenshotImage(key, fallback);
    const selection = await dialog.showSaveDialog({
      title: "保存手机截图", defaultPath: join(app.getPath("pictures"), `截图-${Date.now()}.png`),
      filters: [{ name: "PNG 图片", extensions: ["png"] }]
    });
    if (selection.canceled || !selection.filePath) return null;
    const path = /\.png$/i.test(selection.filePath) ? selection.filePath : `${selection.filePath}.png`;
    try { await writeFile(path, image.toPNG()); }
    catch { throw new Error("截图保存失败，请检查保存位置和磁盘空间"); }
    return path;
  } finally { screenshotBusy = false; }
});

ipcMain.handle("recording:begin", async () => {
  if (recordingStartPending || recordings.active) throw new Error("录屏正在处理中，请稍候");
  if (mirror.status.state !== "streaming") throw new Error("请先等待投屏画面显示");
  recordingStartPending = true;
  try {
    const path = await createRecordingPath(app.getPath("videos"));
    if (mirror.status.state !== "streaming") return null;
    const id = recordings.begin(path);
    mainWindow?.webContents.setBackgroundThrottling(false);
    return { id };
  } finally { recordingStartPending = false; }
});
ipcMain.handle("recording:append", async (_event, id: string, data: ArrayBuffer) => recordings.append(id, data));
ipcMain.handle("recording:finish", async (_event, id: string) => {
  try {
    const path = await recordings.finish(id);
    if (closeAfterRecording) { closeAfterRecording = false; setImmediate(() => mainWindow?.close()); }
    return path;
  } catch (error) { closeAfterRecording = false; throw error; }
  finally { mainWindow?.webContents.setBackgroundThrottling(true); }
});
ipcMain.on("mirror:request-idr", () => void mirror.requestIdr().catch(() => {}));
ipcMain.on("video-port:request", (event) => {
  if (mainWindow && event.sender.id === mainWindow.webContents.id) {
    attachVideoPort(event.sender);
  }
});
ipcMain.on("video:diagnostics", (event, value: unknown) => {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    return;
  }
  const diagnostics = parseVideoDiagnostics(value);
  if (!diagnostics) {
    return;
  }
  if (mirror === androidMirror) {
    androidMirror.updateVideoDiagnostics(diagnostics);
  } else if (diagnostics.stage === "error") {
    void mirror.failVideo(diagnostics.error ?? "视频解码失败");
  } else {
    mirror.updateVideoDiagnostics(diagnostics);
  }
});

app.whenReady().then(() => {
  createWindow();
  powerMonitor.on("suspend", () => androidMirror.suspendVideoMonitoring(true));
  powerMonitor.on("resume", () => androidMirror.suspendVideoMonitoring(false));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

let quitCleanupStarted = false;
app.on("before-quit", (event) => {
  if (quitCleanupStarted) return;
  androidMirror.cancelAutomaticRecovery();
  event.preventDefault();
  if (apkInstaller.busy) {
    if (!quitAfterInstall) {
      quitAfterInstall = true;
      void apkInstaller.wait().catch(() => {}).then(() => { quitAfterInstall = false; app.quit(); });
    }
    return;
  }
  if (recordings.active && mainWindow) {
    closeAfterRecording = true;
    mainWindow.webContents.send("recording:stop-request");
    return;
  }
  quitCleanupStarted = true;
  void (async () => {
    await mirrorStartTask?.catch(() => {});
    await Promise.allSettled([ocr.dispose(), mirror.stop()]);
    app.quit();
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

const VIDEO_STAGES = new Set<VideoStage>([
  "waiting-port",
  "waiting-stream",
  "waiting-config",
  "waiting-keyframe",
  "waiting-frame",
  "decoding",
  "switching",
  "error"
]);

function parseVideoDiagnostics(value: unknown): VideoDiagnostics | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const item = value as Partial<VideoDiagnostics>;
  if (
    !item.stage
    || !VIDEO_STAGES.has(item.stage)
    || typeof item.packets !== "number"
    || !Number.isSafeInteger(item.packets)
    || typeof item.bytes !== "number"
    || !Number.isSafeInteger(item.bytes)
    || (item.framing !== "unknown" && item.framing !== "annex-b" && item.framing !== "avcc")
    || typeof item.hasSps !== "boolean"
    || typeof item.hasPps !== "boolean"
    || typeof item.hasIdr !== "boolean"
  ) {
    return null;
  }
  if (item.sessionId !== undefined && (!Number.isSafeInteger(item.sessionId) || item.sessionId < 1
    || !Number.isSafeInteger(item.presentedFrames) || item.presentedFrames! < 0
    || typeof item.monitorPlayback !== "boolean")) return null;
  return {
    ...(item.sessionId !== undefined ? {
      sessionId: item.sessionId,
      presentedFrames: item.presentedFrames!,
      monitorPlayback: item.monitorPlayback!
    } : {}),
    stage: item.stage,
    packets: Math.max(0, item.packets),
    bytes: Math.max(0, item.bytes),
    framing: item.framing,
    hasSps: item.hasSps,
    hasPps: item.hasPps,
    hasIdr: item.hasIdr,
    ...(typeof item.error === "string" ? { error: item.error.slice(0, 400) } : {})
  };
}

function validateClipboardText(text: string): void {
  if (text.includes("\0")) {
    throw new Error("文本包含不支持的 NUL 字符");
  }
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) {
    throw new Error("文本不能超过 1 MiB");
  }
}
