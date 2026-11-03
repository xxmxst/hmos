import { afterEach, describe, expect, it, vi } from "vitest";
import { MirrorBridge } from "./mirrorBridge";
import type { BridgeJsonMessage } from "./protocol";

function fixture() {
  const bridge = new MirrorBridge({
    hdc: "hdc.exe",
    java: "java.exe",
    bridgeJar: "bridge.jar",
    sdkJar: "sdk.jar"
  });
  const target = bridge as unknown as {
    currentSerial: string | null;
    currentStatus: typeof bridge.status;
    handleJson(message: BridgeJsonMessage): void;
    markCaptureRecovered(): void;
  };
  target.currentSerial = "device";
  target.currentStatus = {
    state: "connecting",
    message: "正在启动投屏服务…",
    video: {
      stage: "waiting-stream",
      packets: 0,
      bytes: 0,
      framing: "unknown",
      hasSps: false,
      hasPps: false,
      hasIdr: false
    }
  };
  return { bridge, target };
}

describe("MirrorBridge capture recovery", () => {
  it("does not substitute the Power key for unsupported physical display power control", async () => {
    const { bridge } = fixture();
    await expect(bridge.control({kind:"screen-power",on:false})).rejects.toThrow("鸿蒙通道暂不支持灭屏投屏");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a recoverable SDK error alive until ready arrives", async () => {
    vi.useFakeTimers();
    const { bridge, target } = fixture();

    target.handleJson({
      type: "event",
      event: "error",
      message: "UNAVAILABLE: io exception",
      code: "UNAVAILABLE",
      recoverable: true
    });
    expect(bridge.status).toMatchObject({
      state: "reconnecting",
      video: { packets: 0, framing: "unknown" }
    });

    await vi.advanceTimersByTimeAsync(4_000);
    target.handleJson({ type: "event", event: "ready", width: 1264, height: 1848 });
    await vi.advanceTimersByTimeAsync(11_999);

    expect(bridge.status).toMatchObject({
      state: "waiting-video",
      screen: { width: 1264, height: 1848 },
      video: { packets: 0 }
    });
    target.markCaptureRecovered();
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.status.state).toBe("waiting-video");

  });

  it("fails instead of waiting forever when ready produces no video packet", async () => {
    vi.useFakeTimers();
    const { bridge, target } = fixture();

    target.handleJson({
      type: "event",
      event: "ready",
      width: 1264,
      height: 1848
    });
    await vi.advanceTimersByTimeAsync(12_000);

    expect(bridge.status).toMatchObject({
      state: "error",
      video: { stage: "error", packets: 0 }
    });
    expect(bridge.serial).toBeNull();
  });
  it("accepts the first video packet as recovery even if ready is missing", async () => {
    vi.useFakeTimers();
    const { bridge, target } = fixture();

    target.handleJson({
      type: "event",
      event: "error",
      message: "UNAVAILABLE: io exception",
      recoverable: true
    });
    target.markCaptureRecovered();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(bridge.status).toMatchObject({
      state: "waiting-video",
      message: expect.stringContaining("已恢复")
    });
  });

  it("turns an unrecovered transient error into a terminal error after 12 seconds", async () => {
    vi.useFakeTimers();
    const { bridge, target } = fixture();

    target.handleJson({
      type: "event",
      event: "error",
      message: "UNAVAILABLE: io exception",
      recoverable: true
    });
    await vi.advanceTimersByTimeAsync(12_000);

    expect(bridge.status).toMatchObject({
      state: "error",
      message: expect.stringContaining("兼容模式启动超时"),
      video: { stage: "error", packets: 0 }
    });
    expect(bridge.serial).toBeNull();
  });

  it("fails non-recoverable SDK errors immediately", async () => {
    const { bridge, target } = fixture();

    target.handleJson({
      type: "event",
      event: "error",
      message: "system version is not supported",
      recoverable: false
    });
    await Promise.resolve();

    expect(bridge.status).toMatchObject({
      state: "error",
      message: "system version is not supported"
    });
  });

  it("keeps the session streaming while a standby decoder adapts the fold size", () => {
    const { bridge } = fixture();

    bridge.updateVideoDiagnostics({
      stage: "switching",
      packets: 20,
      bytes: 4096,
      framing: "annex-b",
      hasSps: true,
      hasPps: true,
      hasIdr: true
    });

    expect(bridge.status).toMatchObject({
      state: "streaming",
      message: "正在适配折叠屏画面…",
      video: { stage: "switching" }
    });
  });
});
