import type { VideoDiagnostics } from "./types";

export function playbackAdvanced(current: VideoDiagnostics, previous: VideoDiagnostics | null): boolean {
  if (!previous) return false;
  return (current.presentedFrames ?? 0) > (previous.presentedFrames ?? 0)
    || (current.decodedFrames ?? 0) > (previous.decodedFrames ?? 0)
    || (current.playbackTime ?? 0) > (previous.playbackTime ?? 0) + 0.005;
}

export function usableVideoFrame(health: VideoDiagnostics | null): boolean {
  return !!health && health.stage !== "error" && health.stage !== "recovering"
    && health.stage !== "switching" && health.frameReady === true;
}
