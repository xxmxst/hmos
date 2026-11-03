import { describe, expect, it } from "vitest";
import { clampBounds, compactSize, fitCompactBounds, parseWindowPreferences, resizeCompactBounds } from "./windowGeometry";

const work = { x: 0, y: 0, width: 1920, height: 1080 };
const portrait = { width: 9, height: 16 };
const landscape = { width: 16, height: 9 };

describe("compact window geometry", () => {
  it("defaults to full mode and rejects malformed persisted sizes", () => {
    expect(parseWindowPreferences(null)).toMatchObject({ mode: "full", fullBounds: null, videoSize: portrait });
    expect(parseWindowPreferences({ mode: "other", fullBounds: { x: 0, y: 0, width: -1, height: 1 },
      videoSize: { width: NaN, height: 3 } })).toMatchObject({ mode: "full", fullBounds: null, videoSize: portrait });
    expect(parseWindowPreferences({ mode: "compact", compactBounds: work, fullMaximized: true }))
      .toMatchObject({ mode: "compact", compactBounds: work, fullMaximized: true });
  });

  it("uses 80 percent of the screen height plus exactly one rail", () => {
    const bounds = fitCompactBounds(portrait, work, null);
    expect(bounds.height).toBe(864);
    expect(bounds.width - 48).toBe(486);
    expect(bounds.x).toBe(693);
  });

  it("fits landscape and extremely narrow/tall displays without cropping", () => {
    for (const area of [work, { x: -800, y: 30, width: 800, height: 600 }, { x: 0, y: 0, width: 220, height: 180 }]) {
      for (const video of [portrait, landscape, { width: 1, height: 10 }]) {
        const bounds = fitCompactBounds(video, area, null);
        expect(bounds.width).toBeLessThanOrEqual(area.width);
        expect(bounds.height).toBeLessThanOrEqual(area.height);
        expect(Math.abs(bounds.width - 48 - bounds.height * video.width / video.height)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("preserves video area when switching orientation", () => {
    const before = { x: 200, y: 100, width: 408, height: 640 };
    const after = fitCompactBounds(landscape, work, before, true);
    expect(after.width).toBe(688);
    expect(after.height).toBe(360);
    expect((after.width - 48) * after.height).toBe((before.width - 48) * before.height);
    expect(after.x + after.width / 2).toBe(before.x + before.width / 2);
  });

  it("keeps the opposite corner fixed for top/left resizing", () => {
    const before = { x: 500, y: 400, width: 228, height: 320 };
    const after = resizeCompactBounds({ x: 444, y: 300, width: 284, height: 420 }, before, portrait, work, "top-left");
    expect(after.x + after.width).toBe(before.x + before.width);
    expect(after.y + after.height).toBe(before.y + before.height);
    expect(Math.abs(after.width - 48 - after.height * 9 / 16)).toBeLessThan(1);
  });

  it("excludes native borders from the video aspect ratio", () => {
    const chrome = { width: 16, height: 8 };
    const size = compactSize(portrait, work, 808, chrome);
    expect(size).toEqual({ width: 514, height: 808 });
    const resized = resizeCompactBounds({ x: 0, y: 0, width: 604, height: 808 }, { x: 0, y: 0, ...size },
      portrait, work, "right", chrome);
    expect(Math.abs((resized.width - 48 - 16) / (resized.height - 8) - 9 / 16)).toBeLessThan(0.001);
  });

  it("moves saved windows from removed displays into the available work area", () => {
    const negativeDisplay = { x: -1280, y: -80, width: 1280, height: 720 };
    expect(clampBounds({ x: 4000, y: 3000, width: 900, height: 800 }, negativeDisplay))
      .toEqual({ x: -900, y: -80, width: 900, height: 720 });
    const restored = fitCompactBounds(portrait, negativeDisplay, { x: 4000, y: 3000, width: 900, height: 800 });
    expect(restored.x + restored.width).toBeLessThanOrEqual(0);
    expect(restored.y + restored.height).toBeLessThanOrEqual(640);
  });
});
