import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RecoveryLog, type RecoveryLogEvent } from "./recoveryLog";

describe("bounded recovery diagnostics", () => {
  it("rotates bounded logs and whitelists values without writing frames, paths or device identifiers", async () => {
    const folder = await mkdtemp(join(tmpdir(), "hmremote-health-log-"));
    try {
      const log = new RecoveryLog(() => join(folder, "video-recovery.log"), 1024);
      const event: RecoveryLogEvent = { event: "suspect", cause: "decoder", sessionId: 1, attempt: 0,
        sourceFrames: 10, packets: 10, presentedFrames: 1, decodedFrames: 1, playbackTime: 1, heartbeatAge: 20, sourceAge: 0 };
      for (let i = 0; i < 50; i++) log.write({ ...event, attempt: i, serial: "private-device", image: "private-image", path: "private-path" } as RecoveryLogEvent);
      await log.flush();
      const files = await readdir(folder);
      expect(files.sort()).toEqual(["video-recovery.log", "video-recovery.log.1"]);
      for (const file of files) {
        expect((await stat(join(folder, file))).size).toBeLessThanOrEqual(1024);
        const contents = await readFile(join(folder, file), "utf8");
        expect(contents).not.toContain("private-");
        for (const line of contents.trim().split("\n")) expect(JSON.parse(line)).toMatchObject({ event: "suspect", cause: "decoder" });
      }
    } finally {
      if (!resolve(folder).startsWith(resolve(tmpdir(), "hmremote-health-log-"))) throw new Error("Unexpected log test directory");
      await rm(folder, { recursive: true, force: true });
    }
  });
});
