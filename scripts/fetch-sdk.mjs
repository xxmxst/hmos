import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

const url =
  "https://gitcode.com/OpenHarmonyToolkitsPlaza/HOScrcpy/releases/download/v1.0.15-beta/hosScrcpy-1.0.15-beta.jar";
const expectedSha256 = "d2b8091faf75ccda27a1b5b7a8eea2791a2d99c06a1ade8b491ec4679fbdd649";
const destination = "vendor/sdk/hosScrcpy-1.0.15-beta.jar";

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
