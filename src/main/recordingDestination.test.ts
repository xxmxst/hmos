import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRecordingPath } from "./recordingDestination";
import { RecordingFile } from "./recordingFile";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    if (!resolve(folder).startsWith(resolve(tmpdir(), "hmremote-auto-recording-"))) throw new Error("Unexpected test directory");
    await rm(folder, { recursive: true, force: true });
  }
});

async function videos(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "hmremote-auto-recording-"));
  folders.push(folder);
  return folder;
}

describe("automatic recording destination", () => {
  it("creates the default folder without creating an empty recording", async () => {
    const root = await videos();
    const path = await createRecordingPath(root);
    expect(dirname(path)).toBe(join(root, "鸿蒙投屏助手", "录屏"));
    expect(basename(path)).toMatch(/^录屏-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}-[a-f0-9]{8}\.webm$/);
    expect(await readdir(dirname(path))).toEqual([]);
  });

  it("saves successive sessions to different files in the same folder", async () => {
    const root = await videos();
    const paths = await Promise.all([createRecordingPath(root), createRecordingPath(root)]);
    expect(paths[0]).not.toBe(paths[1]);
    const recording = new RecordingFile();
    for (const [index, path] of paths.entries()) {
      const id = recording.begin(path);
      await recording.append(id, Uint8Array.from(Buffer.from(`session-${index}`)).buffer);
      expect(await recording.finish(id)).toBe(path);
    }
    expect((await readFile(paths[0]!)).toString()).toBe("session-0");
    expect((await readFile(paths[1]!)).toString()).toBe("session-1");
  });

  it("reports a useful error when the destination cannot be created", async () => {
    const root = await videos();
    const blocker = join(root, "鸿蒙投屏助手");
    await writeFile(blocker, "existing file");
    await expect(createRecordingPath(root)).rejects.toThrow("检查系统视频目录的权限和磁盘空间");
    expect((await readFile(blocker)).toString()).toBe("existing file");
  });
});
