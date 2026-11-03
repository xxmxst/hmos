import { describe, expect, it } from "vitest";
import {
  alignControlDimensionsToFrame,
  fitDimensions,
  mapClientPoint,
  resolveControlDimensions
} from "./coordinates";

describe("fitDimensions", () => {
  it("完整容纳竖屏视频并保持原始宽高比", () => {
    expect(fitDimensions(
      { width: 1264, height: 1848 },
      { width: 800, height: 500 }
    )).toEqual({ width: 342, height: 500 });
  });

  it("完整容纳横屏视频和狭窄容器", () => {
    expect(fitDimensions(
      { width: 1848, height: 1264 },
      { width: 400, height: 800 }
    )).toEqual({ width: 400, height: 274 });
  });

  it("拒绝无效内容或容器尺寸", () => {
    expect(fitDimensions({ width: 0, height: 100 }, { width: 500, height: 500 })).toBeNull();
    expect(fitDimensions({ width: 100, height: 100 }, { width: 500, height: 0 })).toBeNull();
  });
});

describe("resolveControlDimensions", () => {
  it("prefers the full device control dimensions over the scaled video frame", () => {
    expect(resolveControlDimensions(
      { width: 2584, height: 1828 },
      { width: 1292, height: 914 },
      2
    )).toEqual({ width: 2584, height: 1828 });
  });

  it.each([
    [1, { width: 1200, height: 800 }, { width: 1200, height: 800 }],
    [2, { width: 600, height: 400 }, { width: 1200, height: 800 }],
    [3, { width: 400, height: 267 }, { width: 1200, height: 801 }]
  ])("reconstructs control dimensions for scale %i", (scale, frame, expected) => {
    expect(resolveControlDimensions(null, frame, scale)).toEqual(expected);
  });

  it("maps the center of a half-sized video to the center of the full device", () => {
    const dimensions = resolveControlDimensions(
      { width: 2584, height: 1828 },
      { width: 1292, height: 914 },
      2
    );
    expect(dimensions).not.toBeNull();
    expect(mapClientPoint(
      646,
      457,
      { left: 0, top: 0, width: 1292, height: 914 },
      dimensions!
    )).toEqual({ x: 1292, y: 914 });
  });
});

describe("alignControlDimensionsToFrame", () => {
  it("swaps stale portrait control dimensions for a landscape video frame", () => {
    expect(alignControlDimensionsToFrame(
      { width: 1264, height: 1848 },
      { width: 924, height: 632 },
      2
    )).toEqual({ width: 1848, height: 1264 });
  });

  it("keeps dimensions that already match the video orientation", () => {
    expect(alignControlDimensionsToFrame(
      { width: 1848, height: 1264 },
      { width: 924, height: 632 },
      2
    )).toEqual({ width: 1848, height: 1264 });
  });

  it("derives missing control dimensions from the scaled video frame", () => {
    expect(alignControlDimensionsToFrame(null, { width: 924, height: 632 }, 2))
      .toEqual({ width: 1848, height: 1264 });
  });

  it("replaces stale same-orientation dimensions after a fold size change", () => {
    expect(alignControlDimensionsToFrame(
      { width: 1264, height: 1848 },
      { width: 1104, height: 1840 },
      1
    )).toEqual({ width: 1104, height: 1840 });
  });
});

describe("mapClientPoint", () => {
  const rect = { left: 100, top: 50, width: 540, height: 1200 };
  const device = { width: 1080, height: 2400 };

  it("maps corners and center", () => {
    expect(mapClientPoint(100, 50, rect, device)).toEqual({ x: 0, y: 0 });
    expect(mapClientPoint(370, 650, rect, device)).toEqual({ x: 540, y: 1200 });
    expect(mapClientPoint(640, 1250, rect, device)).toEqual({ x: 1079, y: 2399 });
  });

  it("rejects letterbox area outside the rendered surface", () => {
    expect(mapClientPoint(99, 50, rect, device)).toBeNull();
    expect(mapClientPoint(370, 1251, rect, device)).toBeNull();
  });
});
