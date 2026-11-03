import { EventEmitter } from "node:events";
import { randomInt } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { ControlCommand, DeviceScreen, MirrorStatus, StartOptions, VideoDiagnostics } from "../shared/types";
import { VIDEO_PROFILES } from "../shared/types";
import { AdbClient, validateAdbSerial } from "./adb";
import { inspectScrcpy } from "./androidTools";
import type { RuntimePaths } from "./paths";
import type { VideoPacket } from "./mirrorBridge";
import { encodeScrcpyControl, ScrcpyVideoParser } from "./scrcpyProtocol";

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

  constructor(private readonly paths: RuntimePaths) { super(); }

  get status(): MirrorStatus { return this.currentStatus; }
  get serial(): string | null { return this.currentSerial; }

  async start(options: StartOptions): Promise<void> {
    if (this.child || this.currentSerial || this.stopping) await this.stop();
    validateAdbSerial(options.serial);
    const profile = VIDEO_PROFILES[options.profileId];
    if (!profile) throw new Error("未知画质档位");
    if (!this.paths.adb || !this.paths.scrcpy) {
      throw new Error("请先点击“配置 Android”，选择已验证可用的 scrcpy.exe");
    }
    const tool = await inspectScrcpy(this.paths.scrcpy);
    this.major = Number(tool.version.split(".")[0]);
    const generation = ++this.generation;
    this.adb = new AdbClient(this.paths.adb);
    this.currentSerial = options.serial;
    this.currentStatus = { state: "connecting", message: "正在启动 Android 投屏服务…" };
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
        "control=true", "clipboard_autosync=false", "cleanup=true", "power_on=true",
        "video_codec_options=i-frame-interval=1", `max_fps=${profile.frameRate}`,
        `video_bit_rate=${profile.bitRate * 1_000_000}`,
        `max_size=${options.profileId === "quality" ? 0 : options.profileId === "balanced" ? 1600 : 1024}`
      ]);
      this.child = child;
      // 不输出服务端原始内容，避免日志包含设备名称或剪贴板。
      child.stdout.resume();
      child.stderr.resume();
      child.on("error", () => {
        if (this.child === child) void this.failVideo("Android 投屏服务启动失败，请检查 ADB 工具");
      });
      child.on("exit", (code) => {
        if (this.child !== child) return;
        this.child = null;
        this.emit("log", `Android 投屏服务退出，代码 ${code ?? "未知"}`);
        void this.failVideo("Android 投屏服务已退出，请确认 scrcpy 与 scrcpy-server 来自同一完整发行版，并检查系统兼容性");
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
      this.statsAt = Date.now();
      this.frameCount = this.byteCount = 0;
      parser.on("video", (packet: VideoPacket) => {
        if (generation !== this.generation) return;
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
      parser.on("error", (error: Error) => void this.failVideo(error.message));
      this.videoSocket.on("data", (chunk: Buffer) => parser.push(chunk));
      for (const socket of [this.videoSocket, this.controlSocket]) {
        socket.on("error", () => {
          if (generation === this.generation) void this.failVideo("Android 视频通道中断，请检查 USB 连接");
        });
        socket.on("close", () => {
          if (generation === this.generation) void this.failVideo("Android 设备已断开，请重新连接");
        });
      }
      this.controlSocket.resume();
      this.currentStatus = { ...this.currentStatus, state: "waiting-video", message: "正在等待 Android 首帧…" };
      this.publish();
      parser.push(connection.first);
      this.videoSocket?.resume();
    } catch (error) {
      if (generation === this.generation) await this.failVideo(error instanceof Error ? error.message : "Android 投屏启动失败");
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) await this.stopping;
    ++this.generation;
    this.currentStatus = { ...this.currentStatus, state: "stopping", message: "正在停止 Android 投屏…" };
    this.publish();
    this.stopping = this.cleanup();
    await this.stopping;
    this.stopping = null;
    this.currentStatus = { state: "idle", message: "尚未连接" };
    this.publish();
  }

  async control(command: ControlCommand): Promise<void> {
    if (!this.controlSocket || !this.currentStatus.screen || ["idle", "error", "stopping"].includes(this.currentStatus.state)) throw new Error("Android 投屏尚未就绪");
    const generation = this.generation;
    const messages = encodeScrcpyControl(command, this.currentStatus.screen);
    // Remember an in-flight off request too, so an immediate disconnect queues restoration after it.
    if (command.kind === "screen-power" && !command.on) this.restoreDisplayOnClose = true;
    if (messages.length) await this.writeControl(Buffer.concat(messages));
    if (command.kind === "screen-power" && generation === this.generation
      && !["idle", "error", "stopping"].includes(this.currentStatus.state)) {
      this.restoreDisplayOnClose = !command.on;
      this.currentStatus = { ...this.currentStatus, screenPowerOff: !command.on };
      this.publish();
    }
  }

  async requestIdr(): Promise<void> {
    // RESET_VIDEO 在 scrcpy 3.3 起可用；早期 3.x 等待定期关键帧。
    // 不重置已正常显示的视频，避免普通 UI 同步触发重复重建。
  }

  updateVideoDiagnostics(video: VideoDiagnostics): void {
    if (!this.currentSerial || this.currentStatus.state === "error" || this.currentStatus.state === "stopping") return;
    const streaming = video.stage === "decoding" || video.stage === "switching";
    this.currentStatus = { ...this.currentStatus, video, state: streaming ? "streaming" : "waiting-video",
      message: streaming ? "Android 投屏中" : "正在解码 Android 视频…" };
    this.publish();
  }

  async failVideo(message: string): Promise<void> {
    if (this.currentStatus.state === "idle" || this.currentStatus.state === "stopping" || this.currentStatus.state === "error") return;
    ++this.generation;
    this.currentStatus = { ...this.currentStatus, state: "error", message };
    this.publish();
    this.stopping = this.cleanup();
    await this.stopping;
    this.stopping = null;
    this.publish();
  }

  private publish(): void { this.emit("status", this.currentStatus); }

  private ensureCurrent(generation: number): void {
    if (generation !== this.generation) throw new Error("Android 连接已取消");
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

  private async cleanup(): Promise<void> {
    const adb = this.adb, serial = this.currentSerial, port = this.port, remote = this.remote;
    const child = this.child;
    this.child = null;
    if ((this.restoreDisplayOnClose || this.currentStatus.screenPowerOff) && this.controlSocket && !this.controlSocket.destroyed) {
      await this.writeControl(Buffer.from([10, 1])).catch(() => {
        this.emit("log", "亮屏请求未送达，将由 scrcpy 退出清理恢复");
      });
    }
    this.restoreDisplayOnClose = false;
    this.currentStatus = { ...this.currentStatus, screenPowerOff: false };
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
