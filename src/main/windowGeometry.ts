import type { WindowMode } from "../shared/types";

export const COMPACT_RAIL_WIDTH = 48;
export interface Size { width: number; height: number; }
export interface Bounds extends Size { x: number; y: number; }
export interface WindowPreferences {
  mode: WindowMode;
  fullBounds: Bounds | null;
  fullMaximized: boolean;
  compactBounds: Bounds | null;
  videoSize: Size;
}

export function validSize(value: unknown): value is Size {
  if (!value || typeof value !== "object") return false;
  const size = value as Size;
  return [size.width, size.height].every((n) => Number.isFinite(n) && n >= 1 && n <= 32768);
}

function validBounds(value: unknown): value is Bounds {
  if (!validSize(value)) return false;
  const bounds = value as Bounds;
  return [bounds.x, bounds.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 100000);
}

export function parseWindowPreferences(value: unknown): WindowPreferences {
  const item = (value && typeof value === "object" ? value : {}) as Partial<WindowPreferences>;
  return {
    mode: item.mode === "compact" ? "compact" : "full",
    fullBounds: validBounds(item.fullBounds) ? item.fullBounds : null,
    fullMaximized: item.fullMaximized === true,
    compactBounds: validBounds(item.compactBounds) ? item.compactBounds : null,
    videoSize: validSize(item.videoSize) ? item.videoSize : { width: 9, height: 16 }
  };
}

export function clampBounds(bounds: Bounds, work: Bounds): Bounds {
  const width = Math.min(Math.round(bounds.width), work.width);
  const height = Math.min(Math.round(bounds.height), work.height);
  return {
    x: Math.round(Math.max(work.x, Math.min(bounds.x, work.x + work.width - width))),
    y: Math.round(Math.max(work.y, Math.min(bounds.y, work.y + work.height - height))),
    width, height
  };
}

// All sizes are Electron DIP. Account for the native invisible resize border as well as the rail.
export function compactSize(video: Size, work: Size, desiredHeight: number, chrome: Size = { width: 0, height: 0 }): Size {
  const ratio = video.width / video.height;
  const maxHeight = Math.max(1, Math.min(work.height - chrome.height, (work.width - chrome.width - COMPACT_RAIL_WIDTH) / ratio));
  const minHeight = Math.min(maxHeight, 180 / Math.min(1, ratio));
  const height = Math.max(minHeight, Math.min(desiredHeight - chrome.height, maxHeight));
  return {
    width: Math.round(height * ratio + COMPACT_RAIL_WIDTH + chrome.width),
    height: Math.round(height + chrome.height)
  };
}

export function fitCompactBounds(video: Size, work: Bounds, previous: Bounds | null, preserveArea = false,
  chrome: Size = { width: 0, height: 0 }): Bounds {
  const ratio = video.width / video.height;
  const targetHeight = previous
    ? preserveArea
      ? Math.sqrt(Math.max(1, previous.width - COMPACT_RAIL_WIDTH - chrome.width)
        * Math.max(1, previous.height - chrome.height) / ratio) + chrome.height
      : previous.height
    : work.height * 0.8;
  const size = compactSize(video, work, targetHeight, chrome);
  return clampBounds({ ...size,
    x: previous ? previous.x + (previous.width - size.width) / 2 : work.x + (work.width - size.width) / 2,
    y: previous ? previous.y + (previous.height - size.height) / 2 : work.y + (work.height - size.height) / 2
  }, work);
}

export function resizeCompactBounds(proposed: Bounds, previous: Bounds, video: Size, work: Bounds, edge: string,
  chrome: Size = { width: 0, height: 0 }): Bounds {
  const ratio = video.width / video.height;
  const horizontal = edge === "left" || edge === "right"
    || (edge !== "top" && edge !== "bottom"
      && Math.abs(proposed.width - previous.width) > Math.abs(proposed.height - previous.height) * ratio);
  const height = horizontal
    ? (proposed.width - COMPACT_RAIL_WIDTH - chrome.width) / ratio + chrome.height
    : proposed.height;
  const size = compactSize(video, work, height, chrome);
  return clampBounds({ ...size,
    x: edge.includes("left") ? previous.x + previous.width - size.width : proposed.x,
    y: edge.includes("top") ? previous.y + previous.height - size.height : proposed.y
  }, work);
}
