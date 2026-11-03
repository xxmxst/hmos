import { createVideoPortReadyMessage } from "../shared/videoPort";
import type { VideoPacket } from "./videoPipeline";

export interface VideoPortLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  start(): void;
  close(): void;
  postMessage(message: unknown): void;
}

interface VideoPortHandlers {
  onPacket(packet: VideoPacket): void;
  onReady(): void;
  onError(): void;
}

export function bindVideoPort(port: VideoPortLike, handlers: VideoPortHandlers): () => void {
  let disposed = false;
  port.onmessage = (event) => {
    if (disposed) {
      return;
    }
    const packet = parseVideoPacket(event.data);
    if (packet) {
      handlers.onPacket(packet);
    }
  };
  port.onmessageerror = () => {
    if (!disposed) {
      handlers.onError();
    }
  };
  port.start();
  handlers.onReady();
  port.postMessage(createVideoPortReadyMessage());

  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    port.onmessage = null;
    port.onmessageerror = null;
    port.close();
  };
}

export function parseVideoPacket(value: unknown): VideoPacket | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const packet = value as Partial<VideoPacket>;
  if (
    !(packet.data instanceof ArrayBuffer)
    || typeof packet.timestampUs !== "number"
    || !Number.isFinite(packet.timestampUs)
    || typeof packet.sequence !== "number"
    || !Number.isSafeInteger(packet.sequence)
    || typeof packet.flags !== "number"
    || !Number.isSafeInteger(packet.flags)
  ) {
    return null;
  }
  return {
    data: packet.data,
    timestampUs: packet.timestampUs,
    sequence: packet.sequence,
    flags: packet.flags
  };
}
