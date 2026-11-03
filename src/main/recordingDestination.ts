import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Use the user's Videos directory so installed applications do not need write access beside the executable. */
export async function createRecordingPath(videosDirectory: string): Promise<string> {
  const folder = join(videosDirectory, "鸿蒙投屏助手", "录屏");
  try {
    await mkdir(folder, { recursive: true });
    await access(folder, constants.W_OK);
  } catch {
    throw new Error("无法创建或写入录屏文件夹，请检查系统视频目录的权限和磁盘空间");
  }
  const now = new Date();
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
  return join(folder, `录屏-${date}_${time}-${randomUUID().slice(0, 8)}.webm`);
}
