import { spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const executable = process.platform === "win32" ? "jlink.exe" : "jlink";
const javaHomeTool = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", executable) : executable;
const output = join("vendor", "jre");
const staging = join("vendor", "jre-next");
const backup = join("vendor", "jre-previous");
const javaExecutable = (root) =>
  join(root, "bin", process.platform === "win32" ? "java.exe" : "java");
const requiredModules = [
  "java.base",
  "java.compiler",
  "java.desktop",
  "java.logging",
  "java.management",
  "java.naming",
  "java.net.http",
  "java.sql",
  "jdk.unsupported"
];

if (hasRequiredModules(output)) {
  console.log("最小 JRE 已存在。");
  process.exit(0);
}
rmSync(staging, { recursive: true, force: true });
const result = spawnSync(
  javaHomeTool,
  [
    "--add-modules",
    requiredModules.join(","),
    "--strip-debug",
    "--no-header-files",
    "--no-man-pages",
    "--compress=2",
    "--output",
    staging
  ],
  { stdio: "inherit", shell: false }
);
if (result.error || result.status !== 0) {
  rmSync(staging, { recursive: true, force: true });
  console.error(`\u65e0\u6cd5\u6784\u5efa\u5185\u7f6e JRE\uff1a${result.error?.message ?? `jlink \u9000\u51fa\u7801 ${result.status}`}`);
  process.exit(result.status ?? 1);
}
if (!hasRequiredModules(staging)) {
  rmSync(staging, { recursive: true, force: true });
  console.error("\u65b0\u751f\u6210\u7684\u5185\u7f6e JRE \u7f3a\u5c11\u5fc5\u9700\u6a21\u5757\uff0c\u5df2\u4fdd\u7559\u539f\u8fd0\u884c\u65f6\u3002");
  process.exit(1);
}

rmSync(backup, { recursive: true, force: true });
try {
  if (existsSync(output)) {
    renameSync(output, backup);
  }
  renameSync(staging, output);
} catch (error) {
  if (!existsSync(output) && existsSync(backup)) {
    renameSync(backup, output);
  }
  rmSync(staging, { recursive: true, force: true });
  console.error(`\u65e0\u6cd5\u66ff\u6362\u5185\u7f6e JRE\uff0c\u8bf7\u5148\u5173\u95ed\u6b63\u5728\u8fd0\u884c\u7684\u6295\u5c4f\u5e94\u7528\uff1a${error.message}`);
  process.exit(1);
}

try {
  rmSync(backup, { recursive: true, force: true });
} catch (error) {
  console.warn(`\u65b0\u7248 JRE \u5df2\u542f\u7528\uff0c\u4f46\u65e7\u8fd0\u884c\u65f6\u6682\u65f6\u65e0\u6cd5\u6e05\u7406\uff1a${error.message}`);
}
console.log(`\u5185\u7f6e JRE \u5df2\u91cd\u5efa\u5e76\u9a8c\u8bc1\uff1a${requiredModules.join(", ")}`);

function hasRequiredModules(root) {
  const java = javaExecutable(root);
  if (!existsSync(java)) {
    return false;
  }
  const probe = spawnSync(java, ["--list-modules"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  if (probe.error || probe.status !== 0) {
    return false;
  }
  const modules = new Set(
    probe.stdout
      .split(/\r?\n/)
      .map((line) => line.split("@", 1)[0])
      .filter(Boolean)
  );
  return requiredModules.every((module) => modules.has(module));
}
