import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const muxerState = vi.hoisted(() => ({ instances: [] as Array<Record<string, any>> }));

vi.mock("jmuxer", () => ({
  default: class FakeJMuxer {
    readonly feed = vi.fn();
    readonly reset = vi.fn();
    readonly destroy = vi.fn();

    constructor(readonly options: {
      node: HTMLVideoElement;
      onError?: () => void;
      onUnsupportedCodec?: () => void;
    }) {
      muxerState.instances.push(this);
    }
  }
}));

import { VideoPipeline } from "./videoPipeline";

const videoStream = new Uint8Array([
  0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 1,
  0, 0, 0, 1, 0x68, 2, 3,
  0, 0, 0, 1, 0x65, 4, 5,
  0, 0, 0, 1, 0x61, 6, 7
]);

const changedVideoStream = new Uint8Array([
  0, 0, 0, 1, 0x67, 0x64, 0x00, 0x29, 9,
  0, 0, 0, 1, 0x68, 8, 9,
  0, 0, 0, 1, 0x65, 4, 5,
  0, 0, 0, 1, 0x61, 6, 7
]);

const secondChangedVideoStream = new Uint8Array([
  0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 7,
  0, 0, 0, 1, 0x68, 10, 11,
  0, 0, 0, 1, 0x65, 12, 13,
  0, 0, 0, 1, 0x61, 14, 15
]);

const changedConfigurationWithoutIdr = new Uint8Array([
  0, 0, 0, 1, 0x67, 0x64, 0x00, 0x29, 9,
  0, 0, 0, 1, 0x68, 8, 9,
  0, 0, 0, 1, 0x61, 6, 7
]);

interface FakeVideo {
  element: HTMLVideoElement;
  listeners: Map<string, Set<() => void>>;
  emit(name: string): void;
}

function fakeVideo(width = 1264, height = 1848): FakeVideo {
  const listeners = new Map<string, Set<() => void>>();
  const element = {
    hidden: false,
    videoWidth: width,
    videoHeight: height,
    readyState: 4,
    addEventListener: vi.fn((name: string, listener: () => void) => {
      const entries = listeners.get(name) ?? new Set();
      entries.add(listener);
      listeners.set(name, entries);
    }),
    removeEventListener: vi.fn((name: string, listener: () => void) => {
      listeners.get(name)?.delete(listener);
    }),
    play: vi.fn(() => Promise.resolve())
  } as unknown as HTMLVideoElement;
  return {
    element,
    listeners,
    emit: (name: string) => {
      for (const listener of [...(listeners.get(name) ?? [])]) {
        listener();
      }
    }
  };
}

function fixture(loadPlaceholder?: () => Promise<any>) {
  const clearRect = vi.fn();
  const drawImage = vi.fn();
  const canvas = {
    hidden: false,
    width: 300,
    height: 150,
    getContext: vi.fn(() => ({ clearRect, drawImage }))
  } as unknown as HTMLCanvasElement;
  const primary = fakeVideo();
  const secondary = fakeVideo();
  const onDimensions = vi.fn();
  const onDecoder = vi.fn();
  const requestIdr = vi.fn();
  const onDiagnostics = vi.fn();
  const pipeline = new VideoPipeline(
    canvas,
    primary.element,
    secondary.element,
    onDimensions,
    onDecoder,
    requestIdr,
    onDiagnostics,
    loadPlaceholder
  );
  return {
    canvas,
    drawImage,
    primary,
    secondary,
    onDimensions,
    onDecoder,
    requestIdr,
    onDiagnostics,
    pipeline
  };
}

function packet(data = videoStream) {
  return {
    data: data.slice().buffer,
    timestampUs: 1,
    sequence: 1,
    flags: 1
  };
}

describe("VideoPipeline dual MediaSource lifecycle", () => {
  beforeEach(() => {
    muxerState.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps both videos hidden until the first decoded frame", async () => {
    const {
      canvas,
      primary,
      secondary,
      onDimensions,
      onDecoder,
      onDiagnostics,
      pipeline
    } = fixture();
    await pipeline.initialize();
    pipeline.beginSession();
    pipeline.setPortReady(true);

    expect(muxerState.instances).toHaveLength(1);
    expect(onDecoder).toHaveBeenLastCalledWith("MediaSource");
    expect(canvas.hidden).toBe(true);
    expect(primary.element.hidden).toBe(true);
    expect(secondary.element.hidden).toBe(true);

    pipeline.feed(packet());
    expect(muxerState.instances[0]!.feed).toHaveBeenCalledTimes(1);
    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: "waiting-frame",
      framing: "annex-b",
      packets: 1,
      hasSps: true,
      hasPps: true,
      hasIdr: true
    }));

    primary.emit("loadeddata");
    expect(primary.element.hidden).toBe(false);
    expect(secondary.element.hidden).toBe(true);
    expect(onDimensions).toHaveBeenCalledWith(1264, 1848, "video");
    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "decoding" }));
    expect(pipeline.canControl()).toBe(true);
  });

  it("preserves the visible frame and recorder source until a recovered decoder has a first frame", async () => {
    vi.useFakeTimers();
    const { pipeline, primary, secondary, canvas, drawImage, onDiagnostics } = fixture();
    await pipeline.initialize();
    pipeline.prepareRecovery({ sessionId: 1, kind: "initial" });
    pipeline.feed({ ...packet(), sessionId: 1 });
    primary.emit("loadeddata");
    pipeline.setPortReady(true);
    const previous = pipeline.getRenderTarget();
    pipeline.prepareRecovery({ sessionId: 2, kind: "decoder" });
    expect(canvas.hidden).toBe(false);
    muxerState.instances[0]!.options.onError();
    expect(drawImage).toHaveBeenCalled();
    expect(pipeline.getRenderTarget()).toBe(previous);
    expect(pipeline.canControl()).toBe(false);
    const feeds = muxerState.instances.map(m => m.feed.mock.calls.length);
    pipeline.feed({ ...packet(), sessionId: 1 });
    expect(muxerState.instances.map(m => m.feed.mock.calls.length)).toEqual(feeds);
    pipeline.feed({ ...packet(), sessionId: 2 });
    secondary.emit("loadeddata");
    expect(pipeline.getRenderTarget()).toBe(secondary.element);
    muxerState.instances[0]!.options.onError();
    expect(pipeline.canControl()).toBe(true);
    expect(canvas.hidden).toBe(true);
    expect(pipeline.canControl()).toBe(true);
    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 2, presentedFrames: 1, stage: "decoding" }));
    pipeline.dispose();
  });

  it("reports heartbeat without new packets and actual presented frame progress", async () => {
    vi.useFakeTimers();
    const { pipeline, primary, onDiagnostics } = fixture();
    let callback!: VideoFrameRequestCallback;
    primary.element.requestVideoFrameCallback = vi.fn(fn => { callback = fn; return 1; });
    primary.element.cancelVideoFrameCallback = vi.fn();
    await pipeline.initialize();
    pipeline.prepareRecovery({ sessionId: 10, kind: "initial" });
    pipeline.feed({ ...packet(), sessionId: 10 });
    primary.emit("loadeddata");
    const first = onDiagnostics.mock.calls.length;
    callback(0, {} as VideoFrameCallbackMetadata);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onDiagnostics.mock.calls.length).toBeGreaterThan(first);
    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 10, packets: 1, presentedFrames: 2 }));
    const stale = callback;
    pipeline.reset();
    const count = onDiagnostics.mock.calls.length;
    stale(0, {} as VideoFrameCallbackMetadata);
    await vi.advanceTimersByTimeAsync(10000);
    expect(onDiagnostics).toHaveBeenCalledTimes(count);
    expect(primary.element.cancelVideoFrameCallback).toHaveBeenCalled();
  });

  it("destroys both decoder slots for a reconnect", async () => {
    const { pipeline } = fixture();
    await pipeline.initialize();
    const first = muxerState.instances[0]!;

    pipeline.reset();
    expect(first.destroy).toHaveBeenCalledTimes(1);

    await pipeline.initialize();
    expect(muxerState.instances).toHaveLength(2);
    expect(muxerState.instances[1]).not.toBe(first);
  });

  it("reports a changed size only from the visible video", async () => {
    const { primary, secondary, onDimensions, pipeline } = fixture();
    await pipeline.initialize();
    pipeline.beginSession();
    pipeline.feed(packet());
    primary.emit("loadeddata");
    Object.assign(primary.element, { videoWidth: 1848, videoHeight: 1264 });
    Object.assign(secondary.element, { videoWidth: 900, videoHeight: 600 });

    secondary.emit("resize");
    primary.emit("resize");

    expect(onDimensions).toHaveBeenLastCalledWith(1848, 1264, "video");
    expect(onDimensions).not.toHaveBeenCalledWith(900, 600, "video");
  });

  it("keeps the active decoder visible until the standby first frame is ready", async () => {
    const { primary, secondary, onDimensions, onDiagnostics, pipeline } = fixture();
    await pipeline.initialize();
    pipeline.beginSession();
    pipeline.setPortReady(true);
    pipeline.feed(packet());
    primary.emit("loadeddata");
    const activeMuxer = muxerState.instances[0]!;

    pipeline.feed(packet(changedVideoStream));

    expect(primary.element.hidden).toBe(false);
    expect(secondary.element.hidden).toBe(true);
    expect(activeMuxer.destroy).not.toHaveBeenCalled();
    expect(muxerState.instances).toHaveLength(2);
    expect(muxerState.instances[1]!.feed).toHaveBeenCalledOnce();
    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "switching" }));
    expect(pipeline.canControl()).toBe(false);

    Object.assign(secondary.element, { videoWidth: 1848, videoHeight: 1264 });
    secondary.emit("loadeddata");

    expect(primary.element.hidden).toBe(true);
    expect(secondary.element.hidden).toBe(false);
    expect(activeMuxer.destroy).toHaveBeenCalledOnce();
    expect(onDimensions).toHaveBeenLastCalledWith(1848, 1264, "video");
    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "decoding" }));
    expect(pipeline.canControl()).toBe(true);
  });

  it("invalidates only a stale standby during rapid configuration changes", async () => {
    const { primary, secondary, pipeline } = fixture();
    await pipeline.initialize();
    pipeline.beginSession();
    pipeline.feed(packet());
    primary.emit("loadeddata");
    const activeMuxer = muxerState.instances[0]!;

    pipeline.feed(packet(changedVideoStream));
    const firstStandby = muxerState.instances[1]!;
    const staleLoadedData = [...(secondary.listeners.get("loadeddata") ?? [])][0]!;
    pipeline.feed(packet(secondChangedVideoStream));

    expect(activeMuxer.destroy).not.toHaveBeenCalled();
    expect(firstStandby.destroy).toHaveBeenCalledOnce();
    expect(muxerState.instances).toHaveLength(3);
    staleLoadedData();
    expect(primary.element.hidden).toBe(false);
    expect(secondary.element.hidden).toBe(true);

    Object.assign(secondary.element, { videoWidth: 2208, videoHeight: 1840 });
    secondary.emit("loadeddata");
    expect(primary.element.hidden).toBe(true);
    expect(secondary.element.hidden).toBe(false);
  });

  it("does not rebuild a decoder for repeated SPS/PPS", async () => {
    const { primary, pipeline } = fixture();
    await pipeline.initialize();
    pipeline.beginSession();
    pipeline.feed(packet());
    primary.emit("loadeddata");

    pipeline.feed(packet(videoStream));

    expect(muxerState.instances).toHaveLength(1);
    expect(muxerState.instances[0]!.destroy).not.toHaveBeenCalled();
  });

  it("requests one IDR while a changed configuration waits for its keyframe", async () => {
    const { primary, requestIdr, pipeline } = fixture();
    await pipeline.initialize();
    pipeline.beginSession();
    requestIdr.mockClear();
    pipeline.feed(packet());
    primary.emit("loadeddata");

    pipeline.feed(packet(changedConfigurationWithoutIdr));
    pipeline.feed(packet(new Uint8Array([
      0, 0, 0, 1, 0x61, 3, 4,
      0, 0, 0, 1, 0x61, 5, 6
    ])));

    expect(requestIdr).toHaveBeenCalledOnce();
    expect(muxerState.instances).toHaveLength(1);
  });

  it("retries only the standby when a fold transition times out", async () => {
    vi.useFakeTimers();
    const { primary, requestIdr, onDiagnostics, pipeline } = fixture();
    await pipeline.initialize();
    pipeline.beginSession();
    pipeline.setPortReady(true);
    pipeline.feed(packet());
    primary.emit("loadeddata");
    requestIdr.mockClear();
    const activeMuxer = muxerState.instances[0]!;

    pipeline.feed(packet(changedVideoStream));
    const standby = muxerState.instances[1]!;
    await vi.advanceTimersByTimeAsync(1_500);

    expect(activeMuxer.destroy).not.toHaveBeenCalled();
    expect(standby.destroy).toHaveBeenCalledOnce();
    expect(primary.element.hidden).toBe(false);
    expect(requestIdr).toHaveBeenCalledOnce();
    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "switching" }));

    await vi.advanceTimersByTimeAsync(4_000);
    expect(onDiagnostics).not.toHaveBeenLastCalledWith(expect.objectContaining({ stage: "error" }));
  });

  it("requests one IDR and rebuilds the initial decoder before reporting a timeout", async () => {
    vi.useFakeTimers();
    const { onDiagnostics, requestIdr, pipeline } = fixture();
    await pipeline.initialize();
    pipeline.beginSession();
    pipeline.setPortReady(true);
    requestIdr.mockClear();
    pipeline.feed(packet());

    await vi.advanceTimersByTimeAsync(3_000);
    expect(requestIdr).toHaveBeenCalledTimes(1);
    expect(muxerState.instances).toHaveLength(2);
    expect(muxerState.instances[0]!.destroy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: "error",
      error: expect.stringContaining("关键帧")
    }));
  });

  it("reports an error when the ready port receives no packets", async () => {
    vi.useFakeTimers();
    const { onDiagnostics, pipeline } = fixture();
    await pipeline.initialize();
    pipeline.beginSession();
    pipeline.setPortReady(true);

    await vi.advanceTimersByTimeAsync(8_000);

    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: "error",
      packets: 0,
      bytes: 0
    }));
  });

  it("reports the video port handshake stage", async () => {
    const { onDiagnostics, pipeline } = fixture();
    await pipeline.initialize();
    pipeline.beginSession();
    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "waiting-port" }));

    pipeline.setPortReady(true);
    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ stage: "waiting-stream" }));
  });

  it("shows a non-interactive HDC placeholder while the first video frame is pending", async () => {
    vi.useFakeTimers();
    const bitmap = { close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const loadPlaceholder = vi.fn().mockResolvedValue({
      image: Uint8Array.from([0xff, 0xd8, 0xff]).buffer,
      mimeType: "image/jpeg",
      width: 1264,
      height: 1848
    });
    const {
      canvas,
      drawImage,
      primary,
      onDimensions,
      pipeline
    } = fixture(loadPlaceholder);
    await pipeline.initialize();
    pipeline.beginSession();

    await vi.advanceTimersByTimeAsync(500);

    expect(loadPlaceholder).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1264, 1848);
    expect(canvas.hidden).toBe(false);
    expect(primary.element.hidden).toBe(true);
    expect(onDimensions).toHaveBeenLastCalledWith(1264, 1848, "placeholder");
    expect(pipeline.canControl()).toBe(false);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
