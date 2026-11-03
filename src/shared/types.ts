import type { EditingKey } from "./keyboard";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "waiting-video"
  | "streaming"
  | "reconnecting"
  | "stopping"
  | "error";

export type VideoFraming = "unknown" | "annex-b" | "avcc";

export type VideoStage =
  | "waiting-port"
  | "waiting-stream"
  | "waiting-config"
  | "waiting-keyframe"
  | "waiting-frame"
  | "decoding"
  | "switching"
  | "error";

export interface VideoDiagnostics {
  stage: VideoStage;
  packets: number;
  bytes: number;
  framing: VideoFraming;
  hasSps: boolean;
  hasPps: boolean;
  hasIdr: boolean;
  error?: string;
}

export type DeviceBackend = "hdc" | "adb";

export function deviceKey(device: Pick<DeviceInfo, "serial" | "backend">): string {
  return `${device.backend ?? "hdc"}:${device.serial}`;
}

export function parseDeviceKey(key: string): { backend: DeviceBackend; serial: string } {
  if (typeof key !== "string") throw new Error("设备标识无效");
  const match = /^(hdc|adb):(.+)$/.exec(key);
  const backend = (match?.[1] ?? "hdc") as DeviceBackend;
  const serial = match?.[2] ?? key;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(serial) || serial.startsWith("-")) throw new Error("设备标识无效");
  return { backend, serial };
}

export interface DeviceInfo {
  backend?: DeviceBackend;
  serial: string;
  transport: string;
  state: "ready" | "offline" | "unauthorized" | "unknown";
  rawState: string;
  label: string;
}

export interface VideoProfile {
  id: "quality" | "balanced" | "smooth";
  label: string;
  scale: number;
  frameRate: number;
  bitRate: number;
  iFrameInterval: number;
}

export const VIDEO_PROFILES: Record<VideoProfile["id"], VideoProfile> = {
  quality: {
    id: "quality",
    label: "清晰",
    scale: 1,
    frameRate: 30,
    bitRate: 12,
    iFrameInterval: 1000
  },
  balanced: {
    id: "balanced",
    label: "均衡",
    scale: 2,
    frameRate: 60,
    bitRate: 8,
    iFrameInterval: 1000
  },
  smooth: {
    id: "smooth",
    label: "流畅",
    scale: 3,
    frameRate: 30,
    bitRate: 4,
    iFrameInterval: 1000
  }
};

export interface StartOptions {
  backend?: DeviceBackend;
  serial: string;
  profileId: VideoProfile["id"];
}

export interface DeviceScreen {
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface MirrorStatus {
  state: ConnectionState;
  message: string;
  screen?: DeviceScreen;
  fps?: number;
  bitrate?: number;
  video?: VideoDiagnostics;
  screenPowerOff?: boolean;
}

export interface TouchCommand {
  screenWidth?: number;
  screenHeight?: number;
  kind: "touch";
  phase: "down" | "move" | "up";
  x: number;
  y: number;
}

export interface WheelCommand {
  screenWidth?: number;
  screenHeight?: number;
  kind: "wheel";
  direction: "up" | "down" | "stop";
  x: number;
  y: number;
}

export interface KeyCommand {
  kind: "key";
  key: "Back" | "Home" | "Power" | "VolumeUp" | "VolumeDown";
}

export interface RotateCommand {
  kind: "rotate";
  orientation: "horizontal" | "vertical";
}

export interface PasteCommand {
  kind: "paste";
  text: string;
}

export interface TextCommand { kind: "text"; text: string; }

export interface KeyboardCommand {
  kind: "keyboard";
  key: EditingKey;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface ScreenPowerCommand { kind: "screen-power"; on: boolean; }

export type ControlCommand = ScreenPowerCommand | TouchCommand | WheelCommand | KeyCommand | RotateCommand | PasteCommand | TextCommand | KeyboardCommand;

export interface OcrFallbackFrame {
  image: ArrayBuffer;
  mimeType: "image/png" | "image/jpeg";
}

export interface ScreenPlaceholder {
  image: ArrayBuffer;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export interface OcrSnapshot {
  id: string;
  image: ArrayBuffer;
  mimeType: "image/png" | "image/jpeg";
  source: "device" | "video";
  width: number;
  height: number;
  warning?: string;
}

export interface OcrBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrLine {
  text: string;
  confidence: number;
  box: OcrBox;
  words: OcrWord[];
}

export interface OcrWord {
  text: string;
  confidence: number;
  box: OcrBox;
  symbols: OcrSymbol[];
}

export interface OcrSymbol {
  text: string;
  box: OcrBox;
}

export interface OcrResult {
  snapshotId: string;
  text: string;
  lines: OcrLine[];
  durationMs: number;
}

export interface OcrProgress {
  snapshotId: string;
  status: string;
  progress: number;
}

export interface Diagnostics {
  adbPath: string | null;
  scrcpyPath: string | null;
  scrcpyVersion: string | null;
  appVersion: string;
  platform: string;
  hdcPath: string | null;
  hdcVersion: string | null;
  hdcCompatible: boolean;
  sdkAvailable: boolean;
  javaPath: string | null;
}

export type WindowMode = "full" | "compact";
export type WindowAction = "minimize" | "maximize-toggle" | "close";
export interface WindowState { mode: WindowMode; maximized: boolean; }

export interface HmRemoteApi {
  getWindowState(): Promise<WindowState>;
  setWindowMode(mode: WindowMode): Promise<WindowState>;
  windowAction(action: WindowAction): Promise<void>;
  reportMirrorSize(size: { width: number; height: number }): void;
  onWindowState(callback: (state: WindowState) => void): () => void;
  listDevices(): Promise<DeviceInfo[]>;
  getDiagnostics(): Promise<Diagnostics>;
  configureAndroid(): Promise<boolean>;
  copyScreenshot(device: string, fallback?: OcrFallbackFrame): Promise<void>;
  saveScreenshot(device: string, fallback?: OcrFallbackFrame): Promise<string | null>;
  beginRecording(): Promise<{ id: string } | null>;
  appendRecording(id: string, data: ArrayBuffer): Promise<void>;
  finishRecording(id: string): Promise<string | null>;
  onStopRecording(callback: () => void): () => void;
  start(options: StartOptions): Promise<void>;
  stop(): Promise<void>;
  control(command: ControlCommand): Promise<void>;
  requestIdr(): void;
  requestVideoPort(): void;
  reportVideoDiagnostics(diagnostics: VideoDiagnostics): void;
  pasteClipboard(): Promise<void>;
  captureScreenPlaceholder(serial: string): Promise<ScreenPlaceholder>;
  captureOcrSnapshot(serial: string, fallbackFrame?: OcrFallbackFrame): Promise<OcrSnapshot>;
  recognizeOcr(snapshotId: string): Promise<OcrResult>;
  cancelOcr(snapshotId?: string): Promise<void>;
  copyText(text: string): Promise<void>;
  onStatus(callback: (status: MirrorStatus) => void): () => void;
  onOcrProgress(callback: (progress: OcrProgress) => void): () => void;
}
