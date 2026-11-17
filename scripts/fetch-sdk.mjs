import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

const url =
  "https://raw.githubusercontent.com/ns-zzj/dsh-hos-scrcpy/c2f94df15542d471f8c5d9908a78e335041caa4f/resources/hosScrcpy-1.0.18-beta.jar";
const expectedSha256 = "2ce60b1893cc2be471a8cd7eab7e4127e41921f1f89a32a134c730ba15c8c0fd";
const destination = "vendor/sdk/hosScrcpy-1.0.18-beta.jar";

const checksum = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

if (existsSync(destination) && checksum(destination) === expectedSha256) {
  console.log("HOScrcpy SDK 已存在且校验通过。");
  process.exit(0);
}

mkdirSync("vendor/sdk", { recursive: true });
rmSync(destination, { force: true });
console.log(`正在下载 ${url}`);
const response = await fetch(url, { redirect: "follow" });
if (!response.ok || !response.body) {
  throw new Error(`下载失败：HTTP ${response.status}`);
}
await finished(Readable.fromWeb(response.body).pipe(createWriteStream(destination)));
const actual = checksum(destination);
if (actual !== expectedSha256) {
  rmSync(destination, { force: true });
  throw new Error(`SDK 校验失败：期望 ${expectedSha256}，实际 ${actual}`);
}
console.log("HOScrcpy SDK 下载完成且 SHA-256 校验通过。");
