import { app, nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HdcClient } from "./hdc";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;

export interface CapturedDeviceSnapshot {
  id: string;
  image: Buffer;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

export async function captureDeviceSnapshot(
  hdc: HdcClient | null,
  serial: string,
  purpose: "ocr" | "placeholder"
): Promise<CapturedDeviceSnapshot> {
  if (!hdc) {
    throw new Error("HDC 不可用");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(serial)) {
    throw new Error("设备序列号无效");
  }

  const id = randomUUID();
  const remotePath = `/data/local/tmp/hmremote-${purpose}-${id}.jpeg`;
  const temporaryDirectory = join(app.getPath("temp"), `hmremote-${purpose}`);
  const localPath = join(temporaryDirectory, `${id}.jpeg`);
  await mkdir(temporaryDirectory, { recursive: true });
  try {
    await hdc.shell(serial, `snapshot_display -f ${remotePath}`, 20_000);
    await hdc.receiveFile(serial, remotePath, localPath);
    const image = await readFile(localPath);
    return {
      id,
      image,
      mimeType: "image/jpeg",
      ...validateImage(image, "image/jpeg")
    };
  } finally {
    await Promise.allSettled([
      hdc.shell(serial, `rm -f ${remotePath}`, 5_000),
      rm(localPath, { force: true })
    ]);
  }
}

export function validateImage(
  image: Buffer,
  declaredMimeType: "image/png" | "image/jpeg"
): { width: number; height: number } {
  if (image.byteLength === 0 || image.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("截图为空或超过 25 MiB");
  }
  const isPng = image.length >= 8
    && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = image.length >= 3
    && image[0] === 0xff
    && image[1] === 0xd8
    && image[2] === 0xff;
  if (
    (declaredMimeType === "image/png" && !isPng)
    || (declaredMimeType === "image/jpeg" && !isJpeg)
  ) {
    throw new Error("截图文件格式与声明类型不一致");
  }
  const size = nativeImage.createFromBuffer(image).getSize();
  if (size.width <= 0 || size.height <= 0 || size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new Error("截图尺寸无效或超过 2000 万像素");
  }
  return size;
}
