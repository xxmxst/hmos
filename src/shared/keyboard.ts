import type { KeyboardCommand } from "./types";

// Android KeyEvent / OpenHarmony KeyCode，两个通道共用逻辑键名。
export const EDIT_KEY_CODES = {
  Enter: [66, 2054], Backspace: [67, 2055], Delete: [112, 2071], Tab: [61, 2049],
  ArrowLeft: [21, 2014], ArrowRight: [22, 2015], ArrowUp: [19, 2012], ArrowDown: [20, 2013],
  Home: [122, 2081], End: [123, 2082], PageUp: [92, 2068], PageDown: [93, 2069],
  KeyA: [29, 2017], KeyC: [31, 2019], KeyX: [52, 2040], KeyZ: [54, 2042], KeyY: [53, 2041]
} as const;

export type EditingKey = keyof typeof EDIT_KEY_CODES;

export function validateKeyboardCommand(command: KeyboardCommand): void {
  if (!Object.hasOwn(EDIT_KEY_CODES, command.key)
    || typeof command.ctrl !== "boolean" || typeof command.alt !== "boolean" || typeof command.shift !== "boolean") {
    throw new Error("键盘指令无效");
  }
}

export function validateInputText(text: string): void {
  if (typeof text !== "string" || text.includes("\0") || new TextEncoder().encode(text).length > 64 * 1024) {
    throw new Error("输入文本无效或超过 64 KiB");
  }
}

export function harmonyKeyboardCodes(command: KeyboardCommand): number[] {
  validateKeyboardCommand(command);
  const codes = [
    ...(command.ctrl ? [2072] : []), ...(command.alt ? [2045] : []),
    ...(command.shift ? [2047] : []), EDIT_KEY_CODES[command.key][1]
  ];
  if (codes.length > 3) throw new Error("鸿蒙键盘最多同时使用两个修饰键");
  return codes;
}
