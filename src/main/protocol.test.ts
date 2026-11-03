import { describe, expect, it } from "vitest";
import { BridgeFrameParser, BridgeMessageType } from "./protocol";

function makeFrame(type: BridgeMessageType, payload: Buffer, sequence = 7): Buffer {
  const header = Buffer.alloc(24);
  header.write("HMR1", 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt8(type, 5);
  header.writeUInt16LE(3, 6);
  header.writeUInt32LE(payload.length, 8);
  header.writeUInt32LE(sequence, 12);
  header.writeBigUInt64LE(1234n, 16);
  return Buffer.concat([header, payload]);
}

describe("BridgeFrameParser", () => {
  it("parses a fragmented frame", () => {
    const parser = new BridgeFrameParser();
    const received: Buffer[] = [];
    parser.on("frame", (frame) => received.push(frame.payload));
    const frame = makeFrame(BridgeMessageType.Video, Buffer.from([1, 2, 3]));
    parser.push(frame.subarray(0, 5));
    parser.push(frame.subarray(5, 21));
    expect(received).toHaveLength(0);
    parser.push(frame.subarray(21));
    expect(received).toEqual([Buffer.from([1, 2, 3])]);
  });

  it("parses coalesced frames and recovers from garbage", () => {
    const parser = new BridgeFrameParser();
    const sequences: number[] = [];
    parser.on("frame", (frame) => sequences.push(frame.sequence));
    parser.push(
      Buffer.concat([
        Buffer.from("noise"),
        makeFrame(BridgeMessageType.Json, Buffer.from("{}"), 1),
        makeFrame(BridgeMessageType.Video, Buffer.from([0]), 2)
      ])
    );
    expect(sequences).toEqual([1, 2]);
  });
});
