import { randomUUID } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";

interface RecordingSession {
  id: string;
  path: string;
  file: FileHandle | null;
  queue: Promise<void>;
  queuedBytes: number;
  bytes: number;
  finishing: boolean;
  failed: boolean;
}

/** 分块写入，不在内存中累计整段录屏；首次收到数据后才创建文件。 */
export class RecordingFile {
  private session: RecordingSession | null = null;
  get active(): boolean { return this.session !== null; }

  begin(path: string): string {
    if (this.session) throw new Error("已有录屏正在保存，请稍候");
    const id = randomUUID();
    this.session = { id, path, file: null, queue: Promise.resolve(), queuedBytes: 0,
      bytes: 0, finishing: false, failed: false };
    return id;
  }

  async append(id: string, data: ArrayBuffer): Promise<void> {
    const session = this.requireSession(id);
    if (session.finishing || session.failed) throw new Error("录屏已停止或文件写入失败");
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > 8 * 1024 * 1024) {
      throw new Error("录屏数据块无效或超过 8 MiB");
    }
    if (session.queuedBytes + data.byteLength > 16 * 1024 * 1024) {
      throw new Error("录屏写入速度不足，请检查磁盘空间后重试");
    }
    session.queuedBytes += data.byteLength;
    const task = session.queue.then(async () => {
      if (session.failed) throw new Error("录屏文件写入失败");
      session.file ??= await open(session.path, "wx");
      await session.file.writeFile(Buffer.from(data));
      session.bytes += data.byteLength;
    }).catch(() => {
      session.failed = true;
      throw new Error("录屏文件写入失败，请检查保存位置和磁盘空间");
    }).finally(() => { session.queuedBytes -= data.byteLength; });
    session.queue = task.catch(() => {});
    await task;
  }

  async finish(id: string): Promise<string | null> {
    const session = this.requireSession(id);
    session.finishing = true;
    try {
      await session.queue;
      if (session.file) await session.file.sync();
      if (session.failed) throw new Error("录屏保存失败，文件可能不完整，请检查磁盘空间");
      return session.bytes ? session.path : null;
    } finally {
      try { await session.file?.close(); } finally { if (this.session === session) this.session = null; }
    }
  }

  private requireSession(id: string): RecordingSession {
    if (!this.session || this.session.id !== id) throw new Error("录屏会话已失效");
    return this.session;
  }
}
