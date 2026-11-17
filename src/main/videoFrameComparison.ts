export type FrameComparison = "same" | "different" | "unknown";

/** Compare 64px BGRA thumbnails using block means to tolerate codec noise. */
export function compareVideoThumbnails(left: Uint8Array, right: Uint8Array): FrameComparison {
  if (left.length !== 64 * 64 * 4 || right.length !== left.length) return "unknown";
  let error = 0, changed = 0;
  for (let y = 0; y < 64; y += 4) {
    for (let x = 0; x < 64; x += 4) {
      const a = [0, 0, 0], b = [0, 0, 0];
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
        const offset = ((y + dy) * 64 + x + dx) * 4;
        for (let channel = 0; channel < 3; channel++) {
          a[channel]! += left[offset + channel]! / 16;
          b[channel]! += right[offset + channel]! / 16;
        }
      }
      const delta = a.reduce((sum, value, channel) => sum + Math.abs(value - b[channel]!), 0) / 3;
      error += delta;
      if (delta >= 18) changed++;
    }
  }
  if (error / 256 >= 6 || changed / 256 >= 0.04) return "different";
  if (error / 256 <= 3 && changed / 256 <= 0.01) return "same";
  return "unknown";
}
