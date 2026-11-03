import { randomUUID } from "node:crypto";
import { parseDeviceKey } from "../shared/types";
import { AdbClient } from "./adb";
import { captureDeviceSnapshot, validateImage, type CapturedDeviceSnapshot } from "./deviceSnapshot";
import type { HdcClient } from "./hdc";
import type { RuntimePaths } from "./paths";

export async function captureForDevice(
  paths: RuntimePaths, hdc: HdcClient | null, key: string, purpose: "ocr" | "placeholder"
): Promise<CapturedDeviceSnapshot> {
  const { backend, serial } = parseDeviceKey(key);
  if (backend === "hdc") return captureDeviceSnapshot(hdc, serial, purpose);
  if (!paths.adb) throw new Error("ADB 不可用，请先配置 Android 投屏工具");
  const image = await new AdbClient(paths.adb).capturePng(serial);
  return { id: randomUUID(), image, mimeType: "image/png", ...validateImage(image, "image/png") };
}
