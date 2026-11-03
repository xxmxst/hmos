import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RecordingFile } from "./recordingFile";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    if (!resolve(folder).startsWith(resolve(tmpdir(), "hmremote-recording-test-"))) throw new Error("Unexpected test directory");
    await rm(folder, { recursive: true, force: true });
  }
});
async function output(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "hmremote-recording-test-"));
  folders.push(folder);
  return join(folder, "test.webm");
}
const bytes = (text: string) => Uint8Array.from(Buffer.from(text)).buffer;

describe("recording file lifecycle", () => {
  it("flushes ordered concurrent chunks before closing the file", async () => {
    const file = new RecordingFile(), path = await output(), id = file.begin(path);
    const first = file.append(id, bytes("first")), second = file.append(id, bytes("second"));
    const finished = file.finish(id);
    await Promise.all([first, second]);
    expect(await finished).toBe(path);
    expect((await readFile(path)).toString()).toBe("firstsecond");
    expect(file.active).toBe(false);
  });
  it("does not create an empty file when recording is canceled before the first frame", async () => {
    const file = new RecordingFile(), path = await output(), id = file.begin(path);
    expect(await file.finish(id)).toBeNull();
    await expect(stat(path)).rejects.toThrow();
  });
  it("never overwrites an existing recording", async () => {
    const path = await output();
    await writeFile(path, "original recording");
    const file = new RecordingFile(), id = file.begin(path);
    await expect(file.append(id, bytes("new recording"))).rejects.toThrow("写入失败");
    await expect(file.finish(id)).rejects.toThrow("保存失败");
    expect((await readFile(path)).toString()).toBe("original recording");
    expect(file.active).toBe(false);
  });
  it("rejects expired sessions and frees the session after a disk error", async () => {
    const file = new RecordingFile(), path = await output(), id = file.begin(join(path, "missing", "file.webm"));
    await expect(file.append("old", bytes("bad"))).rejects.toThrow("已失效");
    await expect(file.append(id, bytes("data"))).rejects.toThrow("写入失败");
    await expect(file.finish(id)).rejects.toThrow("保存失败");
    expect(file.active).toBe(false);
  });
});
