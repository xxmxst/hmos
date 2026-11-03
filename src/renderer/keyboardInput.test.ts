import { describe, expect, it, vi } from "vitest";
import { KeyboardInput } from "./keyboardInput";
import type { ControlCommand } from "../shared/types";

function fixture(send = vi.fn<(command: ControlCommand) => Promise<void>>().mockResolvedValue(undefined)) {
  const doc = { activeElement: null as unknown, defaultView: new EventTarget() };
  class Input extends EventTarget {
    value = "";
    style = {};
    ownerDocument = doc;
    focus() { doc.activeElement = this; }
    blur() { doc.activeElement = null; this.dispatchEvent(new Event("blur")); }
  }
  const input = new Input();
  const error = vi.fn();
  const paste = vi.fn().mockResolvedValue(undefined);
  const keyboard = new KeyboardInput(input as never, () => true, send, paste, error);
  const focus = () => keyboard.focus(10, 10, { left: 0, top: 0, width: 100, height: 100 } as DOMRect);
  focus();
  const fire = (type: string, properties: Record<string, unknown> = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), properties);
    input.dispatchEvent(event);
    return event;
  };
  const key = (key: string, flags: Record<string, unknown> = {}) => fire("keydown", {
    key, keyCode: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    isComposing: false, getModifierState: () => false, ...flags
  });
  const text = (data: string, type = "insertText", isComposing = false) => fire("input", { data, inputType: type, isComposing });
  return { input, doc, keyboard, send, paste, error, fire, key, text, focus };
}

describe("keyboard and IME input", () => {
  it("sends committed characters and preserves editing modifiers in order", async () => {
    const f = fixture();
    f.text("Abc!123");
    expect(f.key("Backspace").defaultPrevented).toBe(true);
    f.key("ArrowLeft", { shiftKey: true, ctrlKey: true });
    f.key("Enter");
    await f.keyboard.idle();
    expect(f.send.mock.calls.map(([command]) => command)).toEqual([
      { kind: "text", text: "Abc!123" },
      { kind: "keyboard", key: "Backspace", ctrl: false, alt: false, shift: false },
      { kind: "keyboard", key: "ArrowLeft", ctrl: true, alt: false, shift: true },
      { kind: "keyboard", key: "Enter", ctrl: false, alt: false, shift: false }
    ]);
  });

  it("submits Chinese only once after compositionend and ignores the trailing input", async () => {
    const f = fixture();
    f.fire("compositionstart");
    f.text("zhongwen", "insertCompositionText", true);
    expect(f.key("Enter", { isComposing: true }).defaultPrevented).toBe(false);
    f.fire("compositionend", { data: "中文" });
    f.text("中文", "insertCompositionText");
    await f.keyboard.idle();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith({ kind: "text", text: "中文" });
    expect(f.input.value).toBe("");
  });

  it("supports the final-input-before-compositionend sequence and repeated same-character commits", async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      f.fire("compositionstart");
      f.text("中", "insertCompositionText", false);
      f.fire("compositionend", { data: "中" });
    }
    await f.keyboard.idle();
    expect(f.send.mock.calls.map(([command]) => command)).toEqual([{ kind: "text", text: "中" }, { kind: "text", text: "中" }]);
  });

  it("does not send canceled composition or input from an unfocused field", async () => {
    const f = fixture();
    f.fire("compositionstart");
    f.text("pinyin", "insertCompositionText", true);
    f.fire("compositionend", { data: "" });
    f.input.blur();
    f.input.focus(); // IME may refocus the old editable without a mirror click.
    f.text("ignored");
    await f.keyboard.idle();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("leaves app shortcuts and IME layout keys to the existing handlers", async () => {
    const f = fixture();
    expect(f.key("v", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(f.key("Escape").defaultPrevented).toBe(false);
    expect(f.key("h", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    f.key("a", { ctrlKey: true });
    await f.keyboard.idle();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith({ kind: "keyboard", key: "KeyA", ctrl: true, alt: false, shift: false });
  });

  it("queues paste after typed text and cancels queued commands when the session changes", async () => {
    let finish!: () => void;
    const send = vi.fn<(command: ControlCommand) => Promise<void>>()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    const f = fixture(send);
    f.text("first");
    f.text("old session");
    await Promise.resolve();
    f.keyboard.suspend();
    finish();
    await f.keyboard.idle();
    expect(send).toHaveBeenCalledOnce();
    f.focus();
    f.text("new session");
    await f.keyboard.paste();
    expect(send).toHaveBeenCalledTimes(2);
    expect(f.paste).toHaveBeenCalledOnce();
  });
});
