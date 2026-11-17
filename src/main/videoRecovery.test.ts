import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoDiagnostics, VideoHealthSample, VideoRecoveryRequest } from "../shared/types";
import { TerminalRecoveryError, VideoRecovery } from "./videoRecovery";

const sessions: VideoRecovery[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { for (const session of sessions.splice(0)) session.cancel(); vi.clearAllTimers(); vi.useRealTimers(); });

async function fixture() {
  let visible = true;
  const state = { frames: 1, decoded: 1, time: 1, packets: 1, ready: true, monitor: true };
  const requests: VideoRecoveryRequest[] = [];
  let recovery!: VideoRecovery;
  const diagnostics = (): VideoDiagnostics => ({ sessionId: recovery.sessionId, presentedFrames: state.frames,
    decodedFrames: state.decoded, playbackTime: state.time, frameReady: state.ready, monitorPlayback: state.monitor,
    frameWidth: 1080, frameHeight: 2400, stage: state.ready ? "decoding" : "waiting-frame",
    packets: state.packets, bytes: state.packets * 100, framing: "annex-b", hasSps: true, hasPps: true, hasIdr: true });
  const play = () => { state.ready = true; state.frames++; state.decoded++; state.time++; state.packets++; recovery.packet(false); recovery.diagnostics(diagnostics()); };
  const host = {
    prepare: vi.fn(async (request: VideoRecoveryRequest) => {
      requests.push(request);
      if (request.kind !== "initial") { state.frames = state.decoded = state.time = state.packets = 0; state.ready = false; }
    }),
    rebindPort: vi.fn(async () => {}),
    resetVideo: vi.fn(async () => { play(); return true; }),
    probe: vi.fn<(capture: boolean) => Promise<VideoHealthSample | null>>().mockImplementation(async () => ({ diagnostics: diagnostics(), comparison: "same" })),
    verifyDevice: vi.fn(async () => {}), restart: vi.fn(async () => { play(); }),
    visible: () => visible, status: vi.fn(), fatal: vi.fn(async (_message: string) => {}), log: vi.fn()
  };
  recovery = new VideoRecovery(host); sessions.push(recovery);
  await recovery.begin(); recovery.connectedToSource(); recovery.packet(false); recovery.diagnostics(diagnostics());
  async function advance(seconds: number, options: { source?: boolean; receive?: boolean; frames?: boolean; decoded?: boolean; time?: boolean; heartbeat?: boolean } = {}) {
    for (let second = 0; second < seconds; second++) {
      if (options.source) recovery.packet(false);
      if (options.receive) state.packets++;
      if (options.frames) state.frames++;
      if (options.decoded) state.decoded++;
      if (options.time) state.time++;
      if (options.heartbeat !== false) recovery.diagnostics(diagnostics());
      await vi.advanceTimersByTimeAsync(1000);
    }
  }
  const flowing = { source: true, receive: true, frames: true, decoded: true, time: true };
  return { recovery, state, host, requests, diagnostics, advance, flowing, play, setVisible: (v: boolean) => { visible = v; } };
}

describe("video detection without disturbing healthy playback", () => {
  it("keeps a static screen unchanged for two minutes and rate-limits read-only probes", async () => {
    const f = await fixture();
    await f.advance(59);
    expect(f.host.probe).not.toHaveBeenCalled();
    await f.advance(1);
    expect(f.host.probe.mock.calls).toEqual([[true]]);
    await f.advance(59);
    expect(f.host.probe).toHaveBeenCalledTimes(1);
    await f.advance(1);
    expect(f.host.probe).toHaveBeenCalledTimes(2);
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    expect(f.host.rebindPort).not.toHaveBeenCalled();
    expect(f.host.restart).not.toHaveBeenCalled();
    expect(f.requests.map(r => r.kind)).toEqual(["initial"]);
    expect(f.host.status).not.toHaveBeenCalled();
  });
  it("does not treat a single late tail packet as continuous video input", async () => {
    const f = await fixture(); await f.advance(1);
    f.recovery.packet(false); f.state.packets++;
    await f.advance(59);
    expect(f.host.probe).not.toHaveBeenCalled();
    await f.advance(1);
    expect(f.host.probe.mock.calls).toEqual([[true]]);
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    expect(f.host.restart).not.toHaveBeenCalled();
  });
  it.each(["decoded", "time"] as const)("accepts %s progress when presentation callbacks pause", async signal => {
    const f = await fixture();
    await f.advance(40, { source: true, receive: true, [signal]: true });
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    expect(f.host.restart).not.toHaveBeenCalled();
  });
  it("does not misclassify low frame rate or a three-second callback gap", async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) { f.play(); await f.advance(4); }
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    expect(f.host.rebindPort).not.toHaveBeenCalled();
  });
  it("uses responsive IPC to recheck delayed heartbeats without restarting video", async () => {
    const f = await fixture();
    await f.advance(15, { ...f.flowing, heartbeat: false });
    expect(f.host.probe).toHaveBeenCalled();
    expect(f.host.rebindPort).not.toHaveBeenCalled();
    expect(f.host.resetVideo).not.toHaveBeenCalled();
  });
  it("waits for an unresponsive renderer instead of restarting a healthy phone service", async () => {
    const f = await fixture(); f.host.probe.mockResolvedValue(null);
    await f.advance(30, { source: true, heartbeat: false });
    expect(f.host.restart).not.toHaveBeenCalled();
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    expect(f.host.fatal).not.toHaveBeenCalled();
  });
  it("requires two quiet-screen comparisons that both confirm a changed phone picture", async () => {
    const f = await fixture();
    f.host.probe.mockImplementation(async () => ({ diagnostics: f.diagnostics(), comparison: "different" }));
    await f.advance(60);
    expect(f.host.probe.mock.calls).toEqual([[true]]);
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    await f.advance(1);
    expect(f.host.resetVideo).toHaveBeenCalledOnce();
    expect(f.host.probe).toHaveBeenCalledTimes(2);
  });
  it("skips the confirmation screenshot when video packets resume", async () => {
    const f = await fixture();
    f.host.probe.mockImplementation(async () => ({ diagnostics: f.diagnostics(), comparison: "different" }));
    await f.advance(60);
    expect(f.host.probe.mock.calls).toEqual([[true]]);
    f.play();
    await f.advance(1);
    expect(f.host.probe).toHaveBeenCalledTimes(1);
    expect(f.host.resetVideo).not.toHaveBeenCalled();
  });
  it.each(["same", "unknown"] as const)("cancels the quiet suspicion if the second comparison is %s", async comparison => {
    const f = await fixture(); let calls = 0;
    f.host.probe.mockImplementation(async () => ({ diagnostics: f.diagnostics(), comparison: ++calls === 1 ? "different" : comparison }));
    await f.advance(61);
    expect(f.host.probe).toHaveBeenCalledTimes(2);
    expect(f.host.resetVideo).not.toHaveBeenCalled();
  });
  it("tolerates unavailable ADB screenshots", async () => {
    const f = await fixture(); f.host.probe.mockRejectedValue(new Error("capture unavailable"));
    await f.advance(120);
    expect(f.host.probe).toHaveBeenCalledTimes(2);
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    expect(f.host.fatal).not.toHaveBeenCalled();
  });
  it("confirms a continuously fed stalled decoder across two samples before repairing", async () => {
    const f = await fixture();
    await f.advance(4, { source: true, receive: true });
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    await f.advance(1, { source: true, receive: true });
    expect(f.host.resetVideo).toHaveBeenCalledOnce();
    await f.advance(12, f.flowing);
    expect(f.host.restart).not.toHaveBeenCalled();
    expect(f.host.status).toHaveBeenLastCalledWith(false, "Android 投屏中");
  });
  it("rebinds MessagePort first while preserving the decoder", async () => {
    const f = await fixture();
    await f.advance(5, { source: true });
    expect(f.host.rebindPort).toHaveBeenCalledOnce();
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(1);
    await f.advance(12, f.flowing);
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    expect(f.host.restart).not.toHaveBeenCalled();
  });
  it("does not monitor hidden, minimized, OCR-frozen or suspended playback", async () => {
    const f = await fixture(); f.setVisible(false);
    await f.advance(30, { source: true, receive: true });
    f.setVisible(true); f.state.monitor = false;
    await f.advance(30, { source: true, receive: true });
    f.recovery.suspend(true); await f.advance(30);
    f.recovery.suspend(false); f.state.monitor = true;
    await f.advance(9, f.flowing);
    expect(f.host.resetVideo).not.toHaveBeenCalled();
    expect(f.host.restart).not.toHaveBeenCalled();
    expect(f.host.probe).not.toHaveBeenCalled();
  });
  it("starts each independent fault with a fresh three-attempt budget", async () => {
    const f = await fixture();
    for (let episode = 0; episode < 4; episode++) {
      f.recovery.request("transport");
      await f.advance(13, f.flowing);
      expect(f.recovery.recovering).toBe(false);
      expect(f.host.status).toHaveBeenLastCalledWith(false, "Android 投屏中");
    }
    expect(f.host.restart).toHaveBeenCalledTimes(4);
    expect(f.host.status.mock.calls.filter(([,message]) => message.includes("本次重连 1/3"))).toHaveLength(4);
    expect(f.host.fatal).not.toHaveBeenCalled();
  });
  it("counts a brief picture followed by another fault as the same unconfirmed episode", async () => {
    const f = await fixture();
    f.host.restart.mockImplementation(async () => { f.play(); setTimeout(() => f.recovery.request("transport"), 2000); });
    f.recovery.request("transport"); await f.advance(20, f.flowing);
    expect(f.host.restart).toHaveBeenCalledTimes(3);
    expect(f.host.fatal).toHaveBeenCalledWith(expect.stringContaining("本次故障已重连 3 次"));
  });
  it("does not charge extra retries while waiting for foreground presentation", async () => {
    const f = await fixture(); f.setVisible(false); f.state.monitor = false;
    f.recovery.request("transport"); await f.advance(25);
    expect(f.host.restart).toHaveBeenCalledOnce();
    expect(f.host.fatal).not.toHaveBeenCalled();
    f.setVisible(true); f.state.monitor = true; await f.advance(13, f.flowing);
    expect(f.host.restart).toHaveBeenCalledOnce();
  });
  it("stops after exactly three real failed attempts in one episode", async () => {
    const f = await fixture(); f.host.restart.mockRejectedValue(new Error("start failure"));
    f.recovery.request("transport"); await f.advance(8);
    expect(f.host.restart).toHaveBeenCalledTimes(3);
    expect(f.host.fatal).toHaveBeenCalledWith(expect.stringContaining("本次故障已重连 3 次"));
    expect(f.recovery.active).toBe(false);
  });
  it("cancels pending retries and rejects old session samples", async () => {
    const f = await fixture(); const old = f.diagnostics();
    f.recovery.request("decoder"); await vi.advanceTimersByTimeAsync(0);
    expect(f.recovery.diagnostics(old)).toBe(false);
    f.recovery.cancel(); await f.recovery.wait(); await vi.advanceTimersByTimeAsync(60000);
    expect(f.host.restart).not.toHaveBeenCalled();
  });
  it("stops immediately on a terminal device or authorization failure", async () => {
    const f = await fixture(); f.host.verifyDevice.mockRejectedValue(new TerminalRecoveryError("original device unavailable"));
    f.recovery.request("transport"); await f.advance(1);
    expect(f.host.fatal).toHaveBeenCalledWith("original device unavailable");
    expect(f.host.restart).not.toHaveBeenCalled();
  });
});
