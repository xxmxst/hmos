export interface Point {
  x: number;
  y: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

export function fitDimensions(
  content: Dimensions | null | undefined,
  container: Dimensions | null | undefined
): Dimensions | null {
  if (!isValidDimensions(content) || !isValidDimensions(container)) {
    return null;
  }
  const scale = Math.min(
    container.width / content.width,
    container.height / content.height
  );
  return {
    width: Math.max(1, Math.min(Math.round(container.width), Math.round(content.width * scale))),
    height: Math.max(1, Math.min(Math.round(container.height), Math.round(content.height * scale)))
  };
}

export function resolveControlDimensions(
  device: Dimensions | null | undefined,
  frame: Dimensions | null | undefined,
  scale: number
): Dimensions | null {
  if (isValidDimensions(device)) {
    return { width: Math.round(device.width), height: Math.round(device.height) };
  }
  if (!isValidDimensions(frame)) {
    return null;
  }
  const effectiveScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    width: Math.max(1, Math.round(frame.width * effectiveScale)),
    height: Math.max(1, Math.round(frame.height * effectiveScale))
  };
}

export function alignControlDimensionsToFrame(
  device: Dimensions | null | undefined,
  frame: Dimensions | null | undefined,
  scale: number
): Dimensions | null {
  if (!isValidDimensions(device)) {
    return resolveControlDimensions(null, frame, scale);
  }
  const aligned = { width: Math.round(device.width), height: Math.round(device.height) };
  if (!isValidDimensions(frame)) {
    return aligned;
  }
  const derived = resolveControlDimensions(null, frame, scale)!;
  const deviceOrientation = Math.sign(aligned.width - aligned.height);
  const frameOrientation = Math.sign(frame.width - frame.height);
  const oriented = deviceOrientation !== 0 && frameOrientation !== 0 && deviceOrientation !== frameOrientation
    ? { width: aligned.height, height: aligned.width }
    : aligned;
  const widthDifference = Math.abs(oriented.width - derived.width) / derived.width;
  const heightDifference = Math.abs(oriented.height - derived.height) / derived.height;
  return widthDifference > 0.05 || heightDifference > 0.05
    ? derived
    : oriented;
}

export function mapClientPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  device: Dimensions
): Point | null {
  if (rect.width <= 0 || rect.height <= 0 || device.width <= 0 || device.height <= 0) {
    return null;
  }
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  if (localX < 0 || localY < 0 || localX > rect.width || localY > rect.height) {
    return null;
  }
  return {
    x: clamp(Math.round((localX / rect.width) * device.width), 0, device.width - 1),
    y: clamp(Math.round((localY / rect.height) * device.height), 0, device.height - 1)
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isValidDimensions(value: Dimensions | null | undefined): value is Dimensions {
  return Boolean(
    value
    && Number.isFinite(value.width)
    && Number.isFinite(value.height)
    && value.width > 0
    && value.height > 0
  );
}
