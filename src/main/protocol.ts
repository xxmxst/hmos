import { EventEmitter } from "node:events";

export const BRIDGE_MAGIC = Buffer.from("HMR1", "ascii");
export const BRIDGE_HEADER_SIZE = 24;
export const BRIDGE_VERSION = 1;

export enum BridgeMessageType {
  Video = 1,
  Json = 2
}

export interface BridgeFrame {
  version: number;
  type: BridgeMessageType;
  flags: number;
  sequence: number;
  timestampUs: bigint;
  payload: Buffer;
}

export class BridgeFrameParser extends EventEmitter {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= BRIDGE_HEADER_SIZE) {
      if (!this.pending.subarray(0, 4).equals(BRIDGE_MAGIC)) {
        const nextMagic = this.pending.indexOf(BRIDGE_MAGIC, 1);
        if (nextMagic < 0) {
          this.pending = this.pending.subarray(Math.max(0, this.pending.length - 3));
          return;
        }
        this.pending = this.pending.subarray(nextMagic);
        continue;
      }

      const payloadLength = this.pending.readUInt32LE(8);
      if (payloadLength > 32 * 1024 * 1024) {
        this.emit("error", new Error(`边车负载过大：${payloadLength}`));
        this.pending = this.pending.subarray(4);
        continue;
      }
      const frameLength = BRIDGE_HEADER_SIZE + payloadLength;
      if (this.pending.length < frameLength) {
        return;
      }

      const frame: BridgeFrame = {
        version: this.pending.readUInt8(4),
        type: this.pending.readUInt8(5) as BridgeMessageType,
        flags: this.pending.readUInt16LE(6),
        sequence: this.pending.readUInt32LE(12),
        timestampUs: this.pending.readBigUInt64LE(16),
        payload: Buffer.from(this.pending.subarray(BRIDGE_HEADER_SIZE, frameLength))
      };
      this.pending = this.pending.subarray(frameLength);
      if (frame.version !== BRIDGE_VERSION) {
        this.emit("error", new Error(`不支持的边车协议版本：${frame.version}`));
        continue;
      }
      this.emit("frame", frame);
    }
  }
}

export interface BridgeJsonMessage {
  type: "event" | "response";
  event?: string;
  id?: number;
  ok?: boolean;
  error?: string;
  code?: string;
  [key: string]: unknown;
}

export function decodeBridgeJson(payload: Buffer): BridgeJsonMessage {
  const value: unknown = JSON.parse(payload.toString("utf8"));
  if (!value || typeof value !== "object") {
    throw new Error("边车返回了无效 JSON");
  }
  return value as BridgeJsonMessage;
}
