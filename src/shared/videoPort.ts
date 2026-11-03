export const VIDEO_PORT_WINDOW_MESSAGE = "hmremote:video-port:v1";

export interface VideoPortReadyMessage {
  type: "ready";
  protocol: 1;
}

export function createVideoPortReadyMessage(): VideoPortReadyMessage {
  return { type: "ready", protocol: 1 };
}

export function isVideoPortReadyMessage(value: unknown): value is VideoPortReadyMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as Partial<VideoPortReadyMessage>;
  return message.type === "ready" && message.protocol === 1;
}
