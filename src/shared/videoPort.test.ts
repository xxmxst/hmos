import { describe, expect, it } from "vitest";
import {
  createVideoPortReadyMessage,
  isVideoPortReadyMessage,
  VIDEO_PORT_WINDOW_MESSAGE
} from "./videoPort";

describe("video port protocol", () => {
  it("uses a fixed window message and validates the ready acknowledgement", () => {
    expect(VIDEO_PORT_WINDOW_MESSAGE).toBe("hmremote:video-port:v1");
    expect(isVideoPortReadyMessage(createVideoPortReadyMessage())).toBe(true);
    expect(isVideoPortReadyMessage({ type: "ready", protocol: 2 })).toBe(false);
    expect(isVideoPortReadyMessage({ type: "video", protocol: 1 })).toBe(false);
  });
});
