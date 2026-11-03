import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("renderer visibility styles", () => {
  it("hides the empty-state overlay when the hidden attribute is set", () => {
    const css = readFileSync(join(process.cwd(), "src", "renderer", "style.css"), "utf8");
    expect(css).toMatch(/\.empty-state\[hidden\]\s*\{[^}]*display:\s*none;/);
  });

  it("uses OCR symbol boxes instead of selectable substitute-font text", () => {
    const css = readFileSync(join(process.cwd(), "src", "renderer", "style.css"), "utf8");
    expect(css).toMatch(/\.ocr-symbol\.selected[\s\S]*?background:\s*rgba\(43, 123, 236, 0\.48\)/);
    expect(css).not.toContain(".ocr-line");
    expect(css).not.toContain("::selection");
  });
});
