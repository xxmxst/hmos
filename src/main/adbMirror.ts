import { EventEmitter } from "node:events";
import { randomInt } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { ControlCommand, DeviceScreen, MirrorStatus, StartOptions, VideoDiagnostics, VideoRecoveryRequest } from "../shared/types";
import { VIDEO_PROFILES } from "../shared/types";
import { AdbClient, validateAdbSerial } from "./adb";
import { inspectScrcpy } from "./androidTools";
import type { RuntimePaths } from "./paths";
import type { VideoPacket } from "./mirrorBridge";
import { encodeScrcpyControl, ScrcpyVideoParser } from "./scrcpyProtocol";
import { VideoRecovery, TerminalRecoveryError } from "./videoRecovery";

export class AdbMirror extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private videoSocket: Socket | null = null;
  private controlSocket: Socket | null = null;
  private adb: AdbClient | null = null;
  private port: number | null = null;
  private remote: string | null = null;
  private currentSerial: string | null = null;
  private currentStatus: MirrorStatus = { state: "idle", message: "尚未连接" };
  private generation = 0;
  private stopping: Promise<void> | null = null;
  private statsAt = 0;
  private frameCount = 0;
  private byteCount = 0;
  private major = 0;
  private restoreDisplayOnClose = false;

  private readonly recovery: VideoRecovery;
  private desiredOptions: StartOptions | null = null;
  private connectionTask: Promise<void> | null = null;
  private terminationTask: Promise<void> | null = null;
  private opening = false;
  private connectionError: Error | null = null;
  private desiredScreenOff = false;
  private forwardVideo = true;
  private minor = 0;
  private lastVideoReset = 0;

  constructor(private readonly paths: RuntimePaths, hooks?: {
    prepare(request: VideoRecoveryRequest): Promise<void>;
    visible(): boolean;
  }) {
    super();
    this.recovery = new VideoRecovery({
      prepare: (request) => {
        if (request.kind === "reconnect") this.forwardVideo = false;
        return hooks?.prepare(request) ?? Promise.resolve();
      },
      visible: () => hooks?.visible() ?? true,
      canResetVideo: () => this.major > 3 || (this.major === 3 && this.minor >= 3),
      resetVideo: () => this.resetVideo(),
      verifyDevice: () => this.verifyRecoveryDevice(),
      restart: () => this.reconnect(),
      status: (recovering, message) => {
        this.currentStatus = { ...this.currentStatus, state: recovering ? "reconnecting" : "streaming", message };
        this.publish();
      },
      fatal: (message) => this.terminate(message)
    });
  }

  get status(): MirrorStatus { return this.currentStatus; }
  get serial(): string | null { return this.desiredOptions?.serial ?? this.currentSerial; }
  get videoSessionId(): number { return this.recovery.sessionId; }
  suspendVideoMonitoring(suspended: boolean): void { this.recovery.suspend(suspended); }
  cancelAutomaticRecovery(): void { this.recovery.cancel(); }

  async start(options: StartOptions): Promise<void> {
    if (this.child || this.currentSerial || this.stopping || this.terminationTask || this.recovery.active) await this.stop();
    const generation = ++this.generation;
    this.desiredOptions = { ...options };
    this.desiredScreenOff = false;
    this.currentStatus = { state: "connecting", message: "正在准备 Android 视频…" };
    this.publish();
    try {
      await this.recovery.begin();
      this.ensureCurrent(generation);
      const task = this.connect(options);
      this.connectionTask = task;
      await task;
      this.ensureCurrent(generation);
      this.recovery.connectedToSource();
    } catch (error) {
      if (generation === this.generation) await this.terminate(error instanceof Error ? error.message : "Android 投屏启动失败");
      throw error;
    } finally { this.connectionTask = null; }
  }

  private async connect(options: StartOptions): Promise<void> {
    this.opening = true;
    this.connectionError = null;
    try { await this.openConnection(options); }
    catch (error) {
      if (error instanceof Error && /协议不匹配|数据包长度无效|尺寸无效|支持 scrcpy|缺少 scrcpy|无法读取 scrcpy|选择已验证/.test(error.message)) throw new TerminalRecoveryError(error.message);
      throw error;
    } finally { this.opening = false; }
  }

  private async openConnection(options: StartOptions): Promise<void> {
    validateAdbSerial(options.serial);
    const profile = VIDEO_PROFILES[options.profileId];
    if (!profile) throw new Error("未知画质档位");
    if (!this.paths.adb || !this.paths.scrcpy) {
      throw new Error("请先点击“配置 Android”，选择已验证可用的 scrcpy.exe");
    }
    const generation = this.generation;
    const tool = await inspectScrcpy(this.paths.scrcpy);
    this.ensureCurrent(generation);
    this.major = Number(tool.version.split(".")[0]);
    this.minor = Number(tool.version.split(".")[1]);
    this.adb = new AdbClient(this.paths.adb);
    this.currentSerial = options.serial;
    this.currentStatus = { state: this.recovery.recovering ? "reconnecting" : "connecting",
      message: this.recovery.recovering ? "正在恢复画面，重建 Android 视频通道…" : "正在启动 Android 投屏服务…",
      screenPowerOff: this.desiredScreenOff };
    this.publish();
    const scid = randomInt(1, 0x7fffffff).toString(16).padStart(8, "0");
    this.remote = `/data/local/tmp/hmremote-scrcpy-${scid}.jar`;
    try {
      await this.adb.push(options.serial, tool.server, this.remote);
      this.ensureCurrent(generation);
      const port = Number(await this.adb.run([
        "-s", options.serial, "forward", "tcp:0", `localabstract:scrcpy_${scid}`
      ]));
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("无法建立 Android 视频通道");
      this.port = port;
      this.ensureCurrent(generation);
      const child = this.adb.spawnServer(options.serial, [
        `CLASSPATH=${this.remote}`, "app_process", "/", "com.genymobile.scrcpy.Server", tool.version,
        `scid=${scid}`, "log_level=warn", "audio=false", "video_codec=h264", "tunnel_forward=true",
        "control=true", "clipboard_autosync=false", "cleanup=true", `power_on=${!this.desiredScreenOff}`,
        "video_codec_options=i-frame-interval=1", `max_fps=${profile.frameRate}`,
        `video_bit_rate=${profile.bitRate * 1_000_000}`,
        `max_size=${options.profileId === "quality" ? 0 : options.profileId === "balanced" ? 1600 : 1024}`
      ]);
      this.child = child;
      // 不输出服务端原始内容，避免日志包含设备名称或剪贴板。
      child.stdout.resume();
      child.stderr.resume();
      child.on("error", () => {
        if (this.child === child) this.handleFault("Android 投屏服务启动失败，请检查 ADB 工具", true);
      });
      child.on("exit", (code) => {
        if (this.child !== child) return;
        this.child = null;
        this.emit("log", `Android 投屏服务退出，代码 ${code ?? "未知"}`);
        this.handleFault("Android 投屏服务已退出");
      });
      const connection = await this.openVideo(port, generation);
      this.ensureCurrent(generation);
      this.videoSocket = connection.socket;
      this.controlSocket = await openSocket(port);
      this.ensureCurrent(generation);
      const parser = new ScrcpyVideoParser(this.major);
      parser.on("screen", (screen: DeviceScreen) => {
        if (generation !== this.generation) return;
        this.currentStatus = { ...this.currentStatus, screen };
        this.publish();
      });
      this.forwardVideo = true;
      this.statsAt = Date.now();
      this.frameCount = this.byteCount = 0;
      parser.on("video", (packet: VideoPacket) => {
        if (generation !== this.generation || !this.forwardVideo) return;
        this.recovery.packet(Boolean(packet.flags & 1));
        this.frameCount += packet.flags & 1 ? 0 : 1;
        this.byteCount += packet.data.length;
        const elapsed = Date.now() - this.statsAt;
        if (elapsed >= 1_000) {
          this.currentStatus = { ...this.currentStatus,
            fps: Math.round(this.frameCount * 1_000 / elapsed), bitrate: this.byteCount * 8_000 / elapsed };
          this.frameCount = this.byteCount = 0;
          this.statsAt = Date.now();
          this.publish();
        }
        this.emit("video", packet);
      });
      parser.on("error", (error: Error) => { if (generation === this.generation) this.handleFault(error.message, true); });
      this.videoSocket.on("data", (chunk: Buffer) => parser.push(chunk));
      for (const socket of [this.videoSocket, this.controlSocket]) {
        socket.on("error", () => {
          if (generation === this.generation) this.handleFault("Android 视频通道中断，请检查 USB 连接");
        });
        socket.on("close", () => {
          if (generation === this.generation) this.handleFault("Android 视频通道已关闭");
        });
      }
      this.controlSocket.resume();
      if (this.desiredScreenOff) {
        await this.writeControl(Buffer.from([10, 0]));
        this.restoreDisplayOnClose = true;
      }
      this.currentStatus = { ...this.currentStatus, state: this.recovery.recovering ? "reconnecting" : "waiting-video",
        message: this.recovery.recovering ? "正在恢复画面，等待新首帧…" : "正在等待 Android 首帧…" };
      this.publish();
      parser.push(connection.first);
      this.videoSocket?.resume();
      this.ensureCurrent(generation);
    } catch (error) {
      if (error instanceof Error && /协议不匹配|数据包长度无效|尺寸无效|支持 scrcpy|缺少 scrcpy|无法读取 scrcpy/.test(error.message)) {
        throw new TerminalRecoveryError(error.message);
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const task = this.stopSession();
    this.stopping = task;
    try { await task; } finally { if (this.stopping === task) this.stopping = null; }
  }

  private async stopSession(): Promise<void> {
    this.recovery.cancel();
    ++this.generation;
    this.currentStatus = { ...this.currentStatus, state: "stopping", message: "正在停止 Android 投屏…" };
    this.publish();
    await this.connectionTask?.catch(() => {});
    await this.recovery.wait();
    await this.terminationTask;
    await this.cleanup();
    this.desiredOptions = null;
    this.desiredScreenOff = false;
    this.currentStatus = { state: "idle", message: "尚未连接" };
    this.publish();
  }

  async control(command: ControlCommand): Promise<void> {
    const release = (command.kind === "touch" && command.phase === "up") || (command.kind === "wheel" && command.direction === "stop");
    if ((this.recovery.recovering && !release) || !this.controlSocket || !this.currentStatus.screen || ["idle", "error", "stopping"].includes(this.currentStatus.state)) throw new Error("Android 投屏尚未就绪");
    const generation = this.generation;
    const messages = encodeScrcpyControl(command, this.currentStatus.screen);
    // Remember an in-flight off request too, so an immediate disconnect queues restoration after it.
    if (command.kind === "screen-power" && !command.on) this.restoreDisplayOnClose = true;
    if (messages.length) await this.writeControl(Buffer.concat(messages));
    if (command.kind === "screen-power" && generation === this.generation
      && !["idle", "error", "stopping"].includes(this.currentStatus.state)) {
      this.desiredScreenOff = this.restoreDisplayOnClose = !command.on;
      this.currentStatus = { ...this.currentStatus, screenPowerOff: !command.on };
      this.publish();
    }
  }

  async requestIdr(): Promise<void> {
    // RESET_VIDEO 在 scrcpy 3.3 起可用；早期 3.x 等待定期关键帧。
    // 不重置已正常显示的视频，避免普通 UI 同步触发重复重建。
  }

  updateVideoDiagnostics(video: VideoDiagnostics): void {
    if (video.sessionId === this.videoSessionId && video.stage === "error" && /不支持手机输出/.test(video.error ?? "")) {
      this.handleFault(video.error!, true);
      return;
    }
    if (!this.recovery.diagnostics(video) || ["error", "stopping", "idle"].includes(this.currentStatus.state)) return;
    const streaming = video.stage === "decoding" || video.stage === "switching";
    const recovering = this.recovery.recovering;
    this.currentStatus = { ...this.currentStatus, video,
      state: recovering ? "reconnecting" : streaming ? "streaming" : "waiting-video",
      message: recovering ? this.currentStatus.message : streaming ? "Android 投屏中" : "正在解码 Android 视频…" };
    this.publish();
  }

  async failVideo(message: string): Promise<void> {
    if (this.recovery.active) this.recovery.request("decoder", message);
    else if (!["idle", "stopping", "error"].includes(this.currentStatus.state)) await this.terminate(message);
  }

  private handleFault(message: string, permanent = false): void {
    if (this.opening) { this.connectionError = permanent ? new TerminalRecoveryError(message) : new Error(message); return; }
    if (permanent) { this.recovery.cancel(); void this.terminate(message); }
    else this.recovery.request("transport", message);
  }

  private async resetVideo(): Promise<boolean> {
    if (this.major < 3 || (this.major === 3 && this.minor < 3)) return false;
    if (Date.now() - this.lastVideoReset < 1_000) return true;
    this.lastVideoReset = Date.now();
    await this.writeControl(Buffer.from([17]));
    return true;
  }

  private async verifyRecoveryDevice(): Promise<void> {
    if (!this.paths.adb || !this.paths.scrcpy) throw new TerminalRecoveryError("Android 投屏工具不可用，请重新配置");
    const serial = this.desiredOptions?.serial;
    const device = (await new AdbClient(this.paths.adb).listDevices()).find(item => item.serial === serial);
    if (!device) throw new TerminalRecoveryError("原 Android 设备已断开，请检查 USB 连接后点击连接");
    if (device.state === "unauthorized") throw new TerminalRecoveryError("手机调试授权已失效，请在手机上确认授权后重新连接");
    if (device.state !== "ready") throw new TerminalRecoveryError("原 Android 设备未就绪，请检查连接后重试");
  }

  private async reconnect(): Promise<void> {
    const options = this.desiredOptions;
    const generation = ++this.generation;
    await this.cleanup(false);
    if (!options || !this.recovery.active || generation !== this.generation) throw new Error("Android 恢复已取消");
    const task = this.connect(options);
    this.connectionTask = task;
    try { await task; } finally { if (this.connectionTask === task) this.connectionTask = null; }
  }

  private async terminate(message: string): Promise<void> {
    if (this.terminationTask) return this.terminationTask;
    const task = this.terminateSession(message);
    this.terminationTask = task;
    try { await task; } finally { if (this.terminationTask === task) this.terminationTask = null; }
  }

  private async terminateSession(message: string): Promise<void> {
    this.recovery.cancel();
    ++this.generation;
    this.currentStatus = { ...this.currentStatus, state: "error", message };
    this.publish();
    await this.cleanup();
    this.desiredOptions = null;
    this.desiredScreenOff = false;
    this.publish();
  }

  private publish(): void {
    if (this.recovery.active) this.currentStatus = { ...this.currentStatus, videoSessionId: this.recovery.sessionId };
    this.emit("status", this.currentStatus);
  }

  private ensureCurrent(generation: number): void {
    if (generation !== this.generation) throw new Error("Android 连接已取消");
    if (this.opening && this.connectionError) throw this.connectionError;
  }

  private async openVideo(port: number, generation: number): Promise<{ socket: Socket; first: Buffer }> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      this.ensureCurrent(generation);
      try {
        const socket = await openSocket(port);
        try {
          const first = await new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error("等待视频服务超时")), 500);
            const finish = (error?: Error, data?: Buffer) => {
              clearTimeout(timer);
              socket.removeListener("data", onData);
              socket.removeListener("error", onError);
              socket.removeListener("close", onClose);
              socket.pause();
              if (error) { socket.destroy(); reject(error); } else resolve(data!);
            };
            const onData = (data: Buffer) => finish(undefined, data);
            const onError = () => finish(new Error("视频服务未就绪"));
            const onClose = () => finish(new Error("视频服务未就绪"));
            socket.once("data", onData);
            socket.once("error", onError);
            socket.once("close", onClose);
          });
          return { socket, first };
        } catch { socket.destroy(); }
      } catch { /* ADB 转发可能先于手机端服务就绪，只在十秒内重试。 */ }
      await delay(100);
    }
    throw new Error("Android 投屏服务连接超时，请确认手机已解锁，并使用兼容当前系统的 scrcpy");
  }

  private async writeControl(message: Buffer): Promise<void> {
    const socket = this.controlSocket;
    if (!socket || socket.destroyed || socket.writableLength > 1024 * 1024) throw new Error("Android 控制通道不可用");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Android 控制操作超时")), 5_000);
      socket.write(message, (error) => { clearTimeout(timer); error ? reject(new Error("Android 控制操作失败")) : resolve(); });
    });
  }

  private async cleanup(restoreDisplay = true): Promise<void> {
    const adb = this.adb, serial = this.currentSerial, port = this.port, remote = this.remote;
    const child = this.child;
    this.child = null;
    if (restoreDisplay && (this.restoreDisplayOnClose || this.currentStatus.screenPowerOff) && this.controlSocket && !this.controlSocket.destroyed) {
      await this.writeControl(Buffer.from([10, 1])).catch(() => {
        this.emit("log", "亮屏请求未送达，将由 scrcpy 退出清理恢复");
      });
    }
    this.restoreDisplayOnClose = false;
    if (restoreDisplay) this.currentStatus = { ...this.currentStatus, screenPowerOff: false };
    this.videoSocket?.destroy();
    this.controlSocket?.destroy();
    this.videoSocket = this.controlSocket = null;
    if (child) {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 800);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (adb && serial && port) await adb.run(["-s", serial, "forward", "--remove", `tcp:${port}`], 3_000).catch(() => {});
    if (adb && serial && remote) await adb.run(["-s", serial, "shell", "rm", "-f", remote], 3_000).catch(() => {});
    this.adb = null;
    this.currentSerial = null;
    this.port = null;
    this.remote = null;
  }
}

function openSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setNoDelay(true);
    socket.on("error", () => {});
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("本地 ADB 通道连接超时")); }, 1_000);
    const onError = () => { clearTimeout(timer); socket.destroy(); reject(new Error("本地 ADB 通道不可用")); };
    socket.once("error", onError);
    socket.once("connect", () => { clearTimeout(timer); socket.removeListener("error", onError); resolve(socket); });
  });
}
