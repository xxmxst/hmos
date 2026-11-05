import { describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "../shared/types";
import { ApkDropInstaller } from "./apkDropInstaller";

function fixture() {
  const surface = new EventTarget();
  let target: DeviceInfo | undefined = { serial: "one", backend: "adb", transport: "USB", state: "ready", rawState: "device", label: "Phone one" };
  let connecting = false;
  const install = vi.fn<(key: string, file: File) => Promise<void>>().mockResolvedValue(undefined);
  const changed = vi.fn(), notify = vi.fn(), beforeInstall = vi.fn();
  const installer = new ApkDropInstaller({ surface, target: () => target, isConnecting: () => connecting, install, changed, notify, beforeInstall });
  const file = (name = "安装 (release).APK") => new File(["test"], name);
  const fire = (type: string, files: File[] = [], types = ["Files"]) => {
    const dataTransfer = { files, types, dropEffect: "none" };
    const event = Object.assign(new Event(type, { cancelable: true }), { dataTransfer });
    surface.dispatchEvent(event);
    return event;
  };
  return { installer, install, changed, notify, beforeInstall, file, fire,
    setTarget: (value: DeviceInfo | undefined) => { target = value; }, setConnecting: () => { connecting = true; } };
}

describe("APK file drag and drop", () => {
  it("handles real drop events, prevents navigation, and forwards the exact File", async () => {
    const f = fixture(), file = f.file();
    expect(f.fire("dragenter").defaultPrevented).toBe(true);
    expect(f.changed).toHaveBeenLastCalledWith(expect.objectContaining({ dragging: true }));
    expect(f.fire("dragover").defaultPrevented).toBe(true);
    expect(f.fire("drop", [file]).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(f.installer.busy).toBe(false));
    expect(f.install).toHaveBeenCalledOnce();
    expect(f.install).toHaveBeenCalledWith("adb:one", file);
    expect(f.beforeInstall).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("安装成功"));
  });
  it("keeps the hint visible across nested elements and clears it on leaving the window", () => {
    const f = fixture();
    f.fire("dragenter"); f.fire("dragenter"); f.fire("dragleave");
    expect(f.changed).toHaveBeenLastCalledWith(expect.objectContaining({ dragging: true }));
    f.fire("dragleave");
    expect(f.changed).toHaveBeenLastCalledWith(expect.objectContaining({ dragging: false }));
    f.installer.dispose();
    f.changed.mockClear();
    f.fire("dragenter");
    expect(f.changed).not.toHaveBeenCalled();
  });
  it("rejects empty, multiple and non-APK drops", async () => {
    const f = fixture();
    for (const files of [[], [f.file(), f.file()], [f.file("app.xapk")], [f.file("app.apk.exe")]]) await f.installer.installFiles(files);
    expect(f.install).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledTimes(4);
  });
  it.each([undefined, { serial: "harmony", backend: "hdc", transport: "USB", state: "ready", rawState: "Ready", label: "Harmony" },
    { serial: "one", backend: "adb", transport: "USB", state: "unauthorized", rawState: "unauthorized", label: "Phone" }] as (DeviceInfo | undefined)[])
    ("rejects unsupported or unauthorized selected devices", async target => {
      const f = fixture(); f.setTarget(target);
      await f.installer.installFiles([f.file()]);
      expect(f.install).not.toHaveBeenCalled();
      expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("已授权"));
    });
  it("waits for device connection to settle before allowing install", async () => {
    const f = fixture(); f.setConnecting();
    await f.installer.installFiles([f.file()]);
    expect(f.install).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("连接完成"));
  });
  it("ignores duplicate drops, preserves the original target and clears busy after an error", async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.install.mockImplementationOnce(() => new Promise<void>((_done, fail) => { reject = fail; }));
    const first = f.installer.installFiles([f.file()]);
    expect(f.installer.busy).toBe(true);
    f.setTarget(undefined);
    await f.installer.installFiles([f.file()]);
    expect(f.install).toHaveBeenCalledOnce();
    expect(f.install.mock.calls[0]?.[0]).toBe("adb:one");
    reject(new Error("phone refused installation"));
    await first;
    expect(f.installer.busy).toBe(false);
    expect(f.notify).toHaveBeenLastCalledWith("phone refused installation");
    expect(f.changed).toHaveBeenLastCalledWith(expect.objectContaining({ busy: false, fileName: "" }));
  });
});
