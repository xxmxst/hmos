import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("HarmonyOS bridge input policy", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "bridge",
      "src",
      "main",
      "java",
      "cn",
      "hmremote",
      "bridge",
      "ReflectionHosAdapter.java"
    ),
    "utf8"
  );

  it("never creates or invokes a system mouse device", () => {
    expect(source).not.toContain("uinput -M");
    expect(source).not.toContain("onMouseWheel");
  });

  it("uses touch input for wheel scrolling and requests an IDR on ready", () => {
    expect(source).toContain('sendTouch("onTouchDown"');
    expect(source).toContain('sendTouch("onTouchMove"');
    expect(source).toContain('sendTouch("onTouchUp"');
    expect(source).toContain('invokeNoArgs("requestIDRFrame")');
  });
});
