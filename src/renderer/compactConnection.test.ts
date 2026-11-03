import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "../shared/types";
import { CompactConnection } from "./compactConnection";

const phone = (serial: string, state: DeviceInfo["state"] = "ready", backend: "adb" | "hdc" = "adb"): DeviceInfo =>
  ({serial,state,backend,transport:"USB",rawState:state,label:serial});
const managers: CompactConnection[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); vi.useRealTimers(); });

function fixture(devices: DeviceInfo[] = [phone("one")]) {
  let busy = false;
  const listDevices = vi.fn<() => Promise<DeviceInfo[]>>().mockResolvedValue(devices);
  const connect = vi.fn<(device: DeviceInfo) => Promise<void>>().mockImplementation(async () => { busy = true; });
  const changed = vi.fn(), scanning = vi.fn(), failed = vi.fn();
  const manager = new CompactConnection({listDevices,isBusy:()=>busy,connect,devicesChanged:changed,scanningChanged:scanning,failed});
  managers.push(manager);
  return {manager,listDevices,connect,changed,scanning,failed,setBusy:(value:boolean)=>{busy=value;}};
}

describe("compact automatic connection", () => {
  it("keeps full mode manual and starts the sole device upon entering compact mode", async () => {
    const f = fixture();
    await f.manager.refresh();
    expect(f.connect).not.toHaveBeenCalled();
    f.manager.setEnabled(true);
    await f.manager.refresh();
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.connect).toHaveBeenCalledWith(phone("one"));
  });

  it("waits for authorization and does not choose between multiple ready devices", async () => {
    const f = fixture([phone("one","unauthorized")]);
    f.manager.setEnabled(true);
    await f.manager.refresh();
    f.listDevices.mockResolvedValue([phone("one"),phone("two","ready","hdc")]);
    await f.manager.refresh();
    expect(f.connect).not.toHaveBeenCalled();
    f.listDevices.mockResolvedValue([phone("one")]);
    await f.manager.refresh();
    expect(f.connect).toHaveBeenCalledOnce();
  });

  it("detects a phone attached after the compact window starts", async () => {
    vi.useFakeTimers();
    const f = fixture([]);
    f.manager.setEnabled(true);
    await f.manager.refresh();
    f.listDevices.mockResolvedValue([phone("one")]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.connect).toHaveBeenCalledOnce();
  });

  it("does not restart a deliberately stopped session until the phone is detached", async () => {
    const f = fixture();
    f.manager.setEnabled(true);
    await f.manager.refresh();
    f.manager.suppressAutomatic();
    f.setBusy(false);
    await f.manager.refresh();
    expect(f.connect).toHaveBeenCalledOnce();
    f.listDevices.mockResolvedValue([]);
    await f.manager.refresh();
    f.listDevices.mockResolvedValue([phone("one")]);
    await f.manager.refresh();
    expect(f.connect).toHaveBeenCalledTimes(2);
  });

  it("preserves connection errors instead of repeatedly retrying the same ready device", async () => {
    const f = fixture();
    f.connect.mockRejectedValue(new Error("connection failed"));
    f.manager.setEnabled(true);
    await f.manager.refresh();
    await f.manager.refresh();
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.changed).toHaveBeenCalledOnce();
    expect(f.failed).toHaveBeenCalledWith(expect.any(Error),"connection");
  });

  it("coalesces scans and does not auto-start from a result received after leaving compact mode", async () => {
    const f = fixture();
    let resolve!: (value:DeviceInfo[])=>void;
    f.listDevices.mockImplementation(()=>new Promise(done=>{resolve=done;}));
    f.manager.setEnabled(true);
    const first = f.manager.refresh();
    expect(f.manager.refresh()).toBe(first);
    expect(f.listDevices).toHaveBeenCalledOnce();
    f.manager.setEnabled(false);
    resolve([phone("one")]);
    await first;
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.manager.scanning).toBe(false);
  });

  it("does not replace a live session's device selection with a stale discovery result", async () => {
    const f = fixture();
    let resolve!: (value:DeviceInfo[])=>void;
    f.listDevices.mockImplementation(()=>new Promise(done=>{resolve=done;}));
    f.manager.setEnabled(true);
    const task = f.manager.refresh();
    f.setBusy(true);
    resolve([phone("one")]);
    await task;
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("recovers from discovery failure without preserving a stale failed selection", async () => {
    const f = fixture();
    await f.manager.refresh();
    f.listDevices.mockRejectedValueOnce(new Error("discovery failed"));
    await f.manager.refresh();
    await f.manager.refresh();
    expect(f.failed).toHaveBeenCalledWith(expect.any(Error),"discovery");
    expect(f.changed).toHaveBeenCalledTimes(2);
  });

  it("stops polling on close and never starts from a pending result after disposal", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (value:DeviceInfo[])=>void;
    f.listDevices.mockImplementation(()=>new Promise(done=>{resolve=done;}));
    f.manager.setEnabled(true);
    const task = f.manager.refresh();
    f.manager.dispose();
    resolve([phone("one")]);
    await task;
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.listDevices).toHaveBeenCalledOnce();
  });
});
