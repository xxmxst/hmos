import { describe, expect, it, vi } from "vitest";
import { encodeScrcpyControl } from "./scrcpyProtocol";
import { harmonyKeyboardCodes } from "../shared/keyboard";
import { MirrorBridge } from "./mirrorBridge";

const screen = { width: 1080, height: 2400, rotation: 0 as const };
describe("keyboard control across transports", () => {
  it("splits ASCII at the server limit without truncation or clipboard replacement", () => {
    const messages = encodeScrcpyControl({ kind: "text", text: "A".repeat(601) }, screen);
    expect(messages.map((message) => [message[0], message.readUInt32BE(1)])).toEqual([[1, 300], [1, 300], [1, 1]]);
    expect(messages.map((message) => message.subarray(5).toString()).join("")).toBe("A".repeat(601));
  });
  it("preserves Chinese and emoji via the Unicode paste channel", () => {
    const [message] = encodeScrcpyControl({ kind: "text", text: "中文🙂" }, screen);
    expect(message?.[0]).toBe(9);
    expect(message?.[9]).toBe(1);
    expect(message?.subarray(14).toString()).toBe("中文🙂");
  });
  it("pairs down/up with Android Ctrl+Shift metadata and maps Harmony modifiers separately", () => {
    const command = { kind: "keyboard" as const, key: "ArrowLeft" as const, ctrl: true, shift: true, alt: false };
    const messages = encodeScrcpyControl(command, screen);
    expect(messages.map((message) => [message[1], message.readUInt32BE(2)])).toEqual([[0, 113], [0, 59], [0, 21], [1, 21], [1, 59], [1, 113]]);
    expect(messages.filter((message) => message.readUInt32BE(2) === 21).map((message) => message.readUInt32BE(10))).toEqual([0x3041, 0x3041]);
    expect(messages.at(-1)?.readUInt32BE(10)).toBe(0);
    expect(harmonyKeyboardCodes(command)).toEqual([2072, 2047, 2014]);
  });
  it("rejects invalid key names and oversized text", () => {
    expect(() => encodeScrcpyControl({ kind: "keyboard", key: "__proto__", ctrl: false, shift: false, alt: false } as never, screen)).toThrow("无效");
    expect(() => encodeScrcpyControl({ kind: "text", text: "中".repeat(30_000) }, screen)).toThrow("64 KiB");
  });
  it("routes Harmony text through the existing insertion method and sends only validated numeric keys", async () => {
    const bridge = new MirrorBridge({ hdc: "hdc.exe", java: "java.exe", bridgeJar: "bridge.jar", sdkJar: "sdk.jar" });
    const target = bridge as unknown as { child: object; request: ReturnType<typeof vi.fn> };
    target.child = {};
    target.request = vi.fn().mockResolvedValue({ ok: true });
    await bridge.control({ kind: "text", text: "输入" });
    await bridge.control({ kind: "keyboard", key: "Backspace", ctrl: false, shift: false, alt: false });
    expect(target.request.mock.calls).toEqual([
      ["paste", { text: "输入" }, 15_000], ["keyboard", { keys: "2055" }]
    ]);
  });
});
