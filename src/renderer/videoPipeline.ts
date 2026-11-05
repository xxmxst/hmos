import JMuxer from "jmuxer";
import type {
  OcrFallbackFrame,
  ScreenPlaceholder,
  VideoDiagnostics,
  VideoRecoveryRequest,
  VideoStage
} from "../shared/types";
import { H264StreamNormalizer } from "./h264Stream";

export interface VideoPacket {
  sessionId?: number;
  data: ArrayBuffer;
  timestampUs: number;
  sequence: number;
  flags: number;
}

type DecoderName = "MediaSource" | "不可用";

interface DecoderSlot {
  readonly video: HTMLVideoElement;
  muxer: JMuxer | null;
  configurationVersion: number;
  generation: number;
  removeListeners: (() => void) | null;
}

const INITIAL_RECOVERY_DELAY_MS = 3_000;
const VIDEO_DATA_TIMEOUT_MS = 8_000;
const TRANSITION_DECODE_TIMEOUT_MS = 1_500;
const TRANSITION_RETRY_DELAY_MS = 2_000;
const PLACEHOLDER_DELAY_MS = 500;
const DIAGNOSTIC_INTERVAL_MS = 500;
const TRAILING_START_CODE = new Uint8Array([0, 0, 0, 1]);

export class VideoPipeline {
  private readonly normalizer = new H264StreamNormalizer();
  private videoSessionId: number | undefined;
  private rebuilding = false;
  private presentedFrames = 0;
  private presentationSerial = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cancelPresentation: (() => void) | null = null;
  private readonly slots: [DecoderSlot, DecoderSlot];
  private visibleSlot: DecoderSlot | null = null;
  private targetSlot: DecoderSlot | null = null;
  private active = false;
  private portReady = false;
  private recoveryAttempted = false;
  private packets = 0;
  private bytes = 0;
  private lastReportedStage: VideoStage | null = null;
  private lastDiagnosticsAt = 0;
  private configurationChangePending = false;
  private switchingConfigurationVersion = 0;
  private sessionGeneration = 0;
  private placeholderVisible = false;
  private initialRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private failureTimer: ReturnType<typeof setTimeout> | null = null;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;
  private transitionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private placeholderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    primaryVideo: HTMLVideoElement,
    secondaryVideo: HTMLVideoElement,
    private readonly onDimensions: (width: number, height: number, source: "video" | "placeholder") => void,
    private readonly onDecoder: (name: DecoderName) => void,
    private readonly requestIdr: () => void,
    private readonly onDiagnostics: (diagnostics: VideoDiagnostics) => void = () => {},
    private readonly loadPlaceholder?: () => Promise<ScreenPlaceholder>,
    private readonly monitorPlayback: () => boolean = () => typeof document === "undefined" || !document.hidden
  ) {
    this.slots = [
      this.createSlot(primaryVideo),
      this.createSlot(secondaryVideo)
    ];
  }

  async initialize(): Promise<void> {
    if (!this.slots.some((slot) => slot.muxer)) {
      this.prepareSlot(this.slots[0], 0);
    }
    this.hideRenderTargets();
    this.reportDiagnostics(true);
  }

  setPortReady(ready: boolean): void {
    this.portReady = ready;
    if (ready) {
      this.startStreamTimer();
    } else {
      this.clearStreamTimer();
    }
    this.reportDiagnostics(true);
  }

  beginSession(): void {
    this.videoSessionId = undefined;
    this.rebuilding = false;
    this.presentedFrames = 0;
    this.active = true;
    this.visibleSlot = null;
    this.targetSlot = this.slots.find((slot) => slot.muxer) ?? null;
    this.recoveryAttempted = false;
    this.packets = 0;
    this.bytes = 0;
    this.lastReportedStage = null;
    this.lastDiagnosticsAt = 0;
    this.configurationChangePending = false;
    this.switchingConfigurationVersion = 0;
    this.placeholderVisible = false;
    this.sessionGeneration++;
    this.clearTimers();
    this.normalizer.reset();
    this.hideRenderTargets();
    if (!this.targetSlot) {
      this.targetSlot = this.slots[0];
      this.prepareSlot(this.targetSlot, 0);
    } else {
      this.targetSlot.configurationVersion = 0;
    }
    this.startStreamTimer();
    this.startPlaceholderTimer();
    this.requestIdr();
    this.reportDiagnostics(true);
  }

  prepareRecovery(request: VideoRecoveryRequest): void {
    if (request.kind === "initial") {
      this.beginSession();
      this.videoSessionId = request.sessionId;
      this.clearTimers();
    } else {
      this.freezeVisibleFrame();
      this.clearTimers();
      this.active = true;
      this.videoSessionId = request.sessionId;
      this.rebuilding = true;
      this.sessionGeneration++;
      if (this.targetSlot && this.targetSlot !== this.visibleSlot) this.destroySlot(this.targetSlot);
      this.targetSlot = null;
      if (request.kind === "reconnect") this.normalizer.reset(); else this.normalizer.rearm();
    }
    this.packets = this.bytes = this.presentedFrames = 0;
    this.recoveryAttempted = false;
    this.configurationChangePending = false;
    this.switchingConfigurationVersion = 0;
    this.heartbeatTimer = setInterval(() => this.reportDiagnostics(true), 1_000);
    this.reportDiagnostics(true);
  }

  feed(packet: VideoPacket): void {
    if (!this.active || (this.videoSessionId !== undefined && packet.sessionId !== this.videoSessionId)) {
      return;
    }
    const bytes = new Uint8Array(packet.data);
    if (bytes.byteLength === 0) {
      return;
    }
    this.clearStreamTimer();
    this.packets++;
    this.bytes += bytes.byteLength;
    if (!this.visibleSlot) {
      this.startInitialRecoveryTimer();
    }

    try {
      const chunks = this.normalizer.push(bytes);
      const configurationVersion = this.normalizer.state.configurationVersion;
      if (chunks.length > 0) {
        const muxerInput = joinChunksWithTrailingStartCode(chunks);
        if (this.rebuilding) {
          let slot = this.targetSlot;
          if (!slot || slot === this.visibleSlot || slot.configurationVersion !== configurationVersion) {
            slot = this.freeSlot();
            this.targetSlot = slot;
            this.prepareSlot(slot, configurationVersion);
          }
          slot.muxer?.feed({ video: muxerInput });
        } else if (!this.visibleSlot) {
          const slot = this.ensureInitialTarget(configurationVersion);
          slot.muxer?.feed({ video: muxerInput });
        } else if (configurationVersion === this.visibleSlot.configurationVersion) {
          this.visibleSlot.muxer?.feed({ video: muxerInput });
        } else {
          this.configurationChangePending = true;
          const slot = this.ensureTransitionTarget(configurationVersion);
          slot.muxer?.feed({ video: muxerInput });
        }
        this.configurationChangePending = false;
      } else if (
        this.visibleSlot
        && configurationVersion !== this.visibleSlot.configurationVersion
      ) {
        this.beginConfigurationSwitch(configurationVersion);
      }
      this.reportDiagnostics();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  reset(): void {
    this.videoSessionId = undefined;
    this.rebuilding = false;
    this.presentedFrames = 0;
    this.active = false;
    this.visibleSlot = null;
    this.targetSlot = null;
    this.recoveryAttempted = false;
    this.packets = 0;
    this.bytes = 0;
    this.lastReportedStage = null;
    this.lastDiagnosticsAt = 0;
    this.configurationChangePending = false;
    this.switchingConfigurationVersion = 0;
    this.placeholderVisible = false;
    this.sessionGeneration++;
    this.clearTimers();
    this.normalizer.reset();
    for (const slot of this.slots) {
      this.destroySlot(slot);
    }
    this.hideRenderTargets();
    this.clearCanvas();
    this.reportDiagnostics(true);
  }

  endVideoSession(): void {
    this.active = false;
    this.clearTimers();
  }

  dispose(): void {
    this.reset();
  }

  canControl(): boolean {
    return this.active && this.visibleSlot !== null && !this.isSwitching();
  }

  isSwitching(): boolean {
    return Boolean(
      this.visibleSlot
      && (
        this.rebuilding
        || this.switchingConfigurationVersion !== 0
        || (this.targetSlot && this.targetSlot !== this.visibleSlot)
      )
    );
  }

  getRenderTarget(): HTMLVideoElement | null {
    return this.visibleSlot?.video ?? null;
  }

  getVideoTargets(): readonly HTMLVideoElement[] {
    return this.slots.map((slot) => slot.video);
  }

  async captureFrame(): Promise<OcrFallbackFrame | undefined> {
    let source: CanvasImageSource;
    let width: number;
    let height: number;
    if (!this.canvas.hidden && this.canvas.width > 0 && this.canvas.height > 0) {
      source = this.canvas;
      width = this.canvas.width;
      height = this.canvas.height;
    } else {
      const video = this.visibleSlot?.video;
      if (
        !video
        || video.hidden
        || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
        || video.videoWidth <= 0
        || video.videoHeight <= 0
      ) {
        return undefined;
      }
      source = video;
      width = video.videoWidth;
      height = video.videoHeight;
    }

    const capture = document.createElement("canvas");
    capture.width = width;
    capture.height = height;
    const context = capture.getContext("2d");
    if (!context) {
      return undefined;
    }
    context.drawImage(source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => capture.toBlob(resolve, "image/png"));
    if (!blob) {
      return undefined;
    }
    return {
      image: await blob.arrayBuffer(),
      mimeType: "image/png"
    };
  }

  private createSlot(video: HTMLVideoElement): DecoderSlot {
    return {
      video,
      muxer: null,
      configurationVersion: 0,
      generation: 0,
      removeListeners: null
    };
  }

  private prepareSlot(slot: DecoderSlot, configurationVersion: number): void {
    this.destroySlot(slot);
    slot.configurationVersion = configurationVersion;
    const generation = ++slot.generation;
    slot.video.hidden = true;

    const loadedData = () => this.handleLoadedData(slot, generation);
    const metadata = () => this.handleMetadata(slot, generation);
    const error = () => this.handleSlotError(slot, generation);
    slot.video.addEventListener("loadeddata", loadedData);
    slot.video.addEventListener("loadedmetadata", metadata);
    slot.video.addEventListener("resize", metadata);
    slot.video.addEventListener("error", error);
    slot.removeListeners = () => {
      slot.video.removeEventListener("loadeddata", loadedData);
      slot.video.removeEventListener("loadedmetadata", metadata);
      slot.video.removeEventListener("resize", metadata);
      slot.video.removeEventListener("error", error);
    };

    try {
      slot.muxer = new JMuxer({
        node: slot.video,
        mode: "video",
        flushingTime: 0,
        fps: 60,
        clearBuffer: true,
        onError: () => this.handleSlotError(slot, generation),
        onUnsupportedCodec: () => this.handleUnsupportedCodec(slot, generation)
      });
      this.onDecoder("MediaSource");
    } catch (errorValue) {
      this.onDecoder("不可用");
      if (this.visibleSlot) {
        this.retryTransition();
      } else {
        this.fail(errorValue instanceof Error ? errorValue.message : "无法创建 MediaSource 解码器");
      }
    }
  }

  private destroySlot(slot: DecoderSlot): void {
    slot.generation++;
    slot.removeListeners?.();
    slot.removeListeners = null;
    const muxer = slot.muxer;
    slot.muxer = null;
    slot.configurationVersion = 0;
    slot.video.hidden = true;
    if (muxer) {
      muxer.destroy();
    }
  }

  private ensureInitialTarget(configurationVersion: number): DecoderSlot {
    let slot = this.targetSlot;
    if (!slot || slot === this.visibleSlot) {
      slot = this.freeSlot();
      this.targetSlot = slot;
      this.prepareSlot(slot, configurationVersion);
    } else if (slot.configurationVersion === 0) {
      slot.configurationVersion = configurationVersion;
    } else if (slot.configurationVersion !== configurationVersion) {
      this.prepareSlot(slot, configurationVersion);
    }
    return slot;
  }

  private beginConfigurationSwitch(configurationVersion: number): void {
    if (!this.visibleSlot || configurationVersion === this.visibleSlot.configurationVersion) {
      return;
    }
    this.switchingConfigurationVersion = configurationVersion;
    if (
      this.targetSlot
      && this.targetSlot !== this.visibleSlot
      && this.targetSlot.configurationVersion !== configurationVersion
    ) {
      const stale = this.targetSlot;
      this.targetSlot = null;
      this.destroySlot(stale);
      this.clearTransitionTimer();
    }
    if (!this.configurationChangePending) {
      this.configurationChangePending = true;
      this.requestIdr();
    }
    this.reportDiagnostics(true);
  }

  private ensureTransitionTarget(configurationVersion: number): DecoderSlot {
    this.beginConfigurationSwitch(configurationVersion);
    let slot = this.targetSlot;
    if (!slot || slot === this.visibleSlot) {
      slot = this.freeSlot();
      this.targetSlot = slot;
      this.prepareSlot(slot, configurationVersion);
    } else if (slot.configurationVersion !== configurationVersion) {
      this.prepareSlot(slot, configurationVersion);
    }
    this.switchingConfigurationVersion = configurationVersion;
    this.clearTransitionRetryTimer();
    this.startTransitionTimer();
    this.reportDiagnostics(true);
    return slot;
  }

  private freeSlot(): DecoderSlot {
    return this.slots[0] === this.visibleSlot ? this.slots[1] : this.slots[0];
  }

  private handleLoadedData(slot: DecoderSlot, generation: number): void {
    if (
      !this.active
      || slot.generation !== generation
      || slot !== this.targetSlot
      || !slot.muxer
      || slot.video.videoWidth <= 0
      || slot.video.videoHeight <= 0
    ) {
      return;
    }
    void slot.video.play().catch(() => {
      // muted autoplay normally succeeds; JMuxer retries as its buffer advances.
    });

    const previous = this.visibleSlot;
    slot.video.hidden = false;
    this.visibleSlot = slot;
    this.targetSlot = null;
    this.rebuilding = false;
    this.presentedFrames++;
    if (this.videoSessionId !== undefined) this.trackPresentation(slot);
    this.recoveryAttempted = false;
    this.configurationChangePending = false;
    this.switchingConfigurationVersion = 0;
    this.placeholderVisible = false;
    this.canvas.hidden = true;
    this.clearInitialTimers();
    this.clearTransitionTimers();
    this.handleMetadata(slot, generation);

    if (previous && previous !== slot) {
      previous.video.hidden = true;
      this.destroySlot(previous);
    }
    this.reportDiagnostics(true);
  }

  private handleMetadata(slot: DecoderSlot, generation: number): void {
    if (
      !this.active
      || slot.generation !== generation
      || slot !== this.visibleSlot
    ) {
      return;
    }
    const width = slot.video.videoWidth;
    const height = slot.video.videoHeight;
    if (width > 0 && height > 0) {
      this.onDimensions(width, height, "video");
    }
  }

  private handleSlotError(slot: DecoderSlot, generation: number): void {
    if (!this.active || slot.generation !== generation) {
      return;
    }
    if (this.rebuilding && slot === this.visibleSlot) return;
    if (this.videoSessionId !== undefined) { this.fail("电脑端视频解码停止更新"); return; }
    if (slot === this.targetSlot && this.visibleSlot) {
      this.retryTransition();
      return;
    }
    if (slot === this.visibleSlot) {
      this.freezeVisibleFrame();
      this.visibleSlot = null;
      this.targetSlot = null;
      this.destroySlot(slot);
      this.recoverInitialDecoder();
      return;
    }
    if (!this.visibleSlot) {
      this.recoverInitialDecoder();
    }
  }

  private handleUnsupportedCodec(slot: DecoderSlot, generation: number): void {
    if (!this.active || slot.generation !== generation) {
      return;
    }
    if (this.rebuilding && slot === this.visibleSlot) return;
    if (this.visibleSlot && slot === this.targetSlot) {
      this.retryTransition();
    } else {
      this.fail("当前系统不支持手机输出的 H.264 编码格式");
    }
  }

  private startInitialRecoveryTimer(): void {
    if (this.videoSessionId !== undefined) return;
    if (
      !this.active
      || this.visibleSlot
      || this.initialRecoveryTimer
      || this.failureTimer
    ) {
      return;
    }
    this.initialRecoveryTimer = setTimeout(() => {
      this.initialRecoveryTimer = null;
      this.recoverInitialDecoder();
    }, INITIAL_RECOVERY_DELAY_MS);
  }

  private recoverInitialDecoder(): void {
    if (!this.active || this.visibleSlot) {
      return;
    }
    if (this.recoveryAttempted) {
      this.fail(this.failureMessage());
      return;
    }
    this.recoveryAttempted = true;
    this.configurationChangePending = false;
    this.clearInitialTimers();
    this.normalizer.rearm();
    if (this.targetSlot) {
      const stale = this.targetSlot;
      this.targetSlot = null;
      this.destroySlot(stale);
    }
    const slot = this.freeSlot();
    this.targetSlot = slot;
    this.prepareSlot(slot, 0);
    this.requestIdr();
    this.reportDiagnostics(true);
    this.failureTimer = setTimeout(() => {
      this.failureTimer = null;
      if (!this.visibleSlot) {
        this.fail(this.failureMessage());
      }
    }, INITIAL_RECOVERY_DELAY_MS);
  }

  private retryTransition(): void {
    if (!this.active || !this.visibleSlot) {
      return;
    }
    if (this.targetSlot && this.targetSlot !== this.visibleSlot) {
      const stale = this.targetSlot;
      this.targetSlot = null;
      this.destroySlot(stale);
    }
    this.clearTransitionTimer();
    this.normalizer.rearm();
    this.configurationChangePending = true;
    this.requestIdr();
    this.scheduleTransitionRetry();
    this.reportDiagnostics(true);
  }

  private startTransitionTimer(): void {
    this.clearTransitionTimer();
    this.transitionTimer = setTimeout(() => {
      this.transitionTimer = null;
      this.retryTransition();
    }, TRANSITION_DECODE_TIMEOUT_MS);
  }

  private scheduleTransitionRetry(): void {
    if (this.transitionRetryTimer || !this.active || !this.visibleSlot) {
      return;
    }
    this.transitionRetryTimer = setTimeout(() => {
      this.transitionRetryTimer = null;
      if (this.active && this.visibleSlot && this.isSwitching()) {
        this.requestIdr();
        this.scheduleTransitionRetry();
      }
    }, TRANSITION_RETRY_DELAY_MS);
  }

  private startStreamTimer(): void {
    if (this.videoSessionId !== undefined) return;
    if (!this.active || !this.portReady || this.packets !== 0 || this.streamTimer) {
      return;
    }
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      if (this.active && this.packets === 0) {
        this.fail(this.failureMessage());
      }
    }, VIDEO_DATA_TIMEOUT_MS);
  }

  private startPlaceholderTimer(): void {
    if (!this.loadPlaceholder) {
      return;
    }
    const generation = this.sessionGeneration;
    this.placeholderTimer = setTimeout(() => {
      this.placeholderTimer = null;
      void this.loadPlaceholder?.()
        .then((placeholder) => this.showPlaceholder(placeholder, generation))
        .catch(() => {
          // The placeholder is best-effort; video recovery continues normally.
        });
    }, PLACEHOLDER_DELAY_MS);
  }

  private async showPlaceholder(
    placeholder: ScreenPlaceholder,
    generation: number
  ): Promise<void> {
    const bitmap = await createImageBitmap(
      new Blob([placeholder.image], { type: placeholder.mimeType })
    );
    if (
      !this.active
      || this.visibleSlot
      || generation !== this.sessionGeneration
    ) {
      bitmap.close();
      return;
    }
    try {
      this.canvas.width = placeholder.width;
      this.canvas.height = placeholder.height;
      const context = this.canvas.getContext("2d");
      if (!context) {
        return;
      }
      context.drawImage(bitmap, 0, 0, placeholder.width, placeholder.height);
      this.placeholderVisible = true;
      this.canvas.hidden = false;
      this.onDimensions(placeholder.width, placeholder.height, "placeholder");
    } finally {
      bitmap.close();
    }
  }

  private freezeVisibleFrame(): boolean {
    const video = this.visibleSlot?.video;
    if (!video || video.hidden || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return false;
    }
    try {
      this.canvas.width = video.videoWidth;
      this.canvas.height = video.videoHeight;
      const context = this.canvas.getContext("2d");
      if (!context) {
        return false;
      }
      context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
      this.canvas.hidden = false;
      video.hidden = true;
      return true;
    } catch {
      return false;
    }
  }

  private fail(message: string): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.clearTimers();
    if (this.videoSessionId !== undefined) this.freezeVisibleFrame(); else this.hideRenderTargets();
    this.onDiagnostics(this.buildDiagnostics("error", message));
  }

  private currentStage(): VideoStage {
    if (!this.portReady) {
      return "waiting-port";
    }
    if (this.visibleSlot) {
      return this.isSwitching() ? "switching" : "decoding";
    }
    if (this.packets === 0) {
      return "waiting-stream";
    }
    const state = this.normalizer.state;
    if (state.framing === "unknown" || !state.hasSps || !state.hasPps) {
      return "waiting-config";
    }
    if (!state.hasIdr) {
      return "waiting-keyframe";
    }
    return "waiting-frame";
  }

  private reportDiagnostics(force = false): void {
    const stage = this.currentStage();
    const now = Date.now();
    if (
      !force
      && stage === this.lastReportedStage
      && now - this.lastDiagnosticsAt < DIAGNOSTIC_INTERVAL_MS
    ) {
      return;
    }
    this.lastReportedStage = stage;
    this.lastDiagnosticsAt = now;
    this.onDiagnostics(this.buildDiagnostics(stage));
  }

  private buildDiagnostics(stage: VideoStage, error?: string): VideoDiagnostics {
    const state = this.normalizer.state;
    return {
      ...(this.videoSessionId !== undefined ? {
        sessionId: this.videoSessionId,
        presentedFrames: this.presentedFrames,
        monitorPlayback: this.monitorPlayback()
      } : {}),
      stage,
      packets: this.packets,
      bytes: this.bytes,
      framing: state.framing,
      hasSps: state.hasSps,
      hasPps: state.hasPps,
      hasIdr: state.hasIdr,
      ...(error ? { error } : {})
    };
  }

  private failureMessage(): string {
    const state = this.normalizer.state;
    if (this.packets === 0) {
      return "视频通道已建立，但渲染进程没有收到视频数据";
    }
    if (state.framing === "unknown") {
      return `已收到 ${this.packets} 个视频包，但无法识别 H.264 数据格式`;
    }
    if (!state.hasSps || !state.hasPps) {
      return `已识别 ${formatFraming(state.framing)}，但没有收到完整的 SPS/PPS`;
    }
    if (!state.hasIdr) {
      return `已识别 ${formatFraming(state.framing)} 和 SPS/PPS，但没有收到关键帧`;
    }
    return "H.264 参数和关键帧均已收到，但 MediaSource 未能渲染首帧";
  }

  private clearInitialTimers(): void {
    if (this.initialRecoveryTimer) {
      clearTimeout(this.initialRecoveryTimer);
      this.initialRecoveryTimer = null;
    }
    if (this.failureTimer) {
      clearTimeout(this.failureTimer);
      this.failureTimer = null;
    }
    if (this.placeholderTimer) {
      clearTimeout(this.placeholderTimer);
      this.placeholderTimer = null;
    }
  }

  private clearTransitionTimer(): void {
    if (this.transitionTimer) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }
  }

  private clearTransitionRetryTimer(): void {
    if (this.transitionRetryTimer) {
      clearTimeout(this.transitionRetryTimer);
      this.transitionRetryTimer = null;
    }
  }

  private clearTransitionTimers(): void {
    this.clearTransitionTimer();
    this.clearTransitionRetryTimer();
  }

  private clearStreamTimer(): void {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.cancelPresentation?.();
    this.cancelPresentation = null;
    this.presentationSerial++;
    this.clearStreamTimer();
    this.clearInitialTimers();
    this.clearTransitionTimers();
  }

  private trackPresentation(slot: DecoderSlot): void {
    this.cancelPresentation?.();
    const serial = ++this.presentationSerial;
    const video = slot.video;
    const generation = slot.generation;
    if (typeof video.requestVideoFrameCallback === "function") {
      let callbackId = 0;
      const presented = () => {
        if (!this.active || serial !== this.presentationSerial || slot.generation !== generation || this.visibleSlot !== slot) return;
        this.presentedFrames++;
        callbackId = video.requestVideoFrameCallback(presented);
      };
      callbackId = video.requestVideoFrameCallback(presented);
      this.cancelPresentation = () => video.cancelVideoFrameCallback(callbackId);
    } else {
      let previous = video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.currentTime;
      const timer = setInterval(() => {
        const current = video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.currentTime;
        if (this.visibleSlot === slot && current !== previous && Number.isFinite(current)) this.presentedFrames++;
        previous = current;
      }, 500);
      this.cancelPresentation = () => clearInterval(timer);
    }
  }

  private hideRenderTargets(): void {
    this.canvas.hidden = true;
    for (const slot of this.slots) {
      slot.video.hidden = true;
    }
  }

  private clearCanvas(): void {
    this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

function joinChunksWithTrailingStartCode(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    TRAILING_START_CODE.byteLength
  );
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  joined.set(TRAILING_START_CODE, offset);
  return joined;
}

function formatFraming(framing: "annex-b" | "avcc"): string {
  return framing === "annex-b" ? "Annex-B" : "AVCC";
}
