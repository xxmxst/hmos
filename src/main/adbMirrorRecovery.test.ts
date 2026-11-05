import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MirrorStatus, StartOptions } from "../shared/types";
const { devices } = vi.hoisted(() => ({ devices: vi.fn() }));
vi.mock("./adb", async () => {
  const original = await vi.importActual<typeof import("./adb")>("./adb");
  return { ...original, AdbClient: class { listDevices = devices; } };
});
import { AdbMirror } from "./adbMirror";
import type { VideoRecovery } from "./videoRecovery";
import { TerminalRecoveryError } from "./videoRecovery";

interface Internal {
  major: number; minor: number;
  currentStatus: MirrorStatus;
  desiredOptions: StartOptions;
  controlSocket: unknown;
  recovery: VideoRecovery;
  resetVideo(): Promise<boolean>;
  verifyRecoveryDevice(): Promise<void>;
}
beforeEach(() => { devices.mockReset(); });
function fixture(major = 5, minor = 0) {
  const mirror = new AdbMirror({ adb: "adb.exe", scrcpy: "scrcpy.exe", hdc: null, java: null, bridgeJar: "bridge.jar", sdkJar: "sdk.jar" });
  const internal = mirror as unknown as Internal;
  const messages: Buffer[] = [];
  internal.major = major; internal.minor = minor;
  internal.desiredOptions = { serial: "original-phone", backend: "adb", profileId: "quality" };
  internal.currentStatus = { state: "streaming", message: "streaming", screen: { width: 1080, height: 2400, rotation: 0 } };
  internal.controlSocket = { destroyed: false, writableLength: 0, write: (bytes: Buffer, callback: () => void) => { messages.push(bytes); callback(); } };
  return { mirror, internal, messages };
}
describe("Android video reset compatibility and device binding", () => {
  it.each([[3, 0], [3, 2]])("never sends unsupported reset commands to scrcpy %i.%i", async (major, minor) => {
    const f = fixture(major, minor);
    expect(await f.internal.resetVideo()).toBe(false);
    expect(f.messages).toHaveLength(0);
  });
  it.each([[3, 3], [4, 0], [5, 0]])("sends a rate-limited RESET_VIDEO on scrcpy %i.%i without injecting a phone key", async (major, minor) => {
    const f = fixture(major, minor);
    await f.mirror.requestIdr();
    expect(f.messages).toHaveLength(0);
    expect(await f.internal.resetVideo()).toBe(true);
    expect(await f.internal.resetVideo()).toBe(true);
    expect(f.messages.map(b => [...b])).toEqual([[17]]);
  });
  it("does not switch to another ready device if the original is absent", async () => {
    const f = fixture();
    devices.mockResolvedValue([{ serial: "different-phone", backend: "adb", state: "ready" }]);
    await expect(f.internal.verifyRecoveryDevice()).rejects.toThrow(TerminalRecoveryError);
    expect(f.mirror.serial).toBe("original-phone");
  });
  it("distinguishes original-device authorization loss from a transient video error", async () => {
    const f = fixture();
    devices.mockResolvedValue([{ serial: "original-phone", backend: "adb", state: "unauthorized" }]);
    await expect(f.internal.verifyRecoveryDevice()).rejects.toThrow("授权已失效");
    devices.mockResolvedValue([{ serial: "original-phone", backend: "adb", state: "ready" }]);
    await expect(f.internal.verifyRecoveryDevice()).resolves.toBeUndefined();
  });
  it("allows releasing an existing pointer during recovery but refuses new input", async () => {
    const f = fixture();
    f.internal.recovery.recovering = true;
    await expect(f.mirror.control({ kind: "text", text: "stale" })).rejects.toThrow("尚未就绪");
    await f.mirror.control({ kind: "touch", phase: "up", x: 20, y: 20 });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]?.[0]).toBe(2);
    expect(f.messages[0]?.[1]).toBe(1);
  });
});
