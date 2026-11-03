import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CaptureRecoveryGate,
  friendlyCaptureError,
  isRecoverableCaptureError
} from "./captureRecovery";

describe("capture transport recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("classifies the SDK startup UNAVAILABLE error as recoverable", () => {
    expect(isRecoverableCaptureError("UNAVAILABLE: io exception")).toBe(true);
    expect(isRecoverableCaptureError("permission denied")).toBe(false);
    expect(isRecoverableCaptureError("temporary SDK error", true)).toBe(true);
  });

  it("allows the SDK fallback window and cancels the deadline after recovery", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const gate = new CaptureRecoveryGate(onTimeout);

    expect(gate.begin("UNAVAILABLE: io exception")).toBe(true);
    expect(gate.active).toBe(true);
    await vi.advanceTimersByTimeAsync(4_000);
    gate.awaitFirstFrame("first frame timeout");
    await vi.advanceTimersByTimeAsync(11_999);
    expect(onTimeout).not.toHaveBeenCalled();
    gate.recovered();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(gate.active).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("shares one deadline across repeated transient failures", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const gate = new CaptureRecoveryGate(onTimeout);

    gate.begin("UNAVAILABLE: io exception");
    await vi.advanceTimersByTimeAsync(3_000);
    gate.begin("UNAVAILABLE: connection reset");
    await vi.advanceTimersByTimeAsync(9_000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith({
      kind: "transport",
      message: "UNAVAILABLE: connection reset"
    });
    expect(gate.active).toBe(false);
  });


  it("times out when ready arrives but the first video packet does not", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const gate = new CaptureRecoveryGate(onTimeout);

    gate.awaitFirstFrame("first frame timeout");
    await vi.advanceTimersByTimeAsync(12_000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith({
      kind: "first-frame",
      message: "first frame timeout"
    });
    expect(gate.active).toBe(false);
  });
  it("does not delay non-recoverable errors", () => {
    const onTimeout = vi.fn();
    const gate = new CaptureRecoveryGate(onTimeout);

    expect(gate.begin("system version is not supported", false)).toBe(false);
    expect(gate.active).toBe(false);
    expect(friendlyCaptureError("UNAVAILABLE: io exception")).toContain("重新连接");
  });
});
