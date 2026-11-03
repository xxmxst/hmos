import { describe, expect, it } from "vitest";
import { encodeScrcpyControl, parseScrcpyVersion, ScrcpyVideoParser } from "./scrcpyProtocol";

function header(major: number): Buffer {
  const result = Buffer.alloc(major >= 4 ? 69 : 77);
  result.write("h264", 65);
  if (major < 4) { result.writeUInt32BE(1080, 69); result.writeUInt32BE(2400, 73); }
  return result;
}
function session(width: number, height: number): Buffer {
  const result = Buffer.alloc(12);
  result[0] = 0x80;
  result.writeUInt32BE(width, 4);
  result.writeUInt32BE(height, 8);
  return result;
}
function frame(pts: bigint, payload = Buffer.from([0, 0, 0, 1, 0x65, 1])): Buffer {
  const prefix = Buffer.alloc(12);
  prefix.writeBigUInt64BE(pts, 0);
  prefix.writeUInt32BE(payload.length, 8);
  return Buffer.concat([prefix, payload]);
}

describe("scrcpy framing", () => {
  it.each([4, 5])("accepts arbitrarily split v%s metadata, configuration, frames and rotation", (major) => {
    const parser = new ScrcpyVideoParser(major);
    const screens: unknown[] = [], frames: any[] = [];
    parser.on("screen", (value) => screens.push(value));
    parser.on("video", (value) => frames.push(value));
    const data = Buffer.concat([header(major), session(1080, 2400), frame(1n << 62n),
      frame((1n << 61n) | 321n), session(2400, 1080), frame(654n)]);
    for (const byte of data) parser.push(Buffer.from([byte]));
    expect(screens).toEqual([{ width: 1080, height: 2400, rotation: 0 }, { width: 2400, height: 1080, rotation: 0 }]);
    expect(frames.map(({ timestampUs, flags }) => [timestampUs, flags])).toEqual([[0n, 1], [321n, 2], [654n, 0]]);
    expect(frames[2].sequence).toBe(2);
  });

  it("keeps the legacy v3 header and timestamp flags separate from v4/v5", () => {
    const parser = new ScrcpyVideoParser(3);
    const frames: any[] = [];
    parser.on("video", (value) => frames.push(value));
    parser.push(Buffer.concat([header(3), frame(1n << 63n), frame((1n << 62n) | 99n)]));
    expect(frames.map(({ flags, timestampUs }) => [flags, timestampUs])).toEqual([[1, 0n], [2, 99n]]);
  });

  it("rejects oversized packets before allocating their payload", () => {
    const parser = new ScrcpyVideoParser(5);
    const failures: Error[] = [];
    parser.on("error", (error) => failures.push(error));
    const invalid = Buffer.alloc(12);
    invalid.writeUInt32BE(0xffffffff, 8);
    parser.push(Buffer.concat([header(5), invalid]));
    parser.push(header(5));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("长度无效");
  });

  it("rejects unknown future protocols instead of silently corrupting the stream", () => {
    expect(parseScrcpyVersion("scrcpy 5.0.1 <https://github.com/Genymobile/scrcpy>\n")).toBe("5.0.1");
    expect(() => parseScrcpyVersion("scrcpy 6.0")).toThrow("当前支持");
  });
});

describe("Android control messages", () => {
  const screen = { width: 1080, height: 2400, rotation: 0 as const };
  it("sets physical display power without injecting a lock/sleep key", () => {
    expect(encodeScrcpyControl({kind:"screen-power",on:false}, screen)).toEqual([Buffer.from([10,0])]);
    expect(encodeScrcpyControl({kind:"screen-power",on:true}, screen)).toEqual([Buffer.from([10,1])]);
  });
  it("rejects malformed physical display power values", () => {
    expect(() => encodeScrcpyControl({kind:"screen-power",on:"false"} as never, screen)).toThrow("屏幕电源状态无效");
  });
  it("sends the actual rotated video size with touch coordinates", () => {
    const [message] = encodeScrcpyControl({ kind: "touch", phase: "down", x: 2399, y: 300,
      screenWidth: 2400, screenHeight: 1080 }, screen);
    expect(message?.length).toBe(32);
    expect(message?.readUInt32BE(10)).toBe(2399);
    expect(message?.readUInt16BE(18)).toBe(2400);
    expect(message?.readUInt16BE(20)).toBe(1080);
    expect(message?.readBigInt64BE(2)).toBe(-2n);
  });
  it("preserves Chinese clipboard text and enforces the server message limit", () => {
    const [message] = encodeScrcpyControl({ kind: "paste", text: "中文🙂" }, screen);
    expect(message?.subarray(14).toString("utf8")).toBe("中文🙂");
    expect(message?.readUInt32BE(10)).toBe(Buffer.byteLength("中文🙂"));
    expect(() => encodeScrcpyControl({ kind: "paste", text: "中".repeat(100_000) }, screen)).toThrow("256 KiB");
  });
  it("uses matched key down/up messages and does not turn wheel stop into a scroll", () => {
    const keys = encodeScrcpyControl({ kind: "key", key: "Back" }, screen);
    expect(keys.map((value) => [value[1], value.readUInt32BE(2)])).toEqual([[0, 4], [1, 4]]);
    expect(encodeScrcpyControl({ kind: "wheel", direction: "stop", x: 0, y: 0 }, screen)).toEqual([]);
  });
});
