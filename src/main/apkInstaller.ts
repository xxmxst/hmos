import { stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { parseDeviceKey, type DeviceInfo } from "../shared/types";

interface ApkAdb {
  listDevices(): Promise<DeviceInfo[]>;
  installApk(serial: string, path: string): Promise<void>;
}

export class ApkInstaller {
  private task: Promise<void> | null = null;

  constructor(private readonly getAdb: () => ApkAdb | null,
    private readonly validateTarget: (serial: string) => void) {}

  get busy(): boolean { return this.task !== null; }

  install(key: unknown, path: unknown): Promise<void> {
    if (this.busy) return Promise.reject(new Error("正在安装 APK，请等待本次安装完成"));
    const task = Promise.resolve().then(() => this.perform(key, path));
    this.task = task;
    void task.finally(() => { if (this.task === task) this.task = null; }).catch(() => {});
    return task;
  }

  async wait(): Promise<void> { await this.task; }

  private async perform(key: unknown, path: unknown): Promise<void> {
    if (typeof key !== "string" || !key.startsWith("adb:")) throw new Error("APK 安装仅支持 Android / ADB 设备");
    const { backend, serial } = parseDeviceKey(key);
    if (backend !== "adb") throw new Error("APK 安装仅支持 Android / ADB 设备");
    if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path) || extname(path).toLowerCase() !== ".apk") {
      throw new Error("请拖入磁盘上的单个 .apk 文件");
    }
    const file = await stat(path).catch(() => { throw new Error("无法读取 APK，请确认文件仍然存在且可访问"); });
    if (!file.isFile() || file.size === 0) throw new Error("APK 文件为空或不是普通文件，请选择有效的安装包");
    this.validateTarget(serial);
    const adb = this.getAdb();
    if (!adb) throw new Error("未找到 ADB，请先配置 Android 投屏工具");
    const device = (await adb.listDevices()).find((item) => item.serial === serial && item.backend === "adb" && item.transport === "USB");
    if (!device) throw new Error("目标 Android 设备已断开，请重新连接后重试");
    if (device.state === "unauthorized") throw new Error("手机尚未授权，请在手机上允许 USB 调试后重试");
    if (device.state !== "ready") throw new Error("目标 Android 设备未就绪，请检查连接后重试");
    this.validateTarget(serial);
    await adb.installApk(serial, path);
  }
}
