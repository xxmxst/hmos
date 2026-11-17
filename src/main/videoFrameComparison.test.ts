import { describe, expect, it } from "vitest";
import { compareVideoThumbnails } from "./videoFrameComparison";

const picture = () => Uint8Array.from({ length: 64 * 64 * 4 }, (_, index) => index % 4 === 3 ? 255 : 40 + ((index / 4 | 0) % 64) * 2);
describe("memory-only video frame comparison", () => {
  it("tolerates identical frames and small codec noise", () => {
    const a = picture(), b = a.slice();
    for (let index = 0; index < b.length; index++) if (index % 4 !== 3) b[index] = b[index]! + (index % 2 ? 3 : -3);
    expect(compareVideoThumbnails(a, a)).toBe("same");
    expect(compareVideoThumbnails(a, b)).toBe("same");
  });
  it("detects a substantial changed region without needing a full-screen animation", () => {
    const a = picture(), b = a.slice();
    for (let y = 16; y < 32; y++) for (let x = 16; x < 32; x++) for (let c = 0; c < 3; c++) b[(y * 64 + x) * 4 + c] = 240;
    expect(compareVideoThumbnails(a, b)).toBe("different");
  });
  it("does not turn a tiny clock change or uncertain color variation into a fault", () => {
    const a = picture(), b = a.slice();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) for (let c = 0; c < 3; c++) b[(y * 64 + x) * 4 + c] = 240;
    expect(compareVideoThumbnails(a, b)).not.toBe("different");
    const tint = a.map((value, index) => index % 4 === 3 ? value : value + 4);
    expect(compareVideoThumbnails(a, tint)).toBe("unknown");
  });
  it("fails open when a thumbnail is incomplete", () => {
    expect(compareVideoThumbnails(picture(), new Uint8Array(12))).toBe("unknown");
  });
});
