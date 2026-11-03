import { describe, expect, it, vi } from "vitest";
import { bindVideoPort, parseVideoPacket, type VideoPortLike } from "./videoPortClient";

function fixture() {
  const port: VideoPortLike = {
    onmessage: null,
    onmessageerror: null,
    start: vi.fn(),
    close: vi.fn(),
    postMessage: vi.fn()
  };
  const onPacket = vi.fn();
  const onReady = vi.fn();
  const onError = vi.fn();
  const dispose = bindVideoPort(port, { onPacket, onReady, onError });
  return { port, onPacket, onReady, onError, dispose };
}

describe("renderer video port client", () => {
  it("binds handlers before acknowledging the port", () => {
    const { port, onReady } = fixture();

    expect(port.start).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledWith({ type: "ready", protocol: 1 });
    expect(port.onmessage).toBeTypeOf("function");
  });

  it("forwards valid video packets and ignores malformed messages", () => {
    const { port, onPacket } = fixture();
    const packet = {
      data: new Uint8Array([1, 2, 3]).buffer,
      timestampUs: 10,
      sequence: 2,
      flags: 1
    };

    port.onmessage?.({ data: packet } as MessageEvent<unknown>);
    port.onmessage?.({ data: { ...packet, data: "invalid" } } as MessageEvent<unknown>);

    expect(onPacket).toHaveBeenCalledTimes(1);
    expect(onPacket).toHaveBeenCalledWith(packet);
    expect(parseVideoPacket(null)).toBeNull();
  });

  it("closes the old port and ignores later events after disposal", () => {
    const { port, onPacket, onError, dispose } = fixture();
    const message = {
      data: new Uint8Array([1]).buffer,
      timestampUs: 1,
      sequence: 1,
      flags: 0
    };

    dispose();
    port.onmessage?.({ data: message } as MessageEvent<unknown>);
    port.onmessageerror?.({} as MessageEvent<unknown>);

    expect(port.close).toHaveBeenCalledTimes(1);
    expect(onPacket).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
