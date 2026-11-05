import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoDiagnostics, VideoRecoveryRequest } from "../shared/types";
import { TerminalRecoveryError, VideoRecovery } from "./videoRecovery";

const recoveries: VideoRecovery[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { for (const recovery of recoveries.splice(0)) recovery.cancel(); vi.clearAllTimers(); vi.useRealTimers(); });
async function fixture() {
  let visible = true, resetSupported = true;
  const requests: VideoRecoveryRequest[] = [];
  const host = {
    prepare: vi.fn(async (request: VideoRecoveryRequest) => { requests.push(request); }),
    resetVideo: vi.fn(async () => resetSupported), canResetVideo: () => resetSupported,
    verifyDevice: vi.fn(async () => {}), restart: vi.fn(async () => {}),
    visible: () => visible, status: vi.fn(), fatal: vi.fn(async (_message: string) => {})
  };
  const recovery = new VideoRecovery(host);
  recoveries.push(recovery);
  const health = (frames = 1, packets = 1, monitor = true, stage: VideoDiagnostics["stage"] = "decoding", sessionId = recovery.sessionId) => {
    recovery.diagnostics({ sessionId, presentedFrames: frames, monitorPlayback: monitor, packets, bytes: packets * 100,
      stage, framing: "annex-b", hasSps: true, hasPps: true, hasIdr: true });
  };
  const play = () => { recovery.packet(false); health(); };
  await recovery.begin();
  recovery.connectedToSource();
  play();
  return { recovery, host, requests, health, play, setVisible: (v: boolean) => { visible = v; }, setSupported: (v: boolean) => { resetSupported = v; } };
}

describe("Android video recovery", () => {
  it("repairs a stopped decoder while source and renderer packets keep arriving", async () => {
    const f = await fixture();
    f.host.resetVideo.mockImplementation(async () => { f.play(); return true; });
    for (let i = 0; i < 4; i++) { f.recovery.packet(false); f.health(1, i + 2); await vi.advanceTimersByTimeAsync(1000); }
    expect(f.requests.map(r => r.kind)).toEqual(["initial", "decoder"]);
    expect(f.host.restart).not.toHaveBeenCalled();
    expect(f.host.status).toHaveBeenLastCalledWith(false, "Android 投屏中");
  });
  it("repairs MessagePort when source frames advance but renderer packet counters do not", async () => {
    const f = await fixture();
    f.host.resetVideo.mockImplementation(async () => { f.play(); return true; });
    for (let i = 0; i < 4; i++) { f.recovery.packet(false); f.health(1, 1); await vi.advanceTimersByTimeAsync(1000); }
    expect(f.requests[1]?.kind).toBe("port");
    expect(f.host.restart).not.toHaveBeenCalled();
  });
  it("probes silent static content without reconnecting when reset produces a frame", async () => {
    const f = await fixture();
    f.host.resetVideo.mockImplementation(async () => { f.play(); return true; });
    for (let i = 0; i < 25; i++) { f.health(); await vi.advanceTimersByTimeAsync(1000); }
    expect(f.host.resetVideo).toHaveBeenCalledTimes(3);
    expect(f.host.restart).not.toHaveBeenCalled();
    expect(f.host.fatal).not.toHaveBeenCalled();
  });
  it("does not classify quiet video as failure on older scrcpy without RESET_VIDEO", async () => {
    const f = await fixture(); f.setSupported(false);
    for (let i = 0; i < 30; i++) { f.health(); await vi.advanceTimersByTimeAsync(1000); }
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    expect(f.host.restart).not.toHaveBeenCalled();
  });
  it("coalesces faults and retries exactly three times with 1, 2 and 4 second backoff", async () => {
    const f = await fixture();
    f.recovery.request("decoder");
    f.recovery.request("decoder");
    await vi.advanceTimersByTimeAsync(3999);
    expect(f.host.restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.host.restart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(11999);
    expect(f.host.restart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.host.restart).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14000);
    expect(f.host.restart).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.host.fatal).toHaveBeenCalledOnce();
    expect(f.host.fatal.mock.calls[0]?.[0]).toContain("3 次");
    expect(f.recovery.active).toBe(false);
  });
  it("does not let stale session diagnostics complete a new recovery", async () => {
    const f = await fixture(), old = f.recovery.sessionId;
    f.recovery.request("decoder");
    await vi.advanceTimersByTimeAsync(0);
    f.health(100, 100, true, "decoding", old);
    expect(f.recovery.recovering).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.host.restart).toHaveBeenCalledOnce();
    f.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.recovery.recovering).toBe(false);
  });
  it("cancels backoff immediately when the user disconnects", async () => {
    const f = await fixture();
    f.recovery.request("transport");
    await vi.advanceTimersByTimeAsync(500);
    f.recovery.cancel();
    await f.recovery.wait();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.host.restart).not.toHaveBeenCalled();
    expect(f.host.fatal).not.toHaveBeenCalled();
  });
  it("cannot start another session after cancellation during device verification", async () => {
    const f = await fixture();
    let done!: () => void;
    f.host.verifyDevice.mockImplementation(() => new Promise<void>(resolve => { done = resolve; }));
    f.recovery.request("transport");
    await vi.advanceTimersByTimeAsync(1000);
    f.recovery.cancel(); done();
    await f.recovery.wait();
    expect(f.requests).toHaveLength(1);
    expect(f.host.restart).not.toHaveBeenCalled();
  });
  it.each(["原设备已断开", "手机调试授权已失效", "视频协议不兼容"])("stops immediately for terminal failure: %s", async message => {
    const f = await fixture();
    f.host.verifyDevice.mockRejectedValue(new TerminalRecoveryError(message));
    f.recovery.request("transport");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.host.fatal).toHaveBeenCalledWith(message);
    expect(f.host.restart).not.toHaveBeenCalled();
  });
  it("does not monitor playback while hidden or OCR-frozen and gives a foreground grace period", async () => {
    const f = await fixture(); f.setVisible(false);
    for (let i = 0; i < 10; i++) { f.recovery.packet(false); f.health(1, i + 2); await vi.advanceTimersByTimeAsync(1000); }
    f.setVisible(true);
    for (let i = 0; i < 10; i++) { f.recovery.packet(false); f.health(1, i + 12, false); await vi.advanceTimersByTimeAsync(1000); }
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    f.recovery.packet(false); f.health(1, 30, true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    f.recovery.packet(false); f.health(1, 31, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.host.resetVideo).toHaveBeenCalledOnce();
  });
  it("suspends watchdogs across sleep and resumes with ten seconds of grace", async () => {
    const f = await fixture();
    f.recovery.suspend(true);
    await vi.advanceTimersByTimeAsync(60000);
    f.recovery.suspend(false);
    await vi.advanceTimersByTimeAsync(9000);
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    expect(f.host.restart).not.toHaveBeenCalled();
  });
  it("resets the reconnect budget only after sixty seconds of healthy streaming", async () => {
    const f = await fixture();
    f.host.restart.mockImplementation(async () => { f.play(); });
    f.recovery.request("transport"); await vi.advanceTimersByTimeAsync(1000);
    f.recovery.request("transport"); await vi.advanceTimersByTimeAsync(2000);
    expect(f.host.status).toHaveBeenCalledWith(true, expect.stringContaining("2/3"));
    for (let i = 0; i < 62; i++) { f.recovery.packet(false); f.health(i + 2, i + 2); await vi.advanceTimersByTimeAsync(1000); }
    f.host.status.mockClear();
    f.recovery.request("transport"); await vi.advanceTimersByTimeAsync(1000);
    expect(f.host.status).toHaveBeenCalledWith(true, expect.stringContaining("1/3"));
    expect(f.host.fatal).not.toHaveBeenCalled();
  });
  it("does not accept a stale displayed frame when the transport dies during reset", async () => {
    const f = await fixture();
    f.host.resetVideo.mockImplementation(async () => {
      f.recovery.request("transport");
      f.play();
      return true;
    });
    f.recovery.request("decoder");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.host.restart).toHaveBeenCalledOnce();
    expect(f.recovery.recovering).toBe(true);
  });

  it("escalates a repeated decoder failure within the same healthy window instead of resetting forever", async () => {
    const f = await fixture();
    f.host.resetVideo.mockImplementation(async () => { f.play(); return true; });
    f.recovery.request("decoder"); await vi.advanceTimersByTimeAsync(0);
    f.recovery.request("decoder"); await vi.advanceTimersByTimeAsync(1000);
    expect(f.host.resetVideo).toHaveBeenCalledOnce();
    expect(f.host.restart).toHaveBeenCalledOnce();
  });

  it("bounds a stalled resolution switch instead of retrying forever", async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) { f.recovery.packet(false); f.health(1, i + 2, true, "switching"); await vi.advanceTimersByTimeAsync(1000); }
    expect(f.host.resetVideo).toHaveBeenCalledOnce();
  });
});
