import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseScrcpyVersion } from "./scrcpyProtocol";

const execFileAsync = promisify(execFile);

export async function inspectScrcpy(executable: string): Promise<{ version: string; server: string }> {
  const folder = dirname(executable);
  const server = [join(folder, "scrcpy-server"), join(folder, "scrcpy-server.jar")].find(existsSync);
  if (!server) throw new Error("所选目录缺少 scrcpy-server，请使用官方完整解压目录");
  try {
    const result = await execFileAsync(executable, ["--version"], {
      windowsHide: true, timeout: 5_000, maxBuffer: 128 * 1024, encoding: "utf8"
    });
    return { version: parseScrcpyVersion(result.stdout), server };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("当前支持")) throw error;
    throw new Error("无法读取 scrcpy 版本，请选择官方完整发行版中的 scrcpy.exe");
  }
}
