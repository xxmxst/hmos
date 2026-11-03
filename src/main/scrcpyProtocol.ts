import { EventEmitter } from "node:events";
import { EDIT_KEY_CODES, validateInputText, validateKeyboardCommand } from "../shared/keyboard";
import type { ControlCommand, DeviceScreen } from "../shared/types";
import type { VideoPacket } from "./mirrorBridge";

const MAX_PACKET = 16 * 1024 * 1024;

export function parseScrcpyVersion(output: string): string {
  const version = /^scrcpy\s+(\d+\.\d+(?:\.\d+)?)(?:\s|$)/m.exec(output)?.[1];
  const major = Number(version?.split(".")[0]);
  if (!version || major < 3 || major > 5) {
    throw new Error("当前支持 scrcpy 3.x、4.x 和 5.x，请选择官方完整发行版中的 scrcpy.exe");
  }
  return version;
}

/** scrcpy 3 使用初始尺寸；4/5 使用每次旋转时发送的 session 数据包。 */
export class ScrcpyVideoParser extends EventEmitter {
  private pending = Buffer.alloc(0);
  private initialized = false;
  private sequence = 0;
  private failed = false;

  constructor(private readonly major: number) { super(); }

  push(chunk: Buffer): void {
    if (this.failed) return;
    try {
      this.pending = Buffer.concat([this.pending, chunk]);
      if (!this.initialized) {
        const headerSize = this.major >= 4 ? 69 : 77;
        if (this.pending.length < headerSize) return;
        if (this.pending[0] !== 0 || this.pending.toString("ascii", 65, 69) !== "h264") {
          throw new Error("Android 视频协议不匹配，请确认 scrcpy 与 scrcpy-server 来自同一发行版");
        }
        if (this.major < 4) this.emitScreen(this.pending.readUInt32BE(69), this.pending.readUInt32BE(73));
        this.pending = this.pending.subarray(headerSize);
        this.initialized = true;
      }
      while (this.pending.length >= 12) {
        if (this.major >= 4 && (this.pending[0]! & 0x80)) {
          this.emitScreen(this.pending.readUInt32BE(4), this.pending.readUInt32BE(8));
          this.pending = this.pending.subarray(12);
          continue;
        }
        const size = this.pending.readUInt32BE(8);
        if (size === 0 || size > MAX_PACKET) throw new Error("Android 视频数据包长度无效");
        if (this.pending.length < 12 + size) return;
        const flags = this.pending.readBigUInt64BE(0);
        const configFlag = this.major >= 4 ? 1n << 62n : 1n << 63n;
        const keyFlag = this.major >= 4 ? 1n << 61n : 1n << 62n;
        const packet: VideoPacket = {
          timestampUs: flags & (keyFlag - 1n), sequence: this.sequence++,
          flags: (flags & configFlag ? 1 : 0) | (flags & keyFlag ? 2 : 0),
          data: Buffer.from(this.pending.subarray(12, 12 + size))
        };
        this.pending = this.pending.subarray(12 + size);
        this.emit("video", packet);
      }
    } catch (error) {
      this.failed = true;
      this.pending = Buffer.alloc(0);
      this.emit("error", error);
    }
  }

  private emitScreen(width: number, height: number): void {
    if (width < 1 || height < 1 || width > 16384 || height > 16384) {
      throw new Error("Android 投屏尺寸无效");
    }
    this.emit("screen", { width, height, rotation: 0 } satisfies DeviceScreen);
  }
}

function keyMessages(code: number, meta: number): Buffer[] {
  const message = (key: number, action: number, state: number) => {
    const data = Buffer.alloc(14);
    data[1] = action;
    data.writeUInt32BE(key, 2);
    data.writeUInt32BE(state, 10);
    return data;
  };
  // TextView 的 Shift 选择还依赖实际修饰键事件，单独填写 metaState 不足以选中文字。
  const modifiers: Array<[number, number]> = [
    ...(meta & 0x3000 ? [[113, 0x3000] as [number, number]] : []),
    ...(meta & 0x41 ? [[59, 0x41] as [number, number]] : []),
    ...(meta & 0x12 ? [[57, 0x12] as [number, number]] : [])
  ];
  let held = 0;
  const result: Buffer[] = [];
  for (const [key, bits] of modifiers) { held |= bits; result.push(message(key, 0, held)); }
  result.push(message(code, 0, meta), message(code, 1, meta));
  for (const [key, bits] of modifiers.reverse()) { held &= ~bits; result.push(message(key, 1, held)); }
  return result;
}

export function encodeScrcpyControl(command: ControlCommand, screen: DeviceScreen): Buffer[] {
  if (command.kind === "screen-power") {
    if (typeof command.on !== "boolean") throw new Error("手机屏幕电源状态无效");
    // scrcpy 3/4/5: SET_DISPLAY_POWER (10), followed by a boolean, not KEYCODE_POWER.
    return [Buffer.from([10, command.on ? 1 : 0])];
  }
  if (command.kind === "rotate") return [Buffer.from([11])];
  if (command.kind === "keyboard") {
    validateKeyboardCommand(command);
    const meta = (command.ctrl ? 0x3000 : 0) | (command.shift ? 0x41 : 0) | (command.alt ? 0x12 : 0);
    return keyMessages(EDIT_KEY_CODES[command.key][0], meta);
  }
  if (command.kind === "text") {
    validateInputText(command.text);
    if (!command.text) return [];
    // 普通 ASCII 不触碰手机剪贴板；中文等 Unicode 使用服务端的粘贴通道。
    if (!/^[\x20-\x7e]+$/.test(command.text)) {
      return encodeScrcpyControl({ kind: "paste", text: command.text }, screen);
    }
    const messages: Buffer[] = [];
    for (let offset = 0; offset < command.text.length; offset += 300) {
      const text = Buffer.from(command.text.slice(offset, offset + 300), "utf8");
      const message = Buffer.alloc(5 + text.length);
      message[0] = 1;
      message.writeUInt32BE(text.length, 1);
      text.copy(message, 5);
      messages.push(message);
    }
    return messages;
  }
  if (command.kind === "key") {
    const codes = { Back: 4, Home: 3, Power: 26, VolumeUp: 24, VolumeDown: 25 };
    const code = codes[command.key];
    if (code === undefined) throw new Error("不支持的 Android 按键");
    return keyMessages(code, 0);
  }
  if (command.kind === "paste") {
    const text = Buffer.from(command.text, "utf8");
    if (text.length > 256 * 1024 - 14 || command.text.includes("\0")) {
      throw new Error("Android 粘贴文本不能包含 NUL 或超过 256 KiB");
    }
    const message = Buffer.alloc(14 + text.length);
    message[0] = 9;
    message[9] = 1;
    message.writeUInt32BE(text.length, 10);
    text.copy(message, 14);
    return [message];
  }
  const width = Math.round(command.screenWidth ?? screen.width);
  const height = Math.round(command.screenHeight ?? screen.height);
  if (![width, height, command.x, command.y].every(Number.isFinite)
    || width < 1 || height < 1 || width > 65535 || height > 65535) {
    throw new Error("Android 触控坐标无效");
  }
  const message = Buffer.alloc(command.kind === "touch" ? 32 : 21);
  const offset = command.kind === "touch" ? 10 : 1;
  message.writeUInt32BE(Math.max(0, Math.min(width - 1, Math.round(command.x))), offset);
  message.writeUInt32BE(Math.max(0, Math.min(height - 1, Math.round(command.y))), offset + 4);
  message.writeUInt16BE(width, offset + 8);
  message.writeUInt16BE(height, offset + 10);
  if (command.kind === "touch") {
    message[0] = 2;
    message[1] = { down: 0, up: 1, move: 2 }[command.phase];
    message.writeBigInt64BE(-2n, 2);
    message.writeUInt16BE(command.phase === "up" ? 0 : 65535, 22);
  } else {
    if (command.direction === "stop") return [];
    message[0] = 3;
    message.writeInt16BE(command.direction === "up" ? 2048 : -2048, 15);
  }
  return [message];
}
