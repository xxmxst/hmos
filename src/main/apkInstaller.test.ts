import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DeviceInfo } from "../shared/types";
import { ApkInstaller } from "./apkInstaller";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    if (!resolve(folder).startsWith(resolve(tmpdir(), "hmremote-apk-test-"))) throw new Error("Unexpected test directory");
    await rm(folder, { recursive: true, force: true });
  }
});
const phone = (serial = "one", state: DeviceInfo["state"] = "ready"): DeviceInfo =>
  ({ serial, backend: "adb", state, transport: "USB", rawState: state, label: serial });
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "hmremote-apk-test-"));
  folders.push(folder);
  const path = join(folder, "安装 包.APK");
  await writeFile(path, "test fixture, not a real APK");
  const adb = { listDevices: vi.fn().mockResolvedValue([phone(), phone("two")]), installApk: vi.fn().mockResolvedValue(undefined) };
  const validate = vi.fn();
  const installer = new ApkInstaller(() => adb, validate);
  return { folder, path, adb, validate, installer };
}

describe("APK installation service", () => {
  it("locks the exact chosen device even if more than one Android device is connected", async () => {
    const f = await fixture();
    await f.installer.install("adb:two", f.path);
    expect(f.adb.installApk).toHaveBeenCalledOnce();
    expect(f.adb.installApk).toHaveBeenCalledWith("two", f.path);
    expect(f.installer.busy).toBe(false);
  });
  it("rejects non-Android, invalid keys and invalid paths before calling ADB", async () => {
    const f = await fixture();
    for (const [key, path] of [["hdc:one", f.path], ["one", f.path], ["adb:-all", f.path], [null, f.path],
      ["adb:one", "relative.apk"], ["adb:one", join(f.folder, "test.xapk")], ["adb:one", f.path + "\0"], ["adb:one", null]]) {
      await expect(f.installer.install(key, path)).rejects.toThrow();
    }
    expect(f.adb.listDevices).not.toHaveBeenCalled();
    expect(f.adb.installApk).not.toHaveBeenCalled();
  });
  it("rejects missing, empty and directory files", async () => {
    const f = await fixture();
    await expect(f.installer.install("adb:one", join(f.folder, "missing.apk"))).rejects.toThrow("无法读取");
    await writeFile(f.path, "");
    await expect(f.installer.install("adb:one", f.path)).rejects.toThrow("文件为空");
    const { mkdir } = await import("node:fs/promises");
    const directory = join(f.folder, "folder.apk");
    await mkdir(directory);
    await expect(f.installer.install("adb:one", directory)).rejects.toThrow("普通文件");
    expect(f.adb.installApk).not.toHaveBeenCalled();
  });
  it.each([["unauthorized", "尚未授权"], ["offline", "未就绪"]] as const)("rejects a phone that became %s after selection", async (state, message) => {
    const f = await fixture();
    f.adb.listDevices.mockResolvedValue([phone("one", state)]);
    await expect(f.installer.install("adb:one", f.path)).rejects.toThrow(message);
    expect(f.adb.installApk).not.toHaveBeenCalled();
  });
  it("does not fall back to a different device when the chosen phone detaches", async () => {
    const f = await fixture();
    f.adb.listDevices.mockResolvedValue([phone("two")]);
    await expect(f.installer.install("adb:one", f.path)).rejects.toThrow("已断开");
    expect(f.adb.installApk).not.toHaveBeenCalled();
  });
  it("rechecks session changes after asynchronous device discovery", async () => {
    const f = await fixture();
    f.adb.listDevices.mockImplementation(async () => {
      f.validate.mockImplementation(() => { throw new Error("session changed"); });
      return [phone()];
    });
    await expect(f.installer.install("adb:one", f.path)).rejects.toThrow("session changed");
    expect(f.adb.installApk).not.toHaveBeenCalled();
  });
  it("rejects duplicate installation, lets shutdown wait, and unlocks after failure", async () => {
    const f = await fixture();
    let reject!: (error: Error) => void;
    f.adb.installApk.mockImplementationOnce(() => new Promise<void>((_done, fail) => { reject = fail; }));
    const first = f.installer.install("adb:one", f.path);
    const failure = expect(first).rejects.toThrow("test failure");
    expect(f.installer.busy).toBe(true);
    await expect(f.installer.install("adb:two", f.path)).rejects.toThrow("正在安装");
    await vi.waitFor(() => expect(f.adb.installApk).toHaveBeenCalledOnce());
    const waiting = expect(f.installer.wait()).rejects.toThrow("test failure");
    reject(new Error("test failure"));
    await Promise.all([failure, waiting]);
    expect(f.installer.busy).toBe(false);
    await f.installer.install("adb:two", f.path);
    expect(f.adb.installApk).toHaveBeenCalledTimes(2);
  });
  it("reports missing ADB before attempting installation", async () => {
    const f = await fixture();
    await expect(new ApkInstaller(() => null, () => {}).install("adb:one", f.path)).rejects.toThrow("未找到 ADB");
  });
});
