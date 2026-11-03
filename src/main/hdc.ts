import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { promisify } from "node:util";
import type { DeviceInfo } from "../shared/types";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export class HdcClient {
  constructor(readonly executable: string) {}

  async run(args: string[], timeout = 10_000): Promise<CommandResult> {
    try {
      const result = await execFileAsync(this.executable, args, {
        timeout,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8"
      });
      return {
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim()
      };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: string | number };
      const details = [failure.message, failure.stderr, failure.stdout].filter(Boolean).join("\n");
      throw new Error(details || "HDC 命令执行失败");
    }
  }

  async version(): Promise<string> {
    const result = await this.run(["-v"]);
    return result.stdout || result.stderr;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const result = await this.run(["list", "targets", "-v"]);
    return parseHdcTargets(result.stdout);
  }

  async shell(serial: string, command: string, timeout = 10_000): Promise<string> {
    const result = await this.run(["-t", serial, "shell", command], timeout);
    return result.stdout;
  }

  spawnShell(serial: string, command: string): ChildProcessWithoutNullStreams {
    return spawn(this.executable, ["-t", serial, "shell", command], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
  }

  async sendFile(serial: string, localPath: string, remotePath: string): Promise<void> {
    await this.run(["-t", serial, "file", "send", localPath, remotePath], 30_000);
  }

  async receiveFile(serial: string, remotePath: string, localPath: string): Promise<void> {
    await this.run(["-t", serial, "file", "recv", remotePath, localPath], 30_000);
  }
}

export function parseHdcTargets(output: string): DeviceInfo[] {
  if (!output.trim() || output.includes("[Empty]")) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const columns = line.split(/\s+/);
      const serial = columns[0] ?? "";
      const transport = columns[1] ?? "unknown";
      const rawState = columns[2] ?? "unknown";
      const normalized = rawState.toLowerCase();
      const state: DeviceInfo["state"] =
        normalized.includes("ready") || normalized.includes("connected")
        ? "ready"
        : normalized.includes("offline")
          ? "offline"
          : normalized.includes("unauthor")
            ? "unauthorized"
            : "unknown";
      return {
        serial,
        transport,
        state,
        rawState,
        label: `${maskSerial(serial)} · ${transport} · ${stateLabel(state)}`
      };
    })
    .filter((device) => device.serial.length > 0);
}

function maskSerial(serial: string): string {
  if (serial.length <= 8) {
    return serial;
  }
  return `${serial.slice(0, 4)}…${serial.slice(-4)}`;
}

function stateLabel(state: DeviceInfo["state"]): string {
  switch (state) {
    case "ready":
      return "已就绪";
    case "offline":
      return "离线";
    case "unauthorized":
      return "待授权";
    default:
      return "未知状态";
  }
}

export function parseHdcVersion(text: string): { raw: string; compatible: boolean } {
  const version = text.match(/(\d+)\.(\d+)\.(\d+)([a-z])?/i);
  if (!version) {
    return { raw: text.trim(), compatible: false };
  }
  const major = Number(version[1]);
  const minor = Number(version[2]);
  return {
    raw: version[0],
    compatible: major > 3 || (major === 3 && minor >= 2)
  };
}
