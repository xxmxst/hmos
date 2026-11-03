import { contextBridge, ipcRenderer } from "electron";
import type {
  ControlCommand,
  Diagnostics,
  DeviceInfo,
  HmRemoteApi,
  MirrorStatus,
  OcrFallbackFrame,
  OcrProgress,
  OcrResult,
  OcrSnapshot,
  ScreenPlaceholder,
  StartOptions,
  VideoDiagnostics,
  WindowState
} from "../shared/types";
import { VIDEO_PORT_WINDOW_MESSAGE } from "../shared/videoPort";

const windowLoaded = new Promise<void>((resolve) => {
  if (document.readyState === "complete") {
    resolve();
    return;
  }
  window.addEventListener("load", () => resolve(), { once: true });
});

ipcRenderer.on("video-port", async (event) => {
  const port = event.ports[0];
  if (!port) {
    return;
  }
  await windowLoaded;
  window.postMessage(VIDEO_PORT_WINDOW_MESSAGE, "*", [port]);
});


const api: HmRemoteApi = {
  getWindowState: () => ipcRenderer.invoke("window:get-state") as Promise<WindowState>,
  setWindowMode: (mode) => ipcRenderer.invoke("window:mode", mode) as Promise<WindowState>,
  windowAction: (action) => ipcRenderer.invoke("window:action", action) as Promise<void>,
  reportMirrorSize: (size) => ipcRenderer.send("window:video-size", size),
  onWindowState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: WindowState) => callback(state);
    ipcRenderer.on("window:state", listener);
    return () => ipcRenderer.removeListener("window:state", listener);
  },
  listDevices: () => ipcRenderer.invoke("devices:list") as Promise<DeviceInfo[]>,
  getDiagnostics: () => ipcRenderer.invoke("app:diagnostics") as Promise<Diagnostics>,
  configureAndroid: () => ipcRenderer.invoke("android:configure") as Promise<boolean>,
  copyScreenshot: (device: string, fallback?: OcrFallbackFrame) => ipcRenderer.invoke("screen:copy", device, fallback) as Promise<void>,
  saveScreenshot: (device: string, fallback?: OcrFallbackFrame) => ipcRenderer.invoke("screen:save", device, fallback) as Promise<string | null>,
  beginRecording: () => ipcRenderer.invoke("recording:begin") as Promise<{ id: string } | null>,
  appendRecording: (id: string, data: ArrayBuffer) => ipcRenderer.invoke("recording:append", id, data) as Promise<void>,
  finishRecording: (id: string) => ipcRenderer.invoke("recording:finish", id) as Promise<string | null>,
  onStopRecording: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("recording:stop-request", listener);
    return () => ipcRenderer.removeListener("recording:stop-request", listener);
  },
  start: (options: StartOptions) => ipcRenderer.invoke("mirror:start", options) as Promise<void>,
  stop: () => ipcRenderer.invoke("mirror:stop") as Promise<void>,
  control: (command: ControlCommand) =>
    ipcRenderer.invoke("mirror:control", command) as Promise<void>,
  requestIdr: () => ipcRenderer.send("mirror:request-idr"),
  requestVideoPort: () => ipcRenderer.send("video-port:request"),
  reportVideoDiagnostics: (diagnostics: VideoDiagnostics) =>
    ipcRenderer.send("video:diagnostics", diagnostics),
  pasteClipboard: () => ipcRenderer.invoke("clipboard:paste") as Promise<void>,
  captureScreenPlaceholder: (serial: string) =>
    ipcRenderer.invoke("screen:capture-placeholder", serial) as Promise<ScreenPlaceholder>,
  captureOcrSnapshot: (serial: string, fallbackFrame?: OcrFallbackFrame) =>
    ipcRenderer.invoke("ocr:capture", serial, fallbackFrame) as Promise<OcrSnapshot>,
  recognizeOcr: (snapshotId: string) =>
    ipcRenderer.invoke("ocr:recognize", snapshotId) as Promise<OcrResult>,
  cancelOcr: (snapshotId?: string) =>
    ipcRenderer.invoke("ocr:cancel", snapshotId) as Promise<void>,
  copyText: (text: string) => ipcRenderer.invoke("clipboard:write", text) as Promise<void>,
  onStatus: (callback: (status: MirrorStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: MirrorStatus) => callback(status);
    ipcRenderer.on("mirror:status", listener);
    return () => ipcRenderer.removeListener("mirror:status", listener);
  },
  onOcrProgress: (callback: (progress: OcrProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: OcrProgress) =>
      callback(progress);
    ipcRenderer.on("ocr:progress", listener);
    return () => ipcRenderer.removeListener("ocr:progress", listener);
  },
};

contextBridge.exposeInMainWorld("hmRemote", api);
