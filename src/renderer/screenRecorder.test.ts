import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenRecorder } from "./screenRecorder";

afterEach(() => vi.unstubAllGlobals());

describe("recording startup failure", () => {
  it("releases the selected recording session and does not leave stop waiting forever", async () => {
    class FailedRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      state = "inactive";
      start() { throw new Error("Encoder unavailable"); }
    }
    const stopTrack = vi.fn();
    vi.stubGlobal("MediaRecorder", FailedRecorder);
    vi.stubGlobal("document", { createElement: () => ({
      getContext: () => ({ fillRect() {}, drawImage() {} }),
      captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] })
    }) });
    const api = {
      beginRecording: vi.fn().mockResolvedValue({ id: "test-session" }),
      finishRecording: vi.fn().mockResolvedValue(null)
    };
    const recorder = new ScreenRecorder(api as never,
      () => ({ videoWidth: 1080, videoHeight: 2400, readyState: 2 }) as never,
      () => true, () => {}, () => {});
    await expect(recorder.start()).rejects.toThrow("Encoder unavailable");
    await expect(recorder.stop()).resolves.toBeUndefined();
    expect(recorder.busy).toBe(false);
    expect(recorder.recording).toBe(false);
    expect(api.finishRecording).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
  });
});
