import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const sourceRoot = join("bridge", "src", "main", "java");
const classRoot = join("bridge", "build", "classes");
const jarPath = join("bridge", "build", "hmremote-bridge.jar");

rmSync(classRoot, { recursive: true, force: true });
mkdirSync(classRoot, { recursive: true });

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : path.endsWith(".java") ? [path] : [];
  });

const javaFiles = walk(sourceRoot);
const javac = spawnSync("javac", ["-encoding", "UTF-8", "--release", "17", "-d", classRoot, ...javaFiles], {
  stdio: "inherit",
  shell: false
});
if (javac.status !== 0) {
  process.exit(javac.status ?? 1);
}

mkdirSync(join("bridge", "build"), { recursive: true });
const jar = spawnSync("jar", ["--create", "--file", jarPath, "--main-class", "cn.hmremote.bridge.BridgeMain", "-C", classRoot, "."], {
  stdio: "inherit",
  shell: false
});
process.exit(jar.status ?? 1);
