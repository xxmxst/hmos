import { describe, expect, it } from "vitest";
import { codecFromSps, containsIdr, findNalUnits } from "./h264";

describe("H.264 Annex-B helpers", () => {
  const stream = new Uint8Array([
    0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 1, 2,
    0, 0, 1, 0x68, 3, 4,
    0, 0, 0, 1, 0x65, 5, 6
  ]);

  it("finds NAL units with 3-byte and 4-byte start codes", () => {
    expect(findNalUnits(stream).map((nal) => nal.type)).toEqual([7, 8, 5]);
  });

  it("derives the AVC codec string from SPS", () => {
    expect(codecFromSps(stream)).toBe("avc1.640028");
  });

  it("detects IDR frames", () => {
    expect(containsIdr(stream)).toBe(true);
    expect(containsIdr(new Uint8Array([0, 0, 1, 0x61, 1]))).toBe(false);
  });
});
