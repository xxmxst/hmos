import type { VideoDiagnostics, VideoRecoveryRequest, VideoHealthSample } from "../shared/types";
import { playbackAdvanced, usableVideoFrame } from "../shared/videoHealth";
import type { RecoveryLogEvent } from "./recoveryLog";

const QUIET_SCREEN_CHECK_INTERVAL_MS = 60_000;

export class TerminalRecoveryError extends Error {}
type Cause = "decoder" | "port" | "source" | "transport";
interface RecoveryHost {
  prepare(request: VideoRecoveryRequest): Promise<void>;
  resetVideo(): Promise<boolean>;
  rebindPort(): Promise<void>;
  probe(captureFrame: boolean): Promise<VideoHealthSample | null>;
  verifyDevice(): Promise<void>;
  restart(): Promise<void>;
  visible(): boolean;
  status(recovering: boolean, message: string): void;
  fatal(message: string): Promise<void>;
  log?(event: RecoveryLogEvent): void;
}

/** Suspicion never changes playback; only confirmed faults start a recovery episode. */
export class VideoRecovery {
  sessionId = 0;
  active = false;
  recovering = false;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private task: Promise<void> | null = null;
  private probeTask: Promise<void> | null = null;
  private readonly delays = new Set<() => void>();
  private connected = false;
  private sourceFault = false;
  private sourceFrames = 0;
  private lastSource = 0;
  private lastProgress = 0;
  private lastHeartbeat = 0;
  private lastTick = 0;
  private previousSource = 0;
  private previousPackets = 0;
  private graceUntil = 0;
  private firstFrameDeadline = 0;
  private nextQuietCheck = 0;
  private nextHeartbeatCheck = 0;
  private retries = 0;
  private suspended = false;
  private wasMonitoring = false;
  private health: VideoDiagnostics | null = null;
  private suspicion: { cause: Cause; at: number } | null = null;

  constructor(private readonly host: RecoveryHost) {}

  async begin(): Promise<void> {
    this.cancel();
    this.active = true;
    this.connected = false;
    this.retries = 0;
    this.nextQuietCheck = this.nextHeartbeatCheck = 0;
    await this.prepare("initial");
  }

  connectedToSource(): void {
    if (!this.active) return;
    this.connected = true;
    this.lastSource = this.lastTick = Date.now();
    this.firstFrameDeadline = usableVideoFrame(this.health) ? 0 : Date.now() + 10_000;
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
    if (playbackAdvanced(video, previous)) { this.lastProgress = now; this.suspicion = null; }
    if (video.monitorPlayback && !previous?.monitorPlayback) this.graceUntil = now + 3_000;
    this.health = video;
    if (usableVideoFrame(video)) this.firstFrameDeadline = 0;
    if (video.stage === "error") {
      if (this.task) this.sourceFault = true;
      else if (this.connected) this.request("decoder", video.error);
    }
    return true;
  }

  request(cause: Cause, message = "视频链路停止更新"): void {
    if (!this.active || !this.connected) return;
    if (this.task) { this.sourceFault = true; return; }
    const generation = this.generation;
    this.retries = 0;
    this.recovering = true;
    this.sourceFault = false;
    this.suspicion = null;
    this.record("confirmed", cause);
    this.host.status(true, "正在恢复画面…");
    const task = this.recover(cause, message, generation).catch(async error => {
      if (this.current(generation)) await this.finishFailure(error instanceof Error ? error.message : "自动恢复失败");
    }).finally(() => {
      if (this.task === task) { this.task = null; if (this.current(generation)) this.recovering = false; }
    });
    this.task = task;
  }

  suspend(value: boolean): void {
    this.suspended = value;
    this.graceUntil = Date.now() + 10_000;
    this.lastTick = Date.now();
    this.suspicion = null;
  }

  cancel(): void {
    this.active = this.recovering = false;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const done of [...this.delays]) done();
  }

  async wait(): Promise<void> { await this.task; await this.probeTask; }

  private monitoring(): boolean {
    return !this.suspended && this.host.visible() && this.health?.monitorPlayback === true
      && Date.now() - this.lastHeartbeat <= 3_000;
  }

  private tick(): void {
    const now = Date.now(), gap = now - this.lastTick;
    const sourceDelta = this.sourceFrames - this.previousSource;
    const packetDelta = (this.health?.packets ?? 0) - this.previousPackets;
    this.previousSource = this.sourceFrames;
    this.previousPackets = this.health?.packets ?? 0;
    this.lastTick = now;
    if (!this.active || !this.connected) return;
    if (gap > 5_000 || gap < 0) { this.graceUntil = now + 10_000; this.suspicion = null; }
    const monitoring = this.monitoring();
    if (monitoring && !this.wasMonitoring) this.graceUntil = now + 3_000;
    this.wasMonitoring = monitoring;
    if (!monitoring || now < this.graceUntil) {
      this.suspicion = null;
      if (this.firstFrameDeadline) this.firstFrameDeadline += Math.max(0, gap);
      if (!this.task && !this.suspended && this.host.visible() && now - this.lastHeartbeat > 3_000) this.launchProbe(false);
      return;
    }
    if (this.task) return;
    if (this.firstFrameDeadline) {
      if (now >= this.firstFrameDeadline) this.request("decoder", "等待 Android 首帧超时");
      return;
    }
    if (now - this.lastSource >= QUIET_SCREEN_CHECK_INTERVAL_MS) { this.suspicion = null; this.launchProbe(true); return; }
    if (sourceDelta <= 0 || now - this.lastSource > 1_500 || now - this.lastProgress < 3_000) {
      this.suspicion = null;
      return;
    }
    const cause: Cause = packetDelta <= 0 ? "port" : "decoder";
    if (!this.suspicion || this.suspicion.cause !== cause) {
      this.suspicion = { cause, at: now };
      this.record("suspect", cause);
    } else if (now - this.suspicion.at >= 1_000) this.request(cause);
  }

  private launchProbe(capture: boolean): void {
    const now = Date.now();
    if (this.probeTask || this.task || now < (capture ? this.nextQuietCheck : this.nextHeartbeatCheck)) return;
    if (capture) this.nextQuietCheck = now + QUIET_SCREEN_CHECK_INTERVAL_MS; else this.nextHeartbeatCheck = now + 5_000;
    const generation = this.generation, sessionId = this.sessionId, source = this.sourceFrames;
    const task = (async () => {
      const first = await this.sample(capture);
      if (!this.current(generation) || sessionId !== this.sessionId || this.task) return;
      this.record("probe", capture ? "source" : "port");
      if (!capture || !first || first.comparison !== "different" || !this.monitoring() || source !== this.sourceFrames) return;
      await this.delay(1_000);
      if (!this.current(generation) || sessionId !== this.sessionId || this.task
        || !this.monitoring() || source !== this.sourceFrames) return;
      const second = await this.sample(true);
      if (this.current(generation) && sessionId === this.sessionId && !this.task && this.monitoring()
        && source === this.sourceFrames && second?.comparison === "different") this.request("source", "手机画面已变化，电脑画面未更新");
    })().catch(() => {}).finally(() => { if (this.probeTask === task) this.probeTask = null; });
    this.probeTask = task;
  }

  private async sample(capture: boolean): Promise<VideoHealthSample | null> {
    const generation = this.generation, session = this.sessionId;
    const result = await this.host.probe(capture).catch(() => null);
    if (!this.current(generation) || session !== this.sessionId || result?.diagnostics.sessionId !== session) return null;
    this.diagnostics(result.diagnostics);
    return result;
  }

  private async prepare(kind: VideoRecoveryRequest["kind"]): Promise<void> {
    this.sessionId++;
    this.health = null;
    this.sourceFault = false;
    this.sourceFrames = this.previousSource = this.previousPackets = 0;
    this.lastSource = this.lastProgress = this.lastHeartbeat = Date.now();
    this.suspicion = null;
    this.wasMonitoring = false;
    await this.host.prepare({ sessionId: this.sessionId, kind });
  }

  private async recover(cause: Cause, message: string, generation: number): Promise<void> {
    if (cause === "port") {
      try {
        this.record("repair", cause);
        await this.host.rebindPort();
        if (!this.current(generation)) return;
        if (await this.waitForHealthy(3_000, true)) { if (this.current(generation)) this.recovered(); return; }
      } catch { /* A responsive renderer can still need a fresh decoder/keyframe. */ }
    }
    if (cause !== "transport" && this.current(generation)) {
      try {
        this.recovering = true;
        this.host.status(true, "正在恢复画面…");
        this.record("repair", cause);
        await this.prepare("decoder");
        if (!this.current(generation)) return;
        await this.host.resetVideo();
        if (!this.current(generation)) return;
        if (await this.waitForHealthy(3_000)) { if (this.current(generation)) this.recovered(); return; }
      } catch (error) { if (error instanceof TerminalRecoveryError) throw error; }
    }
    while (this.current(generation) && this.retries < 3) {
      const attempt = ++this.retries;
      this.recovering = true;
      this.record("retry", cause);
      this.host.status(true, `正在恢复画面，本次重连 ${attempt}/3…`);
      await this.delay([1_000, 2_000, 4_000][attempt - 1]!);
      if (!this.current(generation)) return;
      try {
        await this.host.verifyDevice();
        if (!this.current(generation)) return;
        await this.prepare("reconnect");
        if (!this.current(generation)) return;
        await this.host.restart();
        if (!this.current(generation)) return;
        if (await this.waitForHealthy(10_000)) { if (this.current(generation)) this.recovered(); return; }
        message = "通道已建立，但没有确认画面恢复";
      } catch (error) {
        if (error instanceof TerminalRecoveryError) throw error;
        message = error instanceof Error ? error.message : "Android 视频重连失败";
      }
    }
    if (this.current(generation)) await this.finishFailure(`本次故障已重连 ${this.retries} 次：${message}。可点击连接重试`);
  }

  private async waitForHealthy(timeout: number, requireProgress = false): Promise<boolean> {
    const generation = this.generation, baseline = this.health;
    let frameSeen = false, frameAt = 0, elapsed = 0, stable = 0, last = Date.now(), previousSource = this.sourceFrames;
    let stalled = 0, staticMatched = false, different = 0, nextComparison = 0;
    while (this.current(generation)) {
      if (this.sourceFault || this.health?.stage === "error") return false;
      const now = Date.now(), delta = Math.min(1_500, Math.max(0, now - last));
      last = now;
      if (usableVideoFrame(this.health) && (!requireProgress || playbackAdvanced(this.health!, baseline))) {
        if (!frameSeen) { frameSeen = true; frameAt = now; stable = 0; this.recovering = false; this.host.status(false, "Android 投屏中，正在确认恢复…"); }
      }
      if (!this.monitoring()) {
        if (!this.suspended && this.host.visible() && now - this.lastHeartbeat > 3_000) await this.sample(false);
        await this.delay(1_000);
        previousSource = this.sourceFrames;
        continue;
      }
      if (now < this.graceUntil) { await this.delay(1_000); continue; }
      if (!frameSeen) { elapsed += delta; if (elapsed >= timeout) return false; }
      else {
        const incoming = this.sourceFrames > previousSource && now - this.lastSource <= 1_500;
        if (incoming && now - this.lastProgress >= 3_000) { if (++stalled >= 2) return false; stable = 0; }
        else {
          stalled = 0;
          if (now - this.lastProgress <= 3_000) stable += delta;
          else if (!incoming && now >= nextComparison) {
            const result = await this.sample(true);
            nextComparison = Date.now() + (result?.comparison === "different" ? 1_000 : 5_000);
            staticMatched = result?.comparison === "same";
            different = result?.comparison === "different" ? different + 1 : 0;
            if (different >= 2) return false;
          }
          if (staticMatched && !incoming && now - this.lastProgress > 3_000) stable += delta;
        }
        if (stable >= 5_000 && now - frameAt >= 5_000) return true;
      }
      previousSource = this.sourceFrames;
      await this.delay(1_000);
    }
    return false;
  }

  private recovered(): void {
    this.record("stable");
    this.retries = 0;
    this.recovering = false;
    this.graceUntil = Date.now() + 3_000;
    this.host.status(false, "Android 投屏中");
  }

  private current(generation: number): boolean { return this.active && generation === this.generation; }

  private async finishFailure(message: string): Promise<void> {
    this.record("failed");
    this.cancel();
    await this.host.fatal(message);
  }

  private record(event: RecoveryLogEvent["event"], cause?: Cause): void {
    this.host.log?.({ event, ...(cause ? { cause } : {}), sessionId: this.sessionId, attempt: this.retries,
      sourceFrames: this.sourceFrames, packets: this.health?.packets ?? 0, presentedFrames: this.health?.presentedFrames ?? 0,
      decodedFrames: this.health?.decodedFrames ?? 0, playbackTime: this.health?.playbackTime ?? 0,
      heartbeatAge: Math.max(0, Date.now() - this.lastHeartbeat), sourceAge: Math.max(0, Date.now() - this.lastSource) });
  }

  private delay(ms: number): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.delays.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.delays.add(done);
    });
  }
}
