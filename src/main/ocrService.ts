import { app, nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createWorker, OEM, PSM, type LoggerMessage, type Worker } from "tesseract.js";
import type {
  OcrFallbackFrame,
  OcrProgress,
  OcrResult,
  OcrSnapshot
} from "../shared/types";
import type { HdcClient } from "./hdc";
import type { CapturedDeviceSnapshot } from "./deviceSnapshot";
import { parseOcrBlocks, parseOcrTsv } from "./ocrText";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;

interface StoredSnapshot {
  id: string;
  image: Buffer;
  mimeType: "image/png" | "image/jpeg";
  source: "device" | "video";
  width: number;
  height: number;
  warning?: string;
}

export class OcrService {
  private snapshot: StoredSnapshot | null = null;
  private worker: Worker | null = null;
  private workerPromise: Promise<Worker> | null = null;
  private progressSnapshotId: string | null = null;
  private generation = 0;
  private workerEpoch = 0;

  constructor(
    private readonly hdc: HdcClient | null,
    private readonly onProgress: (progress: OcrProgress) => void,
    private readonly captureSnapshot?: (serial: string) => Promise<CapturedDeviceSnapshot>
  ) {}

  async capture(serial: string, fallback?: OcrFallbackFrame): Promise<OcrSnapshot> {
    if (this.snapshot || this.progressSnapshotId || this.workerPromise) {
      await this.cancel();
    } else {
      this.generation++;
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(serial)) {
      throw new Error("设备序列号无效");
    }

    let stored: StoredSnapshot;
    try {
      stored = await this.captureFromDevice(serial);
    } catch (error) {
      if (!fallback) {
        throw new Error(`无法截取手机画面：${errorMessage(error)}`);
      }
      stored = this.captureFromFallback(fallback, `高清截图不可用，已使用当前投屏帧：${errorMessage(error)}`);
    }
    this.snapshot = stored;
    return publicSnapshot(stored);
  }

  async recognize(snapshotId: string): Promise<OcrResult> {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.id !== snapshotId) {
      throw new Error("OCR 截图已失效，请重新识字");
    }
    const generation = ++this.generation;
    this.progressSnapshotId = snapshotId;
    const startedAt = Date.now();
    this.publishProgress(snapshotId, "正在加载离线识别引擎", 0);
    try {
      const worker = await this.getWorker();
      this.ensureCurrent(snapshotId, generation);
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: "1",
        user_defined_dpi: "300"
      });
      this.ensureCurrent(snapshotId, generation);
      const recognition = await worker.recognize(snapshot.image, {}, {
        text: true,
        tsv: true,
        blocks: true
      });
      this.ensureCurrent(snapshotId, generation);
      const blockLines = parseOcrBlocks(
        recognition.data.blocks,
        snapshot.width,
        snapshot.height
      );
      const lines = blockLines.length > 0
        ? blockLines
        : parseOcrTsv(recognition.data.tsv ?? "", snapshot.width, snapshot.height);
      this.snapshot = null;
      this.publishProgress(snapshotId, "识别完成", 1);
      return {
        snapshotId,
        text: lines.map((line) => line.text).join("\n"),
        lines,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      if (generation !== this.generation) {
        throw new Error("OCR 已取消");
      }
      await this.resetWorker();
      throw new Error(`文字识别失败：${errorMessage(error)}`);
    } finally {
      if (this.progressSnapshotId === snapshotId) {
        this.progressSnapshotId = null;
      }
    }
  }

  async cancel(snapshotId?: string): Promise<void> {
    if (snapshotId && this.snapshot && this.snapshot.id !== snapshotId) {
      return;
    }
    this.generation++;
    this.snapshot = null;
    this.progressSnapshotId = null;
    await this.resetWorker();
  }

  async dispose(): Promise<void> {
    await this.cancel();
  }

  private async captureFromDevice(serial: string): Promise<StoredSnapshot> {
    if (this.captureSnapshot) return { ...await this.captureSnapshot(serial), source: "device" };
    if (!this.hdc) {
      throw new Error("HDC 不可用");
    }
    const id = randomUUID();
    const remotePath = `/data/local/tmp/hmremote-ocr-${id}.jpeg`;
    const temporaryDirectory = join(app.getPath("temp"), "hmremote-ocr");
    const localPath = join(temporaryDirectory, `${id}.jpeg`);
    await mkdir(temporaryDirectory, { recursive: true });
    try {
      await this.hdc.shell(serial, `snapshot_display -f ${remotePath}`, 20_000);
      await this.hdc.receiveFile(serial, remotePath, localPath);
      const image = await readFile(localPath);
      const dimensions = validateImage(image, "image/jpeg");
      return {
        id,
        image,
        mimeType: "image/jpeg",
        source: "device",
        ...dimensions
      };
    } finally {
      await Promise.allSettled([
        this.hdc.shell(serial, `rm -f ${remotePath}`, 5_000),
        rm(localPath, { force: true })
      ]);
    }
  }

  private captureFromFallback(fallback: OcrFallbackFrame, warning: string): StoredSnapshot {
    if (!(fallback.image instanceof ArrayBuffer)) {
      throw new Error("当前投屏帧格式无效");
    }
    if (fallback.mimeType !== "image/png" && fallback.mimeType !== "image/jpeg") {
      throw new Error("当前投屏帧类型无效");
    }
    const image = Buffer.from(fallback.image);
    const dimensions = validateImage(image, fallback.mimeType);
    return {
      id: randomUUID(),
      image,
      mimeType: fallback.mimeType,
      source: "video",
      warning,
      ...dimensions
    };
  }

  private async getWorker(): Promise<Worker> {
    if (this.worker) {
      return this.worker;
    }
    if (!this.workerPromise) {
      const epoch = this.workerEpoch;
      const pendingWorker = createWorker(["chi_sim", "eng"], OEM.LSTM_ONLY, {
        langPath: resolveLanguagePath(),
        cacheMethod: "none",
        gzip: true,
        logger: (message) => this.handleLoggerMessage(message),
        errorHandler: (error) => console.error(`[ocr] ${errorMessage(error)}`)
      }).then(async (worker) => {
        if (epoch !== this.workerEpoch) {
          await worker.terminate().catch(() => undefined);
          throw new Error("OCR 已取消");
        }
        this.worker = worker;
        return worker;
      });
      this.workerPromise = pendingWorker;
    }
    const pendingWorker = this.workerPromise;
    try {
      return await pendingWorker;
    } finally {
      if (this.workerPromise === pendingWorker) {
        this.workerPromise = null;
      }
    }
  }

  private handleLoggerMessage(message: LoggerMessage): void {
    const snapshotId = this.progressSnapshotId;
    if (!snapshotId) {
      return;
    }
    this.publishProgress(snapshotId, localizeStatus(message.status), message.progress);
  }

  private publishProgress(snapshotId: string, status: string, progress: number): void {
    this.onProgress({
      snapshotId,
      status: status.slice(0, 80),
      progress: Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0))
    });
  }

  private ensureCurrent(snapshotId: string, generation: number): void {
    if (generation !== this.generation || this.snapshot?.id !== snapshotId) {
      throw new Error("OCR 已取消");
    }
  }

  private async resetWorker(): Promise<void> {
    this.workerEpoch++;
    const readyWorker = this.worker;
    const pendingWorker = this.workerPromise;
    this.worker = null;
    this.workerPromise = null;
    if (readyWorker) {
      await readyWorker.terminate().catch(() => undefined);
    } else if (pendingWorker) {
      await pendingWorker.then((worker) => worker.terminate()).catch(() => undefined);
    }
  }
}

function validateImage(
  image: Buffer,
  declaredMimeType: "image/png" | "image/jpeg"
): { width: number; height: number } {
  if (image.byteLength === 0 || image.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("截图为空或超过 25 MiB");
  }
  const isPng = image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  if ((declaredMimeType === "image/png" && !isPng) || (declaredMimeType === "image/jpeg" && !isJpeg)) {
    throw new Error("截图文件格式与声明类型不一致");
  }
  const size = nativeImage.createFromBuffer(image).getSize();
  if (size.width <= 0 || size.height <= 0 || size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new Error("截图尺寸无效或超过 2000 万像素");
  }
  return size;
}

function publicSnapshot(snapshot: StoredSnapshot): OcrSnapshot {
  const bytes = Uint8Array.from(snapshot.image);
  return {
    id: snapshot.id,
    image: bytes.buffer,
    mimeType: snapshot.mimeType,
    source: snapshot.source,
    width: snapshot.width,
    height: snapshot.height,
    ...(snapshot.warning ? { warning: snapshot.warning } : {})
  };
}

function resolveLanguagePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "ocr", "tessdata")
    : join(__dirname, "../ocr/tessdata");
}

function localizeStatus(status: string): string {
  const labels: Record<string, string> = {
    "loading tesseract core": "正在加载 OCR 核心",
    "initializing tesseract": "正在初始化 OCR",
    "loading language traineddata": "正在加载中英文离线字库",
    "initializing api": "正在初始化识别器",
    "recognizing text": "正在识别文字"
  };
  return labels[status] ?? "正在识别文字";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
