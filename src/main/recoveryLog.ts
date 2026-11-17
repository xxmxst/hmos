import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export type RecoveryLogEvent = {
  event: "suspect" | "probe" | "confirmed" | "repair" | "retry" | "stable" | "failed";
  cause?: "decoder" | "port" | "source" | "transport";
  sessionId: number;
  attempt: number;
  sourceFrames: number;
  packets: number;
  presentedFrames: number;
  decodedFrames: number;
  playbackTime: number;
  heartbeatAge: number;
  sourceAge: number;
};

export class RecoveryLog {
  private queue = Promise.resolve();
  constructor(private readonly destination: () => string, private readonly maxBytes = 256 * 1024) {}

  write(event: RecoveryLogEvent): void {
    // Explicit fields prevent callers from accidentally recording device data.
    const line = JSON.stringify({ time: new Date().toISOString(), event: event.event, cause: event.cause,
      sessionId: event.sessionId, attempt: event.attempt, sourceFrames: event.sourceFrames,
      packets: event.packets, presentedFrames: event.presentedFrames, decodedFrames: event.decodedFrames,
      playbackTime: event.playbackTime, heartbeatAge: event.heartbeatAge, sourceAge: event.sourceAge }) + "\n";
    this.queue = this.queue.then(async () => {
      const path = this.destination();
      await mkdir(dirname(path), { recursive: true });
      const size = await stat(path).then(value => value.size).catch(() => 0);
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        await unlink(`${path}.1`).catch(() => {});
        await rename(path, `${path}.1`).catch(() => {});
      }
      await appendFile(path, line, "utf8");
    }).catch(() => {});
  }

  async flush(): Promise<void> { await this.queue; }
}
