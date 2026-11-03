import type { HmRemoteApi } from "../shared/types";

export class ScreenRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private queue = Promise.resolve();
  private completed: Promise<void> | null = null;
  private generation = 0;
  private failure: Error | null = null;
  private queuedBytes = 0;
  busy = false;
  recording = false;

  constructor(
    private readonly api: HmRemoteApi,
    private readonly source: () => HTMLVideoElement | null,
    private readonly canStart: () => boolean,
    private readonly changed: () => void,
    private readonly notify: (message: string) => void
  ) {}

  async start(): Promise<void> {
    if (this.busy || this.recording || !this.canStart()) return;
    const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("当前系统不支持 WebM 录屏");
    this.busy = true;
    const generation = ++this.generation;
    this.changed();
    try {
      const session = await this.api.beginRecording();
      if (!session) return;
      this.sessionId = session.id;
      const video = this.source();
      if (generation !== this.generation || !this.canStart() || !video || !video.videoWidth || !video.videoHeight) {
        await this.api.finishRecording(session.id);
        this.sessionId = null;
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("无法创建录屏画布");
      const paint = () => {
        const current = this.source();
        if (!current || current.readyState < 2 || !current.videoWidth || !current.videoHeight) return;
        // 旋转或折叠后保持文件尺寸，按比例居中，避免画面被拉伸。
        const scale = Math.min(canvas.width / current.videoWidth, canvas.height / current.videoHeight);
        const width = current.videoWidth * scale, height = current.videoHeight * scale;
        context.fillStyle = "black";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(current, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      };
      paint();
      this.stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      this.recorder = recorder;
      this.failure = null;
      this.queuedBytes = 0;
      this.queue = Promise.resolve();
      recorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size) return;
        this.queuedBytes += event.data.size;
        if (this.queuedBytes > 16 * 1024 * 1024) {
          this.failure ??= new Error("录屏保存速度不足，已停止录制");
          if (recorder.state !== "inactive") recorder.stop();
          return;
        }
        this.queue = this.queue.then(async () => {
          if (!this.failure) await this.api.appendRecording(session.id, await event.data.arrayBuffer());
        }).catch((error) => {
          this.failure ??= error instanceof Error ? error : new Error("录屏保存失败");
          if (recorder.state !== "inactive") recorder.stop();
        }).finally(() => { this.queuedBytes -= event.data.size; });
      });
      recorder.addEventListener("error", () => {
        this.failure ??= new Error("录屏编码失败，已结束录制");
        if (recorder.state !== "inactive") recorder.stop();
      });
      this.completed = new Promise<void>((resolve) => {
        recorder.addEventListener("stop", async () => {
          this.busy = true;
          this.recording = false;
          this.changed();
          this.releaseStream();
          try {
            await this.queue;
            const path = await this.api.finishRecording(session.id);
            if (this.failure) throw this.failure;
            if (path) this.notify(`录屏已保存：${path}`);
          } catch (error) { this.notify(error instanceof Error ? error.message : "录屏保存失败"); }
          finally {
            this.recorder = null;
            this.sessionId = null;
            this.completed = null;
            this.busy = false;
            this.changed();
            resolve();
          }
        }, { once: true });
      });
      recorder.start(1_000);
      this.timer = setInterval(paint, 1_000 / 30);
      this.recording = true;
      this.notify("已开始录屏，结束后自动保存到系统视频目录（仅画面，WebM）");
    } catch (error) {
      this.releaseStream();
      if (this.sessionId) await this.api.finishRecording(this.sessionId).catch(() => {});
      this.sessionId = null;
      this.recorder = null;
      this.completed = null;
      this.recording = false;
      throw error;
    } finally { this.busy = false; this.changed(); }
  }

  async stop(): Promise<void> {
    ++this.generation;
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    await this.completed;
  }

  private releaseStream(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}
