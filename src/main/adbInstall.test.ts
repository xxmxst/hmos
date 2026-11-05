import { beforeEach, describe, expect, it, vi } from "vitest";
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }), spawn: vi.fn() };
});
import { AdbClient } from "./adb";

beforeEach(() => { execute.mockReset(); });

describe("ADB APK installation", () => {
  it("binds installation to the selected serial and passes a literal file path without a shell", async () => {
    execute.mockResolvedValue({ stdout: "Performing Streamed Install\r\nSuccess\r\n", stderr: "" });
    const path = "D:\\安装 包\\app (release) & test.apk";
    await new AdbClient("adb.exe").installApk("selected-device", path);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("adb.exe", ["-s", "selected-device", "install", "-r", "-t", path],
      { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
  });
  it("rejects invalid serials before spawning ADB", async () => {
    await expect(new AdbClient("adb").installApk("-all", "test.apk")).rejects.toThrow("序列号无效");
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not report success for an empty result or exit-zero Failure", async () => {
    for (const stdout of ["", "Performing Streamed Install", "Success\nFailure [INSTALL_FAILED_VERSION_DOWNGRADE]"]) {
      execute.mockResolvedValue({ stdout, stderr: "" });
      await expect(new AdbClient("adb").installApk("phone", "test.apk")).rejects.toThrow("安装");
    }
  });
  it.each([
    ["INSTALL_FAILED_UPDATE_INCOMPATIBLE", "签名不一致"],
    ["INSTALL_FAILED_VERSION_DOWNGRADE", "版本低于"],
    ["INSTALL_FAILED_INSUFFICIENT_STORAGE", "空间不足"],
    ["INSTALL_FAILED_USER_RESTRICTED", "拒绝或取消"],
    ["INSTALL_FAILED_NO_MATCHING_ABIS", "处理器架构"],
    ["INSTALL_FAILED_OLDER_SDK", "最低版本"],
    ["INSTALL_FAILED_DEPRECATED_SDK_VERSION", "目标系统版本过低"],
    ["INSTALL_FAILED_MISSING_SPLIT", "拆分安装包"],
    ["device offline", "连接已断开"],
    ["device unauthorized", "尚未授权"],
    ["failed to stat private/path.apk", "无法读取 APK"]
  ])("shows an actionable error for %s without disclosing stderr", async (code, expected) => {
    execute.mockRejectedValue({ stderr: `adb: private/path.apk: Failure [${code}]` });
    await expect(new AdbClient("adb").installApk("phone", "test.apk")).rejects.toThrow(expected);
    const error = await new AdbClient("adb").installApk("phone", "test.apk").catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("private/path");
  });
  it("distinguishes missing tools and timeout and never automatically retries", async () => {
    execute.mockRejectedValueOnce({ code: "ENOENT" }).mockRejectedValueOnce({ killed: true });
    const adb = new AdbClient("adb");
    await expect(adb.installApk("phone", "test.apk")).rejects.toThrow("未找到 ADB");
    await expect(adb.installApk("phone", "test.apk")).rejects.toThrow("手机可能仍在处理");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
