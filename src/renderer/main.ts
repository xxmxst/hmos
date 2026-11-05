import "./polyfills";
import "./style.css";
import { deviceKey, VIDEO_PROFILES } from "../shared/types";
import type {
  ControlCommand,
  DeviceInfo,
  MirrorStatus,
  OcrLine,
  OcrProgress,
  OcrResult,
  OcrSnapshot,
  VideoProfile
} from "../shared/types";
import { VIDEO_PORT_WINDOW_MESSAGE } from "../shared/videoPort";
import {
  alignControlDimensionsToFrame,
  fitDimensions,
  mapClientPoint,
  resolveControlDimensions,
  type Dimensions
} from "./coordinates";
import { bindVideoPort } from "./videoPortClient";
import { VideoPipeline } from "./videoPipeline";
import { ScreenRecorder } from "./screenRecorder";
import { KeyboardInput } from "./keyboardInput";
import { WindowControls } from "./windowControls";
import { CompactConnection } from "./compactConnection";
import { ApkDropInstaller } from "./apkDropInstaller";
import {
  flattenOcrSymbols,
  nearestOcrSymbolIndex,
  normalizeOcrSelection,
  selectedOcrText as buildSelectedOcrText,
  type OcrSelectionRange,
  type SelectableOcrSymbol
} from "./ocrSelection";

const elements = {
  device: required<HTMLSelectElement>("device-select"),
  profile: required<HTMLSelectElement>("profile-select"),
  refresh: required<HTMLButtonElement>("refresh-devices"),
  configureAndroid: required<HTMLButtonElement>("configure-android"),
  connect: required<HTMLButtonElement>("connect-button"),
  compactConnect: required<HTMLButtonElement>("compact-connect-button"),
  compactConnection: required<HTMLDivElement>("compact-connection"),
  screenShell: required<HTMLDivElement>("screen-shell"),
  canvas: required<HTMLCanvasElement>("screen-canvas"),
  keyboardInput: required<HTMLTextAreaElement>("keyboard-input"),
  fallbackVideo: required<HTMLVideoElement>("fallback-video"),
  standbyVideo: required<HTMLVideoElement>("standby-video"),
  screenTransition: required<HTMLDivElement>("screen-transition"),
  empty: required<HTMLDivElement>("empty-state"),
  emptyTitle: required<HTMLElement>("empty-title"),
  emptyMessage: required<HTMLElement>("empty-message"),
  loading: required<HTMLDivElement>("loading-state"),
  statusDot: required<HTMLSpanElement>("status-dot"),
  statusTitle: required<HTMLElement>("status-title"),
  statusMessage: required<HTMLElement>("status-message"),
  deviceResolution: required<HTMLElement>("metric-device-resolution"),
  videoResolution: required<HTMLElement>("metric-video-resolution"),
  fps: required<HTMLElement>("metric-fps"),
  bitrate: required<HTMLElement>("metric-bitrate"),
  decoder: required<HTMLElement>("metric-decoder"),
  videoPackets: required<HTMLElement>("metric-video-packets"),
  h264: required<HTMLElement>("metric-h264"),
  paste: required<HTMLButtonElement>("paste-button"),
  rotate: required<HTMLButtonElement>("rotate-button"),
  ocr: required<HTMLButtonElement>("ocr-button"),
  screenshot: required<HTMLButtonElement>("screenshot-button"),
  copyScreenshot: required<HTMLButtonElement>("copy-screenshot-button"),
  record: required<HTMLButtonElement>("record-button"),
  screenPower: required<HTMLButtonElement>("screen-power-button"),
  ocrOverlay: required<HTMLDivElement>("ocr-overlay"),
  ocrToolbar: document.querySelector<HTMLElement>(".ocr-toolbar")!,
  ocrSurface: required<HTMLDivElement>("ocr-surface"),
  ocrSnapshot: required<HTMLImageElement>("ocr-snapshot"),
  ocrTextLayer: required<HTMLDivElement>("ocr-text-layer"),
  ocrProgress: required<HTMLDivElement>("ocr-progress"),
  ocrProgressStatus: required<HTMLElement>("ocr-progress-status"),
  ocrProgressBar: required<HTMLElement>("ocr-progress-bar"),
  ocrSummary: required<HTMLElement>("ocr-summary"),
  ocrCopySelected: required<HTMLButtonElement>("ocr-copy-selected"),
  ocrCopyAll: required<HTMLButtonElement>("ocr-copy-all"),
  ocrRetry: required<HTMLButtonElement>("ocr-retry"),
  ocrExit: required<HTMLButtonElement>("ocr-exit"),
  chips: required<HTMLDivElement>("diagnostic-chips"),
  footer: required<HTMLElement>("footer-state"),
  apkDropHint: required<HTMLDivElement>("apk-drop-hint"),
  apkInstallStatus: required<HTMLDivElement>("apk-install-status"),
  apkInstallFile: required<HTMLElement>("apk-install-file"),
  apkInstallTarget: required<HTMLElement>("apk-install-target"),
  toast: required<HTMLDivElement>("toast")
};

let devices: DeviceInfo[] = [];
let connected = false;
let screenPowerOff = false;
let screenPowerBusy = false;
let sessionActive = false;
let connecting = false;
let switching = false;
let controlScreen: Dimensions | null = null;
let videoFrame: Dimensions | null = null;
let videoFrameIsPlaceholder = false;
let activeVideoScale = VIDEO_PROFILES.balanced.scale;
let pointerDown = false;
let pendingMove: PointerEvent | null = null;
let moveFrame = 0;
let activePointerPoint: { x: number; y: number } | null = null;
let wheelStopTimer = 0;
let lastWheelPoint: { x: number; y: number } | null = null;
let rotateHorizontal = false;
let toastTimer = 0;
let activeVideoPort: MessagePort | null = null;
let disposeVideoPort: (() => void) | null = null;
let ocrActive = false;
let ocrBusy = false;
let ocrNeedsCancel = false;
let ocrSnapshotId: string | null = null;
let ocrResult: OcrResult | null = null;
let ocrImageUrl: string | null = null;
let ocrRun = 0;
let ocrSymbols: SelectableOcrSymbol[] = [];
let ocrSymbolElements: HTMLElement[] = [];
let ocrSelectionAnchor: number | null = null;
let ocrSelectionFocus: number | null = null;
let paintedOcrSelection: OcrSelectionRange | null = null;
let ocrSelecting = false;

const pipeline = new VideoPipeline(
  elements.canvas,
  elements.fallbackVideo,
  elements.standbyVideo,
  (width, height, source) => {
    videoFrame = { width, height };
    videoFrameIsPlaceholder = source === "placeholder";
    if (!videoFrameIsPlaceholder) window.hmRemote.reportMirrorSize({ width, height });
    controlScreen = alignControlDimensionsToFrame(
      controlScreen,
      videoFrame,
      videoFrameIsPlaceholder ? 1 : activeVideoScale
    );
    elements.videoResolution.textContent = `${width} × ${height}`;
    if (controlScreen) {
      elements.deviceResolution.textContent = `${controlScreen.width} × ${controlScreen.height}`;
    }
    syncVideoSurface();
    elements.empty.hidden = true;
  },
  (name) => {
    elements.decoder.textContent = name;
    if (name !== "MediaSource") {
      showToast("当前系统没有可用的 H.264 解码器");
    }
  },
  () => window.hmRemote.requestIdr(),
  (diagnostics) => window.hmRemote.reportVideoDiagnostics(diagnostics),
  () => window.hmRemote.captureScreenPlaceholder(elements.device.value),
  () => !document.hidden && !ocrActive
);
let screenshotBusy = false;
let screenshotTarget: "clipboard" | "file" | null = null;
const recorder = new ScreenRecorder(window.hmRemote, () => pipeline.getRenderTarget(),
  () => connected && !ocrActive && !switching,
  () => updateCaptureButtons(), showToast);
const keyboard = new KeyboardInput(elements.keyboardInput,
  () => connected && !ocrActive && !switching,
  (command) => window.hmRemote.control(command),
  () => window.hmRemote.pasteClipboard(), showToast);
const apkInstaller = new ApkDropInstaller({
  surface: window,
  target: () => devices.find((device) => deviceKey(device) === elements.device.value),
  isConnecting: () => connecting,
  install: (key, file) => window.hmRemote.installApk(key, file),
  beforeInstall: () => { releaseScreenControls(); keyboard.suspend(); },
  changed: (state) => {
    elements.apkDropHint.hidden = !state.dragging || state.busy;
    const target = devices.find((device) => deviceKey(device) === elements.device.value);
    const ready = target?.backend === "adb" && target.state === "ready" && target.transport === "USB";
    elements.apkDropHint.querySelector("strong")!.textContent = connecting ? "请等待设备连接完成"
      : ready ? "松开以安装 APK" : "请先选择 Android 设备";
    elements.apkDropHint.querySelector("span")!.textContent = ready
      ? `目标：${target.label}。一次拖入一个 APK，覆盖安装并保留已有应用数据。`
      : "连接并选择一台已授权的 Android / ADB USB 设备后，即可拖入单个 APK 安装。";
    elements.apkInstallStatus.hidden = !state.busy;
    elements.apkInstallFile.textContent = state.fileName;
    elements.apkInstallTarget.textContent = state.targetLabel;
    updateConnectionButtons();
  },
  notify: showToast
});
const deviceConnection = new CompactConnection({
  listDevices: () => window.hmRemote.listDevices(),
  isBusy: () => connecting || sessionActive || apkInstaller.busy,
  devicesChanged: renderDevices,
  connect: async (device) => { elements.device.value = deviceKey(device); await toggleConnection(); },
  scanningChanged: updateConnectionButtons,
  failed: (error, phase) => {
    if (phase === "discovery") {
      devices = [];
      elements.device.replaceChildren(new Option("设备读取失败", ""));
      elements.emptyTitle.textContent = "无法读取设备";
      elements.emptyMessage.textContent = errorMessage(error);
    } else showToast(errorMessage(error));
  }
});
new WindowControls(() => {
  releaseScreenControls();
  keyboard.suspend();
  requestAnimationFrame(() => { syncVideoSurface(); syncOcrSurface(); });
  if (!sessionActive && !connecting && !apkInstaller.busy) renderDevices(devices);
  deviceConnection.setEnabled(isCompactMode());
}, showToast);
window.hmRemote.onStopRecording(() => void recorder.stop());
void pipeline.initialize();

window.hmRemote.onVideoRecovery((request) => {
  releaseScreenControls();
  keyboard.suspend();
  pipeline.prepareRecovery(request);
  window.hmRemote.videoRecoveryReady(request.sessionId);
});
window.hmRemote.onStatus(updateStatus);
window.hmRemote.onOcrProgress(updateOcrProgress);
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data !== VIDEO_PORT_WINDOW_MESSAGE) {
    return;
  }
  const port = event.ports[0];
  if (!port) {
    return;
  }
  pipeline.setPortReady(false);
  disposeVideoPort?.();
  activeVideoPort = port;
  disposeVideoPort = bindVideoPort(port, {
    onPacket: (packet) => pipeline.feed(packet),
    onReady: () => pipeline.setPortReady(true),
    onError: () => {
      if (activeVideoPort !== port) {
        return;
      }
      pipeline.setPortReady(false);
      disposeVideoPort?.();
      disposeVideoPort = null;
      activeVideoPort = null;
      window.hmRemote.requestVideoPort();
    }
  });
});
window.hmRemote.requestVideoPort();

elements.refresh.addEventListener("click", () => void refreshDevices());
elements.configureAndroid.addEventListener("click", async () => {
  elements.configureAndroid.disabled = true;
  try {
    if (await window.hmRemote.configureAndroid()) {
      await Promise.all([refreshDevices(), loadDiagnostics()]);
      showToast("Android 投屏工具已配置");
    }
  } catch (error) { showToast(errorMessage(error)); }
  finally { updateConnectionButtons(); }
});
elements.connect.addEventListener("click", () => void toggleConnection());
elements.device.addEventListener("change", updateConnectionButtons);
elements.compactConnect.addEventListener("click", () => {
  if (!sessionActive && !devices.some((device) => deviceKey(device) === elements.device.value && device.state === "ready")) {
    void refreshDevices();
  } else void toggleConnection();
});
window.addEventListener("beforeunload", () => { deviceConnection.dispose(); apkInstaller.dispose(); });
elements.paste.addEventListener("click", () => void pasteClipboard());
elements.rotate.addEventListener("click", () => void rotate());
elements.screenPower.addEventListener("click", () => void toggleScreenPower());
elements.ocr.addEventListener("click", () => void startOcr());
elements.screenshot.addEventListener("click", () => void takeScreenshot("file"));
elements.copyScreenshot.addEventListener("click", () => void takeScreenshot("clipboard"));
elements.record.addEventListener("click", async () => {
  if (recorder.busy) return;
  try { if (recorder.recording) await recorder.stop(); else await recorder.start(); }
  catch (error) { showToast(errorMessage(error)); }
});
elements.ocrCopySelected.addEventListener("click", () => void copySelectedOcrText());
elements.ocrCopyAll.addEventListener("click", () => void copyAllOcrText());
elements.ocrRetry.addEventListener("click", () => void retryOcr());
elements.ocrExit.addEventListener("click", () => void exitOcr());
elements.ocrSnapshot.addEventListener("load", syncOcrSurface);
elements.ocrTextLayer.addEventListener("pointerdown", beginOcrSelection);
elements.ocrTextLayer.addEventListener("pointermove", moveOcrSelection);
elements.ocrTextLayer.addEventListener("pointerup", endOcrSelection);
elements.ocrTextLayer.addEventListener("pointercancel", cancelOcrSelection);
new ResizeObserver(() => {
  syncVideoSurface();
  syncOcrSurface();
}).observe(elements.screenShell);
new ResizeObserver(syncOcrSurface).observe(elements.ocrToolbar);

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-key]")) {
  button.addEventListener("click", () => {
    const key = button.dataset.key as Extract<ControlCommand, { kind: "key" }>["key"];
    void sendControl({ kind: "key", key });
  });
}

const endPointer = (event: PointerEvent) => {
  if (!pointerDown) {
    return;
  }
  pointerDown = false;
  const point = pointFromEvent(event) ?? activePointerPoint;
  activePointerPoint = null;
  if (point) {
    void sendControl({ kind: "touch", phase: "up", ...point });
  }
};

for (const screenTarget of [elements.canvas, elements.fallbackVideo, elements.standbyVideo]) {
  screenTarget.addEventListener("pointerdown", (rawEvent) => {
    const event = rawEvent as PointerEvent;
    if (!canControlScreen() || event.button !== 0) {
      return;
    }
    const point = pointFromEvent(event);
    if (!point) {
      return;
    }
    event.preventDefault();
    pointerDown = true;
    activePointerPoint = point;
    screenTarget.setPointerCapture(event.pointerId);
    keyboard.focus(event.clientX, event.clientY, elements.screenShell.getBoundingClientRect());
    void sendControl({ kind: "touch", phase: "down", ...point });
  });

  screenTarget.addEventListener("pointermove", (rawEvent) => {
    const event = rawEvent as PointerEvent;
    if (!pointerDown) {
      return;
    }
    pendingMove = event;
    if (!moveFrame) {
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0;
        const move = pendingMove;
        pendingMove = null;
        const point = move ? pointFromEvent(move) : null;
        if (point) {
          activePointerPoint = point;
          void sendControl({ kind: "touch", phase: "move", ...point });
        }
      });
    }
  });

  screenTarget.addEventListener("pointerup", (event) => endPointer(event as PointerEvent));
  screenTarget.addEventListener("pointercancel", (event) => endPointer(event as PointerEvent));
  screenTarget.addEventListener("contextmenu", (rawEvent) => {
    const event = rawEvent as MouseEvent;
    event.preventDefault();
    if (canControlScreen()) {
      void sendControl({ kind: "key", key: "Back" });
    }
  });
  screenTarget.addEventListener(
    "wheel",
    (rawEvent) => {
      const event = rawEvent as WheelEvent;
      event.preventDefault();
      if (!canControlScreen()) {
        return;
      }
      const point = pointFromEvent(event);
      if (!point) {
        return;
      }
      const direction = event.deltaY < 0 ? "up" : "down";
      lastWheelPoint = point;
      void sendControl({ kind: "wheel", direction, ...point });
      if (wheelStopTimer) {
        window.clearTimeout(wheelStopTimer);
      }
      wheelStopTimer = window.setTimeout(() => {
        wheelStopTimer = 0;
        void sendControl({ kind: "wheel", direction: "stop", ...point });
      }, 80);
    },
    { passive: false }
  );
}

window.addEventListener("keydown", (event) => {
  if (ocrActive) {
    if (event.key === "Escape") {
      event.preventDefault();
      void exitOcr();
    } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "c" && selectedOcrText()) {
      event.preventDefault();
      void copySelectedOcrText();
    }
    return;
  }
  if (event.isComposing || event.keyCode === 229 || !connected || switching
    || (isFormElement(event.target) && !keyboard.isTarget(event.target))) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    void sendControl({ kind: "key", key: "Back" });
  } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "h") {
    event.preventDefault();
    void sendControl({ kind: "key", key: "Home" });
  } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "r") {
    event.preventDefault();
    void rotate();
  } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "v") {
    event.preventDefault();
    void pasteClipboard();
  }
});

void initialize();

async function initialize(): Promise<void> {
  setControlsEnabled(false);
  await Promise.all([refreshDevices(), loadDiagnostics()]);
}

async function loadDiagnostics(): Promise<void> {
  try {
    const diagnostics = await window.hmRemote.getDiagnostics();
    elements.chips.replaceChildren(
      chip(diagnostics.hdcCompatible && diagnostics.sdkAvailable && diagnostics.javaPath ? "鸿蒙通道已就绪" : "鸿蒙通道未就绪", !diagnostics.hdcCompatible),
      chip(diagnostics.adbPath ? "ADB 已就绪" : "未找到 ADB", !diagnostics.adbPath),
      chip(diagnostics.scrcpyVersion ? `scrcpy ${diagnostics.scrcpyVersion}` : "请配置 Android 工具", !diagnostics.scrcpyVersion)
    );
    if (!diagnostics.hdcCompatible && diagnostics.hdcVersion && !diagnostics.scrcpyVersion) {
      elements.emptyMessage.textContent =
        "当前 HDC 版本低于 3.2，中文输入或新系统连接可能失败，请放入新版 HDC。";
    }
  } catch (error) {
    showToast(errorMessage(error));
  }
}

function isCompactMode(): boolean {
  return document.querySelector<HTMLElement>("#app")!.dataset.windowMode === "compact";
}

function refreshDevices(): Promise<void> { return deviceConnection.refresh(); }

function renderDevices(found: DeviceInfo[]): void {
  devices = found;
  const previous = elements.device.value;
  elements.device.replaceChildren();
  if (devices.length === 0) {
    elements.device.add(new Option("未发现设备", ""));
    elements.emptyTitle.textContent = "没有发现可用设备";
    elements.emptyMessage.textContent = isCompactMode()
      ? "连接 USB 数据线并确认调试授权后，将自动开始投屏。"
      : "请检查数据线、USB 调试和手机上的授权弹窗。";
  } else {
    for (const device of devices) {
      const option = new Option(device.label, deviceKey(device));
      option.disabled = device.state !== "ready";
      elements.device.add(option);
    }
    const readyDevices = devices.filter((device) => device.state === "ready");
    const ready = readyDevices.find((device) => deviceKey(device) === previous) ?? readyDevices[0];
    elements.device.value = ready ? deviceKey(ready) : "";
    elements.emptyTitle.textContent = readyDevices.length > 1 ? "发现多台设备" : ready ? "设备已就绪" : "设备尚未授权";
    elements.emptyMessage.textContent = ready
      ? readyDevices.length > 1 ? "请选择设备，然后点击“开始投屏”。" : "点击“开始投屏”显示手机当前画面。"
      : "请在手机上确认 USB 调试授权，授权完成后会自动检测。";
  }
  updateConnectionButtons();
}

function updateConnectionButtons(): void {
  const selected = devices.some((device) => deviceKey(device) === elements.device.value && device.state === "ready");
  const installing = apkInstaller.busy;
  elements.device.disabled = sessionActive || connecting || installing;
  elements.profile.disabled = sessionActive || connecting || installing;
  elements.configureAndroid.disabled = sessionActive || connecting || installing;
  elements.refresh.disabled = sessionActive || connecting || installing || deviceConnection.scanning;
  elements.connect.disabled = connecting || installing || (!sessionActive && (!selected || deviceConnection.scanning));
  elements.compactConnect.disabled = connecting || installing || (!sessionActive && deviceConnection.scanning);
  const detecting = !sessionActive && !connecting && deviceConnection.scanning;
  elements.refresh.textContent = deviceConnection.scanning ? "…" : "↻";
  elements.compactConnect.title = detecting ? "正在检测设备…" : connecting ? "正在连接设备…" : sessionActive ? "断开手机投屏（录屏会自动保存）" : selected ? "开始投屏" : "检测设备并开始投屏";
  elements.compactConnect.querySelector("span")!.textContent = sessionActive ? "⏏" : "▶";
  elements.compactConnect.querySelector("small")!.textContent = detecting ? "检测中" : connecting ? "连接中" : sessionActive ? "断开" : "连接";
  elements.compactConnection.setAttribute("aria-busy", String(deviceConnection.scanning));
  updateScreenPowerButton();
}

async function toggleConnection(): Promise<void> {
  if (connecting || apkInstaller.busy) {
    return;
  }
  if (sessionActive) {
    deviceConnection.suppressAutomatic();
    connecting = true;
    updateConnectionButtons();
    try {
      await recorder.stop();
      await window.hmRemote.stop();
      pipeline.reset();
      resetDimensionState();
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      connecting = false;
      updateConnectionButtons();
    }
    return;
  }
  const device = devices.find((item) => deviceKey(item) === elements.device.value);
  if (!device || device.state !== "ready") {
    showToast("请先选择一台状态为“已就绪”的设备");
    return;
  }
  deviceConnection.markAttempt(deviceKey(device));
  connecting = true;
  updateConnectionButtons();
  elements.loading.hidden = false;
  elements.empty.hidden = true;
  elements.connect.disabled = true;
  try {
    const profileId = elements.profile.value as VideoProfile["id"];
    activeVideoScale = device.backend === "adb" ? 1 : VIDEO_PROFILES[profileId].scale;
    resetDimensionState();
    pipeline.reset();
    await pipeline.initialize();
    pipeline.beginSession();
    await window.hmRemote.start({
      serial: device.serial,
      backend: device.backend ?? "hdc",
      profileId
    });
  } catch (error) {
    pipeline.reset();
    elements.loading.hidden = true;
    elements.empty.hidden = false;
    elements.emptyTitle.textContent = "连接失败";
    elements.emptyMessage.textContent = errorMessage(error);
    showToast(errorMessage(error));
  } finally {
    connecting = false;
    updateConnectionButtons();
  }
}

function updateStatus(status: MirrorStatus): void {
  const wasSwitching = switching;
  screenPowerOff = status.screenPowerOff === true;
  if (status.state === "idle" || status.state === "error" || status.state === "stopping") void recorder.stop();
  if (status.state === "reconnecting") { releaseScreenControls(); keyboard.suspend(); }
  connected = status.state === "streaming";
  switching = status.video?.stage === "switching";
  sessionActive =
    status.state === "connecting"
    || status.state === "waiting-video"
    || status.state === "streaming"
    || status.state === "reconnecting"
    || status.state === "stopping";
  const working =
    status.state === "connecting"
    || status.state === "waiting-video"
    || status.state === "reconnecting"
    || status.state === "stopping";
  elements.statusDot.className = `status-dot ${connected ? "online" : working ? "working" : status.state === "error" ? "error" : ""}`;
  elements.statusTitle.textContent = stateTitle(status.state);
  elements.statusMessage.textContent = status.message;
  elements.footer.textContent = status.message;
  elements.loading.hidden =
    status.state !== "connecting"
    && status.state !== "waiting-video"
    && status.state !== "reconnecting";
  elements.connect.textContent =
    status.state === "stopping" ? "正在停止…" : sessionActive ? "停止投屏" : "开始投屏";
  elements.connect.classList.toggle("disconnect", sessionActive);
  elements.device.disabled = sessionActive;
  elements.configureAndroid.disabled = sessionActive;
  elements.refresh.disabled = sessionActive;
  elements.profile.disabled = sessionActive;
  setControlsEnabled(connected && !ocrActive && !switching);
  updateConnectionButtons();
  elements.screenTransition.hidden = !switching;
  if (switching && !wasSwitching) {
    releaseScreenControls();
  }
  if (status.screen?.width && status.screen.height) {
    controlScreen = alignControlDimensionsToFrame(
      { width: status.screen.width, height: status.screen.height },
      videoFrame,
      videoFrameIsPlaceholder ? 1 : activeVideoScale
    );
    elements.deviceResolution.textContent = controlScreen
      ? `${controlScreen.width} × ${controlScreen.height}`
      : `${status.screen.width} × ${status.screen.height}`;
  }
  elements.fps.textContent = status.fps ? `${status.fps} fps` : "—";
  elements.bitrate.textContent = status.bitrate ? formatBitrate(status.bitrate) : "—";
  elements.videoPackets.textContent = status.video
    ? `${status.video.packets} 包 / ${formatBytes(status.video.bytes)}`
    : "—";
  elements.h264.textContent = status.video ? formatVideoDiagnostics(status.video) : "—";
  if (connected) {
    elements.empty.hidden = true;
  } else if (status.state === "idle") {
    if (ocrActive) {
      void exitOcr();
    }
    elements.empty.hidden = false;
    resetDimensionState();
  } else if (status.state === "error") {
    if (status.videoSessionId !== undefined) pipeline.endVideoSession();
    if (ocrActive) {
      void exitOcr();
    }
    elements.empty.hidden = false;
    resetDimensionState();
    elements.emptyTitle.textContent = "投屏发生错误";
    elements.emptyMessage.textContent = status.message;
  }
}

function canControlScreen(): boolean {
  return connected && !ocrActive && pipeline.canControl();
}

async function sendControl(command: ControlCommand): Promise<void> {
  if (!connected) {
    return;
  }
  const releaseCommand =
    (command.kind === "touch" && command.phase === "up")
    || (command.kind === "wheel" && command.direction === "stop");
  if (
    (command.kind === "touch" || command.kind === "wheel")
    && !releaseCommand
    && !pipeline.canControl()
  ) {
    return;
  }
  try {
    if ((command.kind === "touch" || command.kind === "wheel") && controlScreen) {
      command = { ...command, screenWidth: controlScreen.width, screenHeight: controlScreen.height };
    }
    await window.hmRemote.control(command);
  } catch (error) {
    showToast(errorMessage(error));
  }
}

function updateScreenPowerButton(): void {
  const android = devices.some((device) => deviceKey(device) === elements.device.value && device.backend === "adb");
  elements.screenPower.disabled = !android || !connected || ocrActive || switching || screenPowerBusy;
  elements.screenPower.querySelector("small")!.textContent = screenPowerBusy ? "处理中" : screenPowerOff ? "亮屏" : "灭屏";
  elements.screenPower.querySelector("span")!.textContent = screenPowerBusy ? "…" : screenPowerOff ? "☼" : "☾";
  elements.screenPower.title = !android ? "灭屏投屏仅支持 Android/ADB 设备"
    : screenPowerOff ? "点亮手机物理屏幕，电脑投屏继续" : "关闭手机物理屏幕，电脑继续投屏和控制";
  elements.screenPower.setAttribute("aria-label", elements.screenPower.title);
  elements.screenPower.setAttribute("aria-pressed", String(screenPowerOff));
}

async function toggleScreenPower(): Promise<void> {
  if (elements.screenPower.disabled || screenPowerBusy) return;
  const on = screenPowerOff;
  screenPowerBusy = true;
  updateScreenPowerButton();
  try {
    await window.hmRemote.control({kind:"screen-power",on});
    showToast(on ? "已请求点亮手机屏幕" : "已请求关闭手机屏幕，电脑投屏和控制继续");
  } catch (error) { showToast(errorMessage(error)); }
  finally { screenPowerBusy = false; updateScreenPowerButton(); }
}

async function rotate(): Promise<void> {
  rotateHorizontal = !rotateHorizontal;
  await sendControl({
    kind: "rotate",
    orientation: rotateHorizontal ? "horizontal" : "vertical"
  });
}

async function pasteClipboard(): Promise<void> {
  if (!connected) {
    showToast("请先开始投屏");
    return;
  }
  try {
    await keyboard.paste();
    showToast("已发送电脑剪贴板文本");
  } catch (error) {
    showToast(errorMessage(error));
  }
}

async function startOcr(): Promise<void> {
  if (!connected || ocrBusy) {
    if (!connected) {
      showToast("请先开始投屏");
    }
    return;
  }
  if (ocrActive) {
    await exitOcr();
  }
  const run = ++ocrRun;
  ocrActive = true;
  ocrBusy = true;
  ocrNeedsCancel = false;
  ocrResult = null;
  ocrSnapshotId = null;
  elements.ocrOverlay.hidden = false;
  resetOcrSymbols();
  elements.ocrProgress.hidden = false;
  elements.ocrProgressStatus.textContent = "正在截取手机画面…";
  elements.ocrProgressBar.style.width = "3%";
  elements.ocrSummary.textContent = "优先获取手机原始分辨率截图";
  elements.ocrCopyAll.disabled = true;
  elements.ocrCopySelected.disabled = true;
  elements.ocrRetry.disabled = true;
  setControlsEnabled(false);

  try {
    const fallback = await pipeline.captureFrame();
    const snapshot = fallback
      ? await window.hmRemote.captureOcrSnapshot(elements.device.value, fallback)
      : await window.hmRemote.captureOcrSnapshot(elements.device.value);
    if (!ocrActive || run !== ocrRun) {
      await window.hmRemote.cancelOcr(snapshot.id);
      return;
    }
    ocrSnapshotId = snapshot.id;
    ocrNeedsCancel = true;
    showOcrSnapshot(snapshot);
    if (snapshot.warning) {
      showToast(snapshot.warning);
    }
    elements.ocrSummary.textContent = snapshot.source === "device"
      ? `高清截图 ${snapshot.width} × ${snapshot.height}`
      : `当前投屏帧 ${snapshot.width} × ${snapshot.height}`;
    const result = await window.hmRemote.recognizeOcr(snapshot.id);
    if (!ocrActive || run !== ocrRun) {
      return;
    }
    ocrNeedsCancel = false;
    ocrResult = result;
    renderOcrLines(result.lines, snapshot);
    elements.ocrProgress.hidden = true;
    elements.ocrSummary.textContent = result.lines.length > 0
      ? `识别到 ${result.lines.length} 行文字 · ${(result.durationMs / 1000).toFixed(1)} 秒`
      : "没有识别到可复制文字，可点击“重新识别”";
    elements.ocrCopyAll.disabled = result.text.length === 0;
  } catch (error) {
    if (!ocrActive || run !== ocrRun) {
      return;
    }
    elements.ocrProgress.hidden = false;
    elements.ocrProgressStatus.textContent = errorMessage(error);
    elements.ocrProgressBar.style.width = "100%";
    elements.ocrSummary.textContent = "识别失败，可重试或退出";
    showToast(errorMessage(error));
  } finally {
    if (ocrActive && run === ocrRun) {
      ocrBusy = false;
      elements.ocrRetry.disabled = false;
    }
  }
}

async function retryOcr(): Promise<void> {
  if (ocrBusy) {
    return;
  }
  await exitOcr();
  await startOcr();
}

async function exitOcr(): Promise<void> {
  if (!ocrActive) {
    return;
  }
  const snapshotId = ocrSnapshotId;
  const shouldCancel = ocrNeedsCancel;
  ocrRun++;
  ocrActive = false;
  ocrBusy = false;
  ocrNeedsCancel = false;
  ocrSnapshotId = null;
  ocrResult = null;
  elements.ocrOverlay.hidden = true;
  resetOcrSymbols();
  if (ocrImageUrl) {
    URL.revokeObjectURL(ocrImageUrl);
    ocrImageUrl = null;
  }
  elements.ocrSnapshot.removeAttribute("src");
  setControlsEnabled(connected && !switching);
  if (shouldCancel) {
    try {
      await window.hmRemote.cancelOcr(snapshotId ?? undefined);
    } catch {
      // 退出界面不应被后台 OCR 清理失败阻塞。
    }
  }
}

function showOcrSnapshot(snapshot: OcrSnapshot): void {
  if (ocrImageUrl) {
    URL.revokeObjectURL(ocrImageUrl);
  }
  ocrImageUrl = URL.createObjectURL(new Blob([snapshot.image], { type: snapshot.mimeType }));
  elements.ocrSnapshot.src = ocrImageUrl;
  elements.ocrSurface.dataset.width = String(snapshot.width);
  elements.ocrSurface.dataset.height = String(snapshot.height);
  syncOcrSurface();
}

function renderOcrLines(lines: OcrLine[], snapshot: OcrSnapshot): void {
  clearOcrSelection();
  ocrSymbols = flattenOcrSymbols(lines);
  ocrSymbolElements = [];
  const fragments = document.createDocumentFragment();
  for (const symbol of ocrSymbols) {
    const element = document.createElement("span");
    element.className = "ocr-symbol";
    element.style.left = `${symbol.box.x / snapshot.width * 100}%`;
    element.style.top = `${symbol.box.y / snapshot.height * 100}%`;
    element.style.width = `${symbol.box.width / snapshot.width * 100}%`;
    element.style.height = `${symbol.box.height / snapshot.height * 100}%`;
    element.dataset.index = String(symbol.index);
    element.title = symbol.text;
    element.setAttribute("aria-hidden", "true");
    ocrSymbolElements.push(element);
    fragments.append(element);
  }
  elements.ocrTextLayer.replaceChildren(fragments);
  updateOcrSelectionState();
}

function syncOcrSurface(): void {
  const width = Number(elements.ocrSurface.dataset.width);
  const height = Number(elements.ocrSurface.dataset.height);
  if (!ocrActive || width <= 0 || height <= 0) {
    return;
  }
  const availableWidth = Math.max(1, elements.screenShell.clientWidth - 24);
  const toolbarHeight = elements.ocrToolbar.getBoundingClientRect().height;
  const bottomPadding = toolbarHeight + 36;
  elements.ocrOverlay.style.paddingBottom = `${bottomPadding}px`;
  const availableHeight = Math.max(1, elements.screenShell.clientHeight - bottomPadding - 12);
  const scale = Math.min(availableWidth / width, availableHeight / height);
  elements.ocrSurface.style.width = `${Math.round(width * scale)}px`;
  elements.ocrSurface.style.height = `${Math.round(height * scale)}px`;
}

function updateOcrProgress(progress: OcrProgress): void {
  if (!ocrActive || progress.snapshotId !== ocrSnapshotId) {
    return;
  }
  elements.ocrProgressStatus.textContent = `${progress.status} ${Math.round(progress.progress * 100)}%`;
  elements.ocrProgressBar.style.width = `${Math.max(3, progress.progress * 100)}%`;
}

function updateOcrSelectionState(): void {
  elements.ocrCopySelected.disabled = !ocrResult || !selectedOcrText();
}

function beginOcrSelection(event: PointerEvent): void {
  if (!ocrResult || event.button !== 0) {
    return;
  }
  const index = ocrSymbolIndexFromPointer(event, 12);
  if (index === null) {
    clearOcrSelection();
    return;
  }
  event.preventDefault();
  ocrSelecting = true;
  ocrSelectionAnchor = index;
  ocrSelectionFocus = index;
  paintOcrSelection();
  try {
    elements.ocrTextLayer.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is only an optimization; selection still works without it.
  }
}

function moveOcrSelection(event: PointerEvent): void {
  if (!ocrSelecting) {
    return;
  }
  event.preventDefault();
  const index = ocrSymbolIndexFromPointer(event);
  if (index !== null && index !== ocrSelectionFocus) {
    ocrSelectionFocus = index;
    paintOcrSelection();
  }
}

function endOcrSelection(event: PointerEvent): void {
  if (!ocrSelecting) {
    return;
  }
  moveOcrSelection(event);
  ocrSelecting = false;
  try {
    elements.ocrTextLayer.releasePointerCapture(event.pointerId);
  } catch {
    // The pointer may already have been released by the browser.
  }
}

function cancelOcrSelection(event: PointerEvent): void {
  if (!ocrSelecting) {
    return;
  }
  ocrSelecting = false;
  try {
    elements.ocrTextLayer.releasePointerCapture(event.pointerId);
  } catch {
    // The pointer may already have been released by the browser.
  }
}

function ocrSymbolIndexFromPointer(event: PointerEvent, maximumClientDistance?: number): number | null {
  const sourceWidth = Number(elements.ocrSurface.dataset.width);
  const sourceHeight = Number(elements.ocrSurface.dataset.height);
  const bounds = elements.ocrSurface.getBoundingClientRect();
  if (
    sourceWidth <= 0
    || sourceHeight <= 0
    || bounds.width <= 0
    || bounds.height <= 0
    || event.clientX < bounds.left
    || event.clientX > bounds.right
    || event.clientY < bounds.top
    || event.clientY > bounds.bottom
  ) {
    return null;
  }
  const point = {
    x: (event.clientX - bounds.left) / bounds.width * sourceWidth,
    y: (event.clientY - bounds.top) / bounds.height * sourceHeight
  };
  const maximumSourceDistance = maximumClientDistance === undefined
    ? Number.POSITIVE_INFINITY
    : maximumClientDistance * Math.max(sourceWidth / bounds.width, sourceHeight / bounds.height);
  return nearestOcrSymbolIndex(ocrSymbols, point, maximumSourceDistance);
}

function paintOcrSelection(): void {
  const next = normalizeOcrSelection(ocrSelectionAnchor, ocrSelectionFocus, ocrSymbols.length);
  if (paintedOcrSelection) {
    for (let index = paintedOcrSelection.start; index <= paintedOcrSelection.end; index++) {
      if (!next || index < next.start || index > next.end) {
        ocrSymbolElements[index]?.classList.remove("selected");
      }
    }
  }
  if (next) {
    for (let index = next.start; index <= next.end; index++) {
      if (!paintedOcrSelection || index < paintedOcrSelection.start || index > paintedOcrSelection.end) {
        ocrSymbolElements[index]?.classList.add("selected");
      }
    }
  }
  paintedOcrSelection = next;
  updateOcrSelectionState();
}

function clearOcrSelection(): void {
  if (paintedOcrSelection) {
    for (let index = paintedOcrSelection.start; index <= paintedOcrSelection.end; index++) {
      ocrSymbolElements[index]?.classList.remove("selected");
    }
  }
  ocrSelectionAnchor = null;
  ocrSelectionFocus = null;
  paintedOcrSelection = null;
  ocrSelecting = false;
  updateOcrSelectionState();
}

function resetOcrSymbols(): void {
  clearOcrSelection();
  ocrSymbols = [];
  ocrSymbolElements = [];
  elements.ocrTextLayer.replaceChildren();
}

async function copySelectedOcrText(): Promise<void> {
  const text = selectedOcrText();
  if (!text) {
    showToast("请先在画面上拖动选择文字");
    return;
  }
  await copyOcrText(text, "已复制选中文字");
}

async function copyAllOcrText(): Promise<void> {
  if (!ocrResult?.text) {
    return;
  }
  await copyOcrText(ocrResult.text, "已复制全部识别文字");
}

async function copyOcrText(text: string, message: string): Promise<void> {
  try {
    await window.hmRemote.copyText(text);
    showToast(message);
  } catch (error) {
    showToast(errorMessage(error));
  }
}

function selectedOcrText(): string {
  return buildSelectedOcrText(ocrSymbols, ocrSelectionAnchor, ocrSelectionFocus);
}

function pointFromEvent(event: MouseEvent): { x: number; y: number } | null {
  const dimensions = resolveControlDimensions(controlScreen, videoFrame, activeVideoScale);
  if (!dimensions) {
    return null;
  }
  const target = pipeline.getRenderTarget();
  if (!target) {
    return null;
  }
  return mapClientPoint(event.clientX, event.clientY, target.getBoundingClientRect(), dimensions);
}

function syncVideoSurface(): void {
  const fitted = fitDimensions(videoFrame, {
    width: elements.screenShell.clientWidth,
    height: elements.screenShell.clientHeight
  });
  if (!fitted) {
    clearVideoSurfaceSize();
    return;
  }
  for (const target of [elements.canvas, ...pipeline.getVideoTargets()]) {
    target.style.width = `${fitted.width}px`;
    target.style.height = `${fitted.height}px`;
  }
}

function resetDimensionState(): void {
  controlScreen = null;
  videoFrame = null;
  videoFrameIsPlaceholder = false;
  elements.deviceResolution.textContent = "—";
  elements.videoResolution.textContent = "—";
  clearVideoSurfaceSize();
}

function clearVideoSurfaceSize(): void {
  for (const target of [elements.canvas, ...pipeline.getVideoTargets()]) {
    target.style.removeProperty("width");
    target.style.removeProperty("height");
  }
}

function setControlsEnabled(enabled: boolean): void {
  elements.keyboardInput.disabled = !enabled;
  if (!enabled) keyboard.suspend();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-phone-control]")) {
    button.disabled = !enabled;
  }
  updateCaptureButtons();
  updateScreenPowerButton();
}

async function takeScreenshot(target: "clipboard" | "file"): Promise<void> {
  if (!connected || ocrActive || switching || screenshotBusy) return;
  screenshotBusy = true;
  screenshotTarget = target;
  updateCaptureButtons();
  try {
    const fallback = await pipeline.captureFrame();
    if (target === "clipboard") {
      await window.hmRemote.copyScreenshot(elements.device.value, fallback);
      showToast("截图已复制到剪贴板，可直接粘贴");
    } else {
      const path = await window.hmRemote.saveScreenshot(elements.device.value, fallback);
      if (path) showToast(`截图已保存：${path}`);
    }
  } catch (error) { showToast(errorMessage(error)); }
  finally { screenshotBusy = false; screenshotTarget = null; updateCaptureButtons(); }
}

function updateCaptureButtons(): void {
  elements.screenshot.disabled = !connected || ocrActive || switching || screenshotBusy;
  elements.copyScreenshot.disabled = elements.screenshot.disabled;
  elements.screenshot.querySelector("small")!.textContent = screenshotTarget === "file" ? "处理中" : "保存截图";
  elements.copyScreenshot.querySelector("small")!.textContent = screenshotTarget === "clipboard" ? "处理中" : "复制截图";
  elements.record.disabled = recorder.busy || (!recorder.recording && (!connected || ocrActive || switching));
  elements.record.querySelector("small")!.textContent = recorder.busy ? "处理中" : recorder.recording ? "停录" : "录屏";
  elements.record.querySelector("span")!.textContent = recorder.busy ? "…" : recorder.recording ? "■" : "●";
  elements.record.title = recorder.busy ? "正在处理录屏，请稍候" : recorder.recording ? "停止录屏并保存" : "录制投屏画面（自动保存到系统视频目录，WebM，不录声音）";
  elements.record.setAttribute("aria-label", elements.record.title);
  elements.record.setAttribute("aria-pressed", String(recorder.recording));
}

function releaseScreenControls(): void {
  if (pointerDown && activePointerPoint) {
    pointerDown = false;
    const point = activePointerPoint;
    activePointerPoint = null;
    void sendControl({ kind: "touch", phase: "up", ...point });
  }
  if (wheelStopTimer) {
    window.clearTimeout(wheelStopTimer);
    wheelStopTimer = 0;
  }
  if (lastWheelPoint) {
    const point = lastWheelPoint;
    lastWheelPoint = null;
    void sendControl({ kind: "wheel", direction: "stop", ...point });
  }
  pendingMove = null;
  if (moveFrame) {
    cancelAnimationFrame(moveFrame);
    moveFrame = 0;
  }
}

function stateTitle(state: MirrorStatus["state"]): string {
  switch (state) {
    case "connecting":
      return "正在连接";
    case "waiting-video":
      return "正在准备画面";
    case "streaming":
      return "已连接";
    case "reconnecting":
      return "正在重连";
    case "stopping":
      return "正在停止";
    case "error":
      return "连接异常";
    default:
      return "未连接";
  }
}

function formatVideoDiagnostics(video: NonNullable<MirrorStatus["video"]>): string {
  const framing = video.framing === "annex-b" ? "Annex-B" : video.framing === "avcc" ? "AVCC" : "检测中";
  const units = [
    video.hasSps ? "SPS✓" : "SPS…",
    video.hasPps ? "PPS✓" : "PPS…",
    video.hasIdr ? "IDR✓" : "IDR…"
  ].join(" ");
  return `${framing} · ${units}`;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KiB`;
  }
  return `${value} B`;
}

function formatBitrate(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} Mbps` : `${Math.round(value / 1_000)} Kbps`;
}

function chip(text: string, warning = false): HTMLSpanElement {
  const element = document.createElement("span");
  element.textContent = text;
  element.classList.toggle("warning", warning);
  return element;
}

function showToast(message: string): void {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3_600);
}

function isFormElement(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`缺少界面元素 #${id}`);
  }
  return element as T;
}
