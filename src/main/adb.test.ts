import { describe, expect, it } from "vitest";
import { extractAdbPng, parseAdbDevices } from "./adb";
import { discoverDevices } from "./deviceDiscovery";
import { deviceKey } from "../shared/types";

describe("ADB device discovery", () => {
  it("handles Windows USB lists without a usb attribute and keeps authorization states", () => {
    const devices = parseAdbDevices(`List of devices attached\nSERIAL001 device product:huawei model:HOP_LX9 transport_id:1\nSERIAL002 unauthorized\nSERIAL003 offline\nemulator-5554 device model:emulator\n192.168.1.2:5555 device\nadb-serial._adb-tls-connect._tcp device\n* daemon started successfully *\n`);
    expect(devices.map((device) => device.state)).toEqual(["ready", "unauthorized", "offline"]);
    expect(devices[0]?.label).toContain("HOP LX9");
    expect(devices.every((device) => device.backend === "adb")).toBe(true);
  });
  it("keeps Android usable when HDC fails", async () => {
    const adb = { listDevices: async () => parseAdbDevices("same device model:Phone") };
    const devices = await discoverDevices({ listDevices: async () => { throw new Error("HDC failed"); } }, adb);
    expect(devices.map(deviceKey)).toEqual(["adb:same"]);
  });
  it("keeps two protocols distinct even when they report the same serial", async () => {
    const device = parseAdbDevices("same device model:Phone")[0]!;
    const devices = await discoverDevices({ listDevices: async () => [device] }, { listDevices: async () => [device] });
    expect(devices.map(deviceKey)).toEqual(["hdc:same", "adb:same"]);
  });
});

describe("ADB screenshot framing", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
  it("removes Huawei multi-display warnings without modifying PNG bytes", () => {
    expect(extractAdbPng(png)).toEqual(png);
    expect(extractAdbPng(Buffer.concat([Buffer.from("[Warning] Multiple displays were found!\n"), png]))).toEqual(png);
  });
  it("rejects text errors instead of saving corrupt screenshots", () => {
    expect(() => extractAdbPng(Buffer.from("error: device offline"))).toThrow("标准 PNG");
  });
});
