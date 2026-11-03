import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceInfo } from "../shared/types";

const execFileAsync = promisify(execFile);

export class AdbClient {
  constructor(readonly executable: string) {}

  async run(args: string[], timeout = 10_000): Promise<string> {
    try {
      const result = await execFileAsync(this.executable, args, {
        windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8"
      });
      return result.stdout.trim();
    } catch (error) {
      throw adbError(error);
    }
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return parseAdbDevices(await this.run(["devices", "-l"]));
  }

  async capturePng(serial: string): Promise<Buffer> {
    validateAdbSerial(serial);
    try {
      const result = await execFileAsync(this.executable, ["-s", serial, "exec-out", "screencap", "-p"], {
        windowsHide: true, timeout: 20_000, maxBuffer: 25 * 1024 * 1024, encoding: "buffer"
      });
      return extractAdbPng(result.stdout);
    } catch (error) {
      throw adbError(error);
    }
  }

  async push(serial: string, local: string, remote: string): Promise<void> {
    validateAdbSerial(serial);
    await this.run(["-s", serial, "push", local, remote], 30_000);
  }

  spawnServer(serial: string, args: string[]): ChildProcessWithoutNullStreams {
    validateAdbSerial(serial);
    return spawn(this.executable, ["-s", serial, "shell", ...args], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
  }
}

export function validateAdbSerial(serial: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(serial) || serial.startsWith("-")) {
    throw new Error("ADB 设备序列号无效");
  }
}

export function parseAdbDevices(output: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|no permissions)(?:\s|$)/.exec(line.trim());
    if (!match) continue;
    const serial = match[1]!;
    // 本次仅接入 USB，不把模拟器或已配对的无线设备混入 USB 列表。
    if (serial.startsWith("emulator-") || serial.includes(":") || serial.includes("_adb-tls-")) continue;
    const rawState = match[2]!;
    const state: DeviceInfo["state"] = rawState === "device" ? "ready"
      : rawState === "offline" ? "offline" : rawState === "unauthorized" ? "unauthorized" : "unknown";
    const model = /\bmodel:(\S+)/.exec(line)?.[1]?.replace(/_/g, " ");
    const masked = serial.length > 8 ? `${serial.slice(0, 4)}…${serial.slice(-4)}` : serial;
    const stateLabel = state === "ready" ? "已就绪" : state === "offline" ? "离线"
      : state === "unauthorized" ? "待授权" : "未知状态";
    devices.push({ serial, backend: "adb", transport: "USB", state, rawState,
      label: `Android · ${model ?? masked} · ${stateLabel}` });
  }
  return devices;
}

export function extractAdbPng(output: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const offset = output.indexOf(signature);
  // 部分华为系统把多显示器 Warning 写入 stdout，PNG 本体紧随其后。
  if (offset >= 0 && offset <= 4096 && (offset === 0 || output.toString("utf8", 0, offset).startsWith("[Warning]"))) {
    return output.subarray(offset);
  }
  throw new Error("手机没有返回标准 PNG 截图");
}

function adbError(error: unknown): Error {
  const failure = error as { code?: string | number; killed?: boolean; stderr?: string | Buffer };
  if (failure.code === "ENOENT") return new Error("未找到 ADB，请重新配置 Android 投屏工具");
  if (failure.killed) return new Error("ADB 操作超时，请检查手机连接后重试");
  if (String(failure.stderr ?? "").includes("unauthorized")) {
    return new Error("手机尚未授权，请在手机上允许 USB 调试");
  }
  return new Error("ADB 操作失败，请检查数据线、手机连接与 USB 调试授权");
}
