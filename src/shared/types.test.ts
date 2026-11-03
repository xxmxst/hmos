import { describe, expect, it } from "vitest";
import { VIDEO_PROFILES } from "./types";

describe("HOScrcpy video profiles", () => {
  it("uses SDK-native Mbps and millisecond units", () => {
    expect(VIDEO_PROFILES.quality).toMatchObject({
      scale: 1,
      frameRate: 30,
      bitRate: 12,
      iFrameInterval: 1000
    });
    expect(VIDEO_PROFILES.balanced).toMatchObject({
      scale: 2,
      frameRate: 60,
      bitRate: 8,
      iFrameInterval: 1000
    });
    expect(VIDEO_PROFILES.smooth).toMatchObject({
      scale: 3,
      frameRate: 30,
      bitRate: 4,
      iFrameInterval: 1000
    });
  });
});
