import type { VideoDiagnostics, VideoRecoveryRequest } from "../shared/types";

export class TerminalRecoveryError extends Error {}
type Cause = "decoder" | "port" | "source" | "transport";
interface RecoveryHost {
  prepare(request: VideoRecoveryRequest): Promise<void>;
  resetVideo(): Promise<boolean>;
  canResetVideo(): boolean;
  verifyDevice(): Promise<void>;
  restart(): Promise<void>;
  visible(): boolean;
  status(recovering: boolean, message: string): void;
  fatal(message: string): Promise<void>;
}

/** One owner for watchdogs, local repair and bounded reconnects. */
export class VideoRecovery {
  sessionId = 0;
  active = false;
  recovering = false;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private task: Promise<void> | null = null;
  private observation: ((healthy: boolean) => void) | null = null;
  private cancelDelay: (() => void) | null = null;
  private connected = false;
  private hasPlayback = false;
  private sourceFault = false;
  private sourceFrames = 0;
  private renderedSource = 0;
  private lastSource = 0;
  private lastReceived = 0;
  private lastRendered = 0;
  private lastHeartbeat = 0;
  private lastTick = 0;
  private graceUntil = 0;
  private firstFrameDeadline = 0;
  private healthySince = 0;
  private switchingSince = 0;
  private retries = 0;
  private readonly softCauses = new Set<Cause>();
  private suspended = false;
  private health: VideoDiagnostics | null = null;

  constructor(private readonly host: RecoveryHost) {}

  async begin(): Promise<void> {
    this.cancel();
    this.active = true;
    this.connected = false;
    this.retries = 0;
    this.softCauses.clear();
    this.healthySince = 0;
    await this.prepare("initial");
  }

  connectedToSource(): void {
    if (!this.active) return;
    this.connected = true;
    this.lastSource = this.lastTick = Date.now();
    this.firstFrameDeadline = Date.now() + 10_000;
    if (this.hasPlayback) this.firstFrameDeadline = 0;
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1_000);
  }

  packet(config: boolean): void {
    if (!this.active || config) return;
    this.sourceFrames++;
    this.lastSource = Date.now();
  }

  diagnostics(video: VideoDiagnostics): boolean {
    if (!this.active || video.sessionId !== this.sessionId) return false;
    const now = Date.now(), previous = this.health;
    this.lastHeartbeat = now;
    if (!previous || video.packets > previous.packets) this.lastReceived = now;
    if (!previous || (video.presentedFrames ?? 0) > (previous.presentedFrames ?? 0)) {
      this.lastRendered = now;
      this.renderedSource = this.sourceFrames;
    }
    if (video.monitorPlayback && !previous?.monitorPlayback) this.graceUntil = now + 3_000;
    if (video.stage === "switching") this.switchingSince ||= now;
    else this.switchingSince = 0;
    this.health = video;
    if (!this.sourceFault && video.stage === "decoding" && (video.presentedFrames ?? 0) > 0) {
      this.hasPlayback = true;
      this.firstFrameDeadline = 0;
      this.healthySince ||= now;
      this.observation?.(true);
    } else if (video.stage === "error") {
      this.hasPlayback = false;
      this.observation?.(false);
      if (this.connected && !this.recovering) this.request("decoder", video.error);
    }
    return true;
  }

  request(cause: Cause, message = "视频链路没有继续更新"): void {
    if (!this.active || !this.connected) return;
    if (this.recovering) {
      if (cause === "transport") { this.sourceFault = true; this.hasPlayback = false; this.observation?.(false); }
      return;
    }
    const generation = this.generation;
    this.recovering = true;
    this.healthySince = 0;
    this.host.status(true, "正在恢复画面…");
    const task = this.recover(cause, message, generation).catch(async error => {
      if (this.current(generation)) await this.finishFailure(error instanceof Error ? error.message : "自动恢复失败");
    }).finally(() => {
      if (this.task === task) {
        this.task = null;
        if (this.current(generation)) this.recovering = false;
      }
    });
    this.task = task;
  }

  suspend(value: boolean): void {
    this.suspended = value;
    this.graceUntil = Date.now() + 10_000;
    this.lastSource = this.lastTick = Date.now();
  }

  cancel(): void {
    this.active = this.recovering = false;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.observation?.(false);
    this.cancelDelay?.();
  }

  async wait(): Promise<void> { await this.task; }

  private tick(): void {
    const now = Date.now(), gap = now - this.lastTick;
    this.lastTick = now;
    if (!this.active || !this.connected || this.suspended || this.recovering) return;
    if (gap > 5_000) { this.graceUntil = now + 10_000; this.lastSource = now; return; }
    if (now < this.graceUntil) return;
    if (this.firstFrameDeadline) {
      if (now >= this.firstFrameDeadline) this.request("decoder", "等待 Android 首帧超时");
      return;
    }
    if (this.healthySince && now - this.healthySince >= 60_000) { this.retries = 0; this.softCauses.clear(); }
    if (now - this.lastSource >= 8_000) {
      if (this.host.canResetVideo()) this.request("source", "Android 视频流停止更新");
      return;
    }
    if (!this.host.visible()) return;
    if (this.sourceFrames > 0 && now - this.lastHeartbeat >= 3_000) { this.request("port"); return; }
    if (!this.health?.monitorPlayback) return;
    if (this.switchingSince) {
      if (now - this.switchingSince >= 10_000) this.request("decoder", "视频尺寸切换超时");
      return;
    }
    if (this.sourceFrames > this.renderedSource && now - this.lastRendered >= 3_000) {
      this.request(now - this.lastReceived >= 3_000 ? "port" : "decoder");
    }
  }

  private async prepare(kind: VideoRecoveryRequest["kind"]): Promise<void> {
    this.sessionId++;
    this.sourceFault = false;
    this.health = null;
    this.hasPlayback = false;
    this.sourceFrames = this.renderedSource = 0;
    this.lastSource = this.lastReceived = this.lastRendered = this.lastHeartbeat = Date.now();
    this.switchingSince = 0;
    await this.host.prepare({ sessionId: this.sessionId, kind });
  }

  private async recover(cause: Cause, message: string, generation: number): Promise<void> {
    if (cause !== "transport" && (!this.softCauses.has(cause) || cause === "source")) {
      this.softCauses.add(cause);
      try {
        await this.prepare(cause === "port" ? "port" : "decoder");
        if (!this.current(generation)) return;
        await this.host.resetVideo();
        if (!this.current(generation)) return;
        if (await this.waitForPlayback(3_000)) {
          if (this.current(generation)) this.recovered();
          return;
        }
      } catch (error) {
        if (error instanceof TerminalRecoveryError) throw error;
      }
    }
    while (this.current(generation) && this.retries < 3) {
      const attempt = ++this.retries;
      this.host.status(true, `正在恢复画面，重连 ${attempt}/3…`);
      await this.delay([1_000, 2_000, 4_000][attempt - 1]!);
      if (!this.current(generation)) return;
      try {
        await this.host.verifyDevice();
        if (!this.current(generation)) return;
        await this.prepare("reconnect");
        if (!this.current(generation)) return;
        await this.host.restart();
        if (!this.current(generation)) return;
        if (await this.waitForPlayback(10_000)) {
          if (this.current(generation)) this.recovered();
          return;
        }
        message = "通道已建立，但没有恢复有效视频画面";
      } catch (error) {
        if (error instanceof TerminalRecoveryError) throw error;
        message = error instanceof Error ? error.message : "Android 视频重连失败";
      }
    }
    if (this.current(generation)) await this.finishFailure(`自动恢复已尝试 3 次：${message}。可点击连接重试`);
  }

  private recovered(): void {
    this.healthySince = Date.now();
    this.graceUntil = Date.now() + 3_000;
    this.recovering = false;
    this.host.status(false, "Android 投屏中");
  }

  private current(generation: number): boolean { return this.active && generation === this.generation; }

  private async finishFailure(message: string): Promise<void> {
    this.cancel();
    await this.host.fatal(message);
  }

  private waitForPlayback(timeout: number): Promise<boolean> {
    if (!this.active || this.sourceFault) return Promise.resolve(false);
    if (this.hasPlayback) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => done(false), timeout);
      const done = (healthy: boolean) => {
        clearTimeout(timer);
        if (this.observation === done) this.observation = null;
        resolve(healthy);
      };
      this.observation = done;
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(done, ms);
      const recovery = this;
      function done() {
        clearTimeout(timer);
        if (recovery.cancelDelay === done) recovery.cancelDelay = null;
        resolve();
      }
      this.cancelDelay = done;
    });
  }
}
