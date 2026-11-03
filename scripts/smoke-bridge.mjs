import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const bridgeJar = join("bridge", "build", "hmremote-bridge.jar");
const sdkJar = join("vendor", "sdk", "hosScrcpy-1.0.15-beta.jar");
const classPath = `${bridgeJar}${delimiter}${sdkJar}`;
const vendorJava = join(
  "vendor",
  "jre",
  "bin",
  process.platform === "win32" ? "java.exe" : "java"
);
const java = process.env.HMR_JAVA_PATH ?? (existsSync(vendorJava) ? vendorJava : "java");
const runtimeCheck = spawnSync(
  java,
  ["-cp", classPath, "cn.hmremote.bridge.BridgeMain", "--check-runtime"],
  { encoding: "utf8", shell: false, windowsHide: true }
);
if (runtimeCheck.error || runtimeCheck.status !== 0) {
  console.error(
    `Java runtime dependency check failed (${java}):\n${runtimeCheck.stderr || runtimeCheck.error?.message || "unknown error"}`
  );
  process.exit(runtimeCheck.status ?? 1);
}
console.log(`Java runtime dependency check passed: ${java}`);

const child = spawn(
  java,
  ["-cp", classPath, "cn.hmremote.bridge.BridgeMain"],
  { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true }
);

let pending = Buffer.alloc(0);
let sawReady = false;
let sawPing = false;
let stderr = "";

const timeout = setTimeout(() => finish(new Error("边车协议烟雾测试超时")), 5_000);
child.stderr.setEncoding("utf8");
child.stderr.on("data", (text) => {
  stderr += text;
});
child.stdout.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 24) {
    if (pending.subarray(0, 4).toString("ascii") !== "HMR1") {
      finish(new Error("边车协议魔数错误"));
      return;
    }
    const length = pending.readUInt32LE(8);
    if (pending.length < 24 + length) {
      return;
    }
    const type = pending.readUInt8(5);
    const payload = pending.subarray(24, 24 + length);
    pending = pending.subarray(24 + length);
    if (type !== 2) {
      continue;
    }
    const message = JSON.parse(payload.toString("utf8"));
    if (message.type === "event" && message.event === "bridgeReady") {
      sawReady = true;
      child.stdin.write('{"id":1,"command":"ping"}\n');
    }
    if (message.type === "response" && message.id === 1 && message.ok === true) {
      sawPing = true;
      finish();
      return;
    }
  }
});
child.on("error", finish);
child.on("exit", (code) => {
  if (!sawPing) {
    finish(new Error(`边车提前退出：${code}\n${stderr}`));
  }
});

function finish(error) {
  clearTimeout(timeout);
  child.stdin.end();
  child.kill();
  if (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (!sawReady || !sawPing) {
    console.error("边车未完成握手");
    process.exitCode = 1;
    return;
  }
  console.log("边车 HMR1 握手与 ping 请求通过。");
}
