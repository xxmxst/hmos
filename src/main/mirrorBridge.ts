import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { harmonyKeyboardCodes, validateInputText } from "../shared/keyboard";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import type {
  ControlCommand,
  DeviceScreen,
  MirrorStatus,
  StartOptions,
  VideoDiagnostics,
  VideoProfile
} from "../shared/types";
import { VIDEO_PROFILES } from "../shared/types";
import {
  BridgeFrameParser,
  BridgeMessageType,
  decodeBridgeJson,
  type BridgeJsonMessage
} from "./protocol";
import { CaptureRecoveryGate, friendlyCaptureError } from "./captureRecovery";
import type { RuntimePaths } from "./paths";
const FIRST_FRAME_TIMEOUT_MESSAGE = "\u624b\u673a\u6295\u5c4f\u670d\u52a1\u5df2\u5c31\u7eea\uff0c\u4f46\u89e6\u53d1\u753b\u9762\u53d8\u5316\u540e 12 \u79d2\u4ecd\u672a\u6536\u5230\u89c6\u9891\u6570\u636e\u3002\u8bf7\u4fdd\u6301\u624b\u673a\u4eae\u5c4f\uff0c\u505c\u6b62\u540e\u91cd\u8bd5";
const FIRST_FRAME_WAITING_MESSAGE = "\u89c6\u9891\u670d\u52a1\u5df2\u5c31\u7eea\uff0c\u6b63\u5728\u6fc0\u6d3b\u624b\u673a\u753b\u9762\u5e76\u7b49\u5f85\u9996\u5e27\u2026";


interface PendingRequest {
  resolve: (value: BridgeJsonMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface VideoPacket {
  timestampUs: bigint;
  sequence: number;
  flags: number;
  data: Buffer;
}

export class MirrorBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private parser: BridgeFrameParser | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private currentStatus: MirrorStatus = { state: "idle", message: "尚未连接" };
  private currentSerial: string | null = null;
  private firstVideoPacketSeen = false;
  private readonly captureRecovery = new CaptureRecoveryGate((timeout) => {
    if (timeout.kind === "first-frame") {
      void this.failVideo(timeout.message);
      return;
    }
    void this.failVideo("手机端投屏服务兼容模式启动超时，请停止投屏后重新连接");
  });

  constructor(private readonly paths: RuntimePaths) {
    super();
  }

  get status(): MirrorStatus {
    return this.currentStatus;
  }

  get serial(): string | null {
    return this.currentSerial;
  }

  async start(options: StartOptions): Promise<void> {
    if (this.child) {
      await this.stop();
    }
    const profile = VIDEO_PROFILES[options.profileId];
    if (!profile) {
      throw new Error(`未知画质档位：${options.profileId}`);
    }
    this.assertDependencies();
    this.captureRecovery.recovered();
    this.firstVideoPacketSeen = false;
    this.currentSerial = options.serial;
    this.currentStatus = {
      state: "connecting",
      message: "正在启动投屏服务…",
      video: emptyVideoDiagnostics()
    };
    this.emit("status", this.currentStatus);
    this.spawnBridge();
    try {
      await this.request("start", this.startPayload(options.serial, profile), 20_000);
    } catch (error) {
      this.captureRecovery.recovered();
      this.setStatus("error", error instanceof Error ? error.message : String(error));
      this.currentSerial = null;
      await this.stopChild();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.captureRecovery.recovered();
    this.firstVideoPacketSeen = false;
    if (!this.child) {
      this.currentSerial = null;
      this.setIdleStatus();
      return;
    }
    this.setStatus("stopping", "正在停止投屏…");
    try {
      await this.request("stop", {}, 5_000);
    } catch {
      // 边车已退出时直接完成本地清理。
    }
    await this.stopChild();
    this.currentSerial = null;
    this.setIdleStatus();
  }

  async control(command: ControlCommand): Promise<void> {
    if (command.kind === "screen-power") throw new Error("当前鸿蒙通道暂不支持灭屏投屏，请使用 Android/ADB 设备");
    if (!this.child) {
      throw new Error("投屏尚未启动");
    }
    switch (command.kind) {
      case "keyboard":
        await this.request("keyboard", { keys: harmonyKeyboardCodes(command).join(" ") });
        break;
      case "text":
        validateInputText(command.text);
        if (command.text) await this.request("paste", { text: command.text }, 15_000);
        break;
      case "touch":
        await this.request("touch", command);
        break;
      case "wheel":
        await this.request("wheel", command);
        break;
      case "key":
        await this.request("key", command);
        break;
      case "rotate":
        await this.request("rotate", command);
        break;
      case "paste":
        if (Buffer.byteLength(command.text, "utf8") > 1024 * 1024) {
          throw new Error("粘贴文本不能超过 1 MiB");
        }
        await this.request("paste", command, 15_000);
        break;
    }
  }

  async requestIdr(): Promise<void> {
    if (this.child) {
      await this.request("requestIdr", {});
    }
  }

  updateVideoDiagnostics(video: VideoDiagnostics): void {
    if (!this.currentSerial || this.currentStatus.state === "idle" || this.currentStatus.state === "stopping") {
      return;
    }
    let state = this.currentStatus.state;
    let message = this.currentStatus.message;
    if (video.stage === "decoding" || video.stage === "switching") {
      state = "streaming";
      message = video.stage === "switching" ? "正在适配折叠屏画面…" : "投屏中";
    } else if (state !== "connecting" && state !== "reconnecting" && state !== "error") {
      state = "waiting-video";
      message = videoStageMessage(video);
    }
    this.currentStatus = { ...this.currentStatus, state, message, video };
    this.emit("status", this.currentStatus);
  }

  async failVideo(message: string): Promise<void> {
    this.captureRecovery.recovered();
    this.firstVideoPacketSeen = false;
    if (this.currentStatus.state === "idle" || this.currentStatus.state === "stopping") {
      return;
    }
    const previous = this.currentStatus.video;
    const video: VideoDiagnostics = {
      stage: "error",
      packets: previous?.packets ?? 0,
      bytes: previous?.bytes ?? 0,
      framing: previous?.framing ?? "unknown",
      hasSps: previous?.hasSps ?? false,
      hasPps: previous?.hasPps ?? false,
      hasIdr: previous?.hasIdr ?? false,
      error: message
    };
    this.currentStatus = { ...this.currentStatus, state: "error", message, video };
    this.emit("status", this.currentStatus);
    this.currentSerial = null;
    await this.stopChild();
  }

  private assertDependencies(): void {
    if (!this.paths.java) {
      throw new Error("未找到 Java 17 运行环境");
    }
    if (!existsSync(this.paths.bridgeJar)) {
      throw new Error("Java 边车尚未构建，请先运行 npm run build:bridge");
    }
    if (!existsSync(this.paths.sdkJar)) {
      throw new Error("缺少 HOScrcpy SDK，请先运行 npm run vendor:sdk");
    }
    if (!this.paths.hdc) {
      throw new Error("未找到 HDC，请设置 HMR_HDC_PATH 或放入 vendor/hdc");
    }
  }

  private startPayload(serial: string, profile: VideoProfile): Record<string, unknown> {
    return {
      serial,
      hdcPath: this.paths.hdc,
      hdcPort: "8710",
      scale: profile.scale,
      frameRate: profile.frameRate,
      bitRate: profile.bitRate,
      iFrameInterval: profile.iFrameInterval
    };
  }

  private spawnBridge(): void {
    const child = spawn(
      this.paths.java!,
      ["-cp", `${this.paths.bridgeJar}${delimiter}${this.paths.sdkJar}`, "cn.hmremote.bridge.BridgeMain"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    this.child = child;
    const parser = new BridgeFrameParser();
    this.parser = parser;
    child.stdout.on("data", (chunk: Buffer) => parser.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => this.emit("log", redactLog(text)));
    parser.on("frame", (frame) => {
      if (frame.type === BridgeMessageType.Video) {
        if (
          !this.currentSerial
          || this.currentStatus.state === "idle"
          || this.currentStatus.state === "stopping"
          || this.currentStatus.state === "error"
        ) {
          return;
        }
        this.markCaptureRecovered();
        this.emit("video", {
          timestampUs: frame.timestampUs,
          sequence: frame.sequence,
          flags: frame.flags,
          data: frame.payload
        } satisfies VideoPacket);
        return;
      }
      if (frame.type === BridgeMessageType.Json) {
        try {
          this.handleJson(decodeBridgeJson(frame.payload));
        } catch (error) {
          this.emit("log", `无法解析边车消息：${String(error)}`);
        }
      }
    });
    parser.on("error", (error) => this.emit("log", String(error)));
    child.on("error", (error) => {
      this.captureRecovery.recovered();
      this.failPending(error);
      this.setStatus("error", `边车启动失败：${error.message}`);
    });
    child.on("exit", (code, signal) => {
      const wasActive = this.child === child;
      if (wasActive) {
        this.child = null;
        this.parser = null;
        this.failPending(new Error(`边车已退出（${code ?? signal ?? "unknown"}）`));
        this.captureRecovery.recovered();
        if (
          this.currentStatus.state !== "stopping"
          && this.currentStatus.state !== "idle"
          && this.currentStatus.state !== "error"
        ) {
          this.setStatus("error", "投屏进程意外退出");
        }
      }
    });
  }

  private handleJson(message: BridgeJsonMessage): void {
    if (message.type === "response" && typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message);
      } else {
        pending.reject(new Error(String(message.error ?? "边车请求失败")));
      }
      return;
    }
    if (message.type !== "event") {
      return;
    }
    if (message.event === "ready") {
      if (
        !this.currentSerial
        || this.currentStatus.state === "idle"
        || this.currentStatus.state === "stopping"
        || this.currentStatus.state === "error"
      ) {
        return;
      }
      const width = numberValue(message.width);
      const height = numberValue(message.height);
      const screen: DeviceScreen = { width, height, rotation: 0 };
      const firstFrameReady = this.currentStatus.video?.stage === "decoding";
      if (!this.firstVideoPacketSeen) {
        this.captureRecovery.awaitFirstFrame(FIRST_FRAME_TIMEOUT_MESSAGE);
      }
        this.setStatus(
        firstFrameReady ? "streaming" : "waiting-video",
        firstFrameReady ? "投屏中" : "视频通道已连接，正在等待首帧…",
        screen
      );
      if (!firstFrameReady) {
        this.setStatus("waiting-video", FIRST_FRAME_WAITING_MESSAGE, screen);
      }
      void this.requestIdr().catch((error) => {
        this.emit("log", `Failed to request initial keyframe: ${String(error)}`);
      });
    } else if (message.event === "screen") {
      const screen: DeviceScreen = {
        width: numberValue(message.width),
        height: numberValue(message.height),
        rotation: normalizeRotation(numberValue(message.rotation))
      };
      this.setStatus(this.currentStatus.state, this.currentStatus.message, screen);
    } else if (message.event === "error") {
      this.handleCaptureError(message);
    } else if (message.event === "stats") {
      this.currentStatus = {
        ...this.currentStatus,
        fps: numberValue(message.fps),
        bitrate: numberValue(message.bitrate)
      };
      this.emit("status", this.currentStatus);
    }
  }

  private request(
    command: string,
    payload: object,
    timeoutMs = 5_000
  ): Promise<BridgeJsonMessage> {
    const child = this.child;
    if (!child || child.killed) {
      return Promise.reject(new Error("边车未运行"));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`边车请求超时：${command}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`, "utf8", (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private async stopChild(): Promise<void> {
    this.captureRecovery.recovered();
    this.firstVideoPacketSeen = false;
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = null;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1_500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.parser = null;
    this.failPending(new Error("投屏已停止"));
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleCaptureError(message: BridgeJsonMessage): void {
    if (
      this.currentStatus.state === "idle"
      || this.currentStatus.state === "stopping"
      || this.currentStatus.state === "error"
    ) {
      return;
    }
    const rawMessage = String(message.message ?? "手机投屏服务发生错误");
    const recoverable = typeof message.recoverable === "boolean" ? message.recoverable : undefined;
    if (this.captureRecovery.begin(rawMessage, recoverable)) {
      this.setStatus("reconnecting", "手机端投屏服务正在切换兼容模式…");
      return;
    }
    const code = typeof message.code === "string" ? message.code : undefined;
    void this.failVideo(friendlyCaptureError(rawMessage, code));
  }

  private markCaptureRecovered(): void {
    const wasRecovering = this.captureRecovery.active;
    this.firstVideoPacketSeen = true;
    this.captureRecovery.recovered();
    if (wasRecovering && this.currentStatus.state === "reconnecting") {
      this.setStatus("waiting-video", "手机端视频服务已恢复，正在等待首帧…");
    }
  }

  private setIdleStatus(): void {
    this.currentStatus = { state: "idle", message: "尚未连接" };
    this.emit("status", this.currentStatus);
  }

  private setStatus(
    state: MirrorStatus["state"],
    message: string,
    screen = this.currentStatus.screen
  ): void {
    this.currentStatus = screen
      ? { ...this.currentStatus, state, message, screen }
      : { ...this.currentStatus, state, message };
    this.emit("status", this.currentStatus);
  }
}

function emptyVideoDiagnostics(): VideoDiagnostics {
  return {
    stage: "waiting-stream",
    packets: 0,
    bytes: 0,
    framing: "unknown",
    hasSps: false,
    hasPps: false,
    hasIdr: false
  };
}

function videoStageMessage(video: VideoDiagnostics): string {
  switch (video.stage) {
    case "waiting-port":
      return "正在等待页面视频通道…";
    case "waiting-stream":
      return "视频通道已连接，正在等待手机数据…";
    case "waiting-config":
      return `已收到 ${video.packets} 个视频包，正在等待 SPS/PPS…`;
    case "waiting-keyframe":
      return "视频参数已就绪，正在等待关键帧…";
    case "waiting-frame":
      return "关键帧已到达，正在启动解码器…";
    case "decoding":
      return "投屏中";
    case "switching":
      return "正在适配折叠屏画面…";
    case "error":
      return video.error ?? "视频解码失败";
  }
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeRotation(value: number): DeviceScreen["rotation"] {
  return value === 90 || value === 180 || value === 270 ? value : 0;
}

function redactLog(text: string): string {
  return text.replace(/[A-Z0-9]{12,}/gi, "[设备标识已隐藏]").trim();
}
