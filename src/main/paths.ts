import { app } from "electron";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

export interface RuntimePaths {
  adb?: string | null;
  scrcpy?: string | null;
  hdc: string | null;
  java: string | null;
  bridgeJar: string;
  sdkJar: string;
}

function firstExisting(candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return resolve(candidate);
    }
  }
  return null;
}

function commandFromPath(command: string): string | null {
  const extension = process.platform === "win32" ? ".exe" : "";
  for (const item of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(item, `${command}${extension}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function androidToolSettingsFile(): string {
  return join(app.getPath("userData"), "android-tools.json");
}

function configuredScrcpy(): string | undefined {
  try {
    const settings = JSON.parse(readFileSync(androidToolSettingsFile(), "utf8"));
    return typeof settings.scrcpyPath === "string" ? settings.scrcpyPath : undefined;
  } catch { return undefined; }
}

function downloadedScrcpy(): string | undefined {
  const folder = join(process.env.USERPROFILE ?? "", "Downloads");
  try {
    return readdirSync(folder).filter((name) => /^scrcpy-win64-v[345]\./.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(folder, name, "scrcpy.exe")).find(existsSync);
  } catch { return undefined; }
}

export function resolveRuntimePaths(): RuntimePaths {
  const root = app.isPackaged ? process.resourcesPath : process.cwd();
  const scrcpy = firstExisting([
    process.env.HMR_SCRCPY_PATH, configuredScrcpy(),
    join(root, "scrcpy", "scrcpy.exe"), join(root, "vendor", "scrcpy", "scrcpy.exe"),
    commandFromPath("scrcpy") ?? undefined, downloadedScrcpy()
  ]);
  const adb = firstExisting([
    process.env.HMR_ADB_PATH, scrcpy ? join(dirname(scrcpy), "adb.exe") : undefined,
    join(root, "scrcpy", "adb.exe"), join(root, "vendor", "scrcpy", "adb.exe"),
    process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, "platform-tools", "adb.exe") : undefined,
    process.env.ANDROID_SDK_ROOT ? join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb.exe") : undefined,
    commandFromPath("adb") ?? undefined
  ]);
  const hdc = firstExisting([
    process.env.HMR_HDC_PATH,
    join(root, "hdc", "hdc.exe"),
    join(root, "vendor", "hdc", "hdc.exe"),
    "D:\\hdc\\hdc.exe",
    commandFromPath("hdc") ?? undefined
  ]);
  const java = firstExisting([
    process.env.HMR_JAVA_PATH,
    join(root, "jre", "bin", "java.exe"),
    join(root, "vendor", "jre", "bin", "java.exe"),
    commandFromPath("java") ?? undefined
  ]);
  return {
    adb,
    scrcpy,
    hdc,
    java,
    bridgeJar: app.isPackaged
      ? join(root, "bridge", "hmremote-bridge.jar")
      : join(root, "bridge", "build", "hmremote-bridge.jar"),
    sdkJar: app.isPackaged
      ? join(root, "sdk", "hosScrcpy-1.0.15-beta.jar")
      : join(root, "vendor", "sdk", "hosScrcpy-1.0.15-beta.jar")
  };
}
