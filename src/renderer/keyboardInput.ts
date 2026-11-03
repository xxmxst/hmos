import { EDIT_KEY_CODES, validateInputText, type EditingKey } from "../shared/keyboard";
import type { ControlCommand } from "../shared/types";

/** 用真实 textarea 承接电脑输入法，只转发提交后的文字，不发送组合中的拼音。 */
export class KeyboardInput {
  private armed = false;
  private composing = false;
  private compositionTail: string | null = null;
  private generation = 0;
  private queue = Promise.resolve();
  private pending = 0;
  private windowFocused = true;

  constructor(
    readonly input: HTMLTextAreaElement,
    private readonly enabled: () => boolean,
    private readonly send: (command: ControlCommand) => Promise<void>,
    private readonly sendPaste: () => Promise<void>,
    private readonly onError: (message: string) => void
  ) {
    input.addEventListener("keydown", (event) => this.keydown(event));
    input.addEventListener("input", (event) => this.inputText(event as InputEvent));
    input.addEventListener("compositionstart", () => {
      this.composing = true;
      this.compositionTail = null;
    });
    input.addEventListener("compositionend", (event) => {
      this.composing = false;
      if (this.active() && event.data) this.submitText(event.data);
      this.compositionTail = event.data || null;
      input.value = "";
    });
    input.addEventListener("blur", () => { this.armed = false; this.clearComposition(); });
    const view = input.ownerDocument.defaultView;
    view?.addEventListener("blur", () => { this.windowFocused = false; this.armed = false; this.clearComposition(); });
    view?.addEventListener("focus", () => { this.windowFocused = true; this.armed = this.isTarget(input.ownerDocument.activeElement); });
  }

  isTarget(target: EventTarget | null): boolean { return target === this.input; }

  focus(clientX: number, clientY: number, container: DOMRect): void {
    if (!this.enabled()) return;
    this.input.style.left = `${Math.max(0, Math.min(container.width - 2, clientX - container.left))}px`;
    this.input.style.top = `${Math.max(0, Math.min(container.height - 24, clientY - container.top))}px`;
    this.windowFocused = true;
    this.armed = true;
    this.input.focus({ preventScroll: true });
  }

  /** 断开、切换设备或进入 OCR 后丢弃旧会话中尚未发送的输入。 */
  suspend(): void {
    this.generation++;
    this.armed = false;
    this.clearComposition();
    if (this.isTarget(this.input.ownerDocument.activeElement)) this.input.blur();
  }

  paste(): Promise<void> { return this.enqueue(() => this.sendPaste()); }
  idle(): Promise<void> { return this.queue; }

  private active(): boolean {
    return this.armed && this.enabled() && this.windowFocused && this.isTarget(this.input.ownerDocument.activeElement);
  }

  private keydown(event: KeyboardEvent): void {
    if (!this.active()) return;
    if (this.composing || event.isComposing || event.keyCode === 229) {
      // Esc/Enter/方向键由电脑输入法处理，不触发手机返回或编辑。
      event.stopPropagation();
      return;
    }
    if (event.repeat && this.pending > 0 && Object.hasOwn(EDIT_KEY_CODES, event.key)) {
      event.preventDefault();
      return;
    }
    if (event.metaKey || event.getModifierState("AltGraph")) return;
    if (event.ctrlKey && ["a", "c", "x", "z", "y"].includes(event.key.toLowerCase()) && !event.altKey) {
      event.preventDefault();
      this.dispatch({ kind: "keyboard", key: `Key${event.key.toUpperCase()}` as EditingKey,
        ctrl: true, shift: event.shiftKey, alt: false });
      return;
    }
    // 保留 Ctrl+V、Esc 和项目已有全局快捷键，交由主页面处理。
    if (event.ctrlKey && ["v", "h", "r"].includes(event.key.toLowerCase())) return;
    if (Object.hasOwn(EDIT_KEY_CODES, event.key)) {
      event.preventDefault();
      this.dispatch({ kind: "keyboard", key: event.key as EditingKey,
        ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey });
    }
  }

  private inputText(event: InputEvent): void {
    if (this.composing || event.isComposing) return;
    const text = event.data ?? this.input.value;
    const compositionDuplicate = this.compositionTail !== null && text === this.compositionTail
      && ["insertText", "insertCompositionText", "insertFromComposition"].includes(event.inputType);
    this.compositionTail = null;
    if (this.active() && !compositionDuplicate && event.inputType.startsWith("insert") && text) this.submitText(text);
    this.input.value = "";
  }

  private submitText(text: string): void {
    try { validateInputText(text); this.dispatch({ kind: "text", text }); }
    catch (error) { this.onError(error instanceof Error ? error.message : "输入文本无效"); }
  }

  private dispatch(command: ControlCommand): void {
    void this.enqueue(() => this.send(command)).catch((error) => {
      this.onError(error instanceof Error ? error.message : "键盘输入失败");
    });
  }

  private enqueue(send: () => Promise<void>): Promise<void> {
    if (!this.enabled()) return Promise.resolve();
    if (this.pending >= 128) return Promise.reject(new Error("输入发送速度不足，请稍候再试"));
    const generation = this.generation;
    this.pending++;
    const task = this.queue.then(async () => {
      if (generation === this.generation && this.enabled()) await send();
    }).finally(() => { this.pending--; });
    this.queue = task.catch(() => {});
    return task;
  }

  private clearComposition(): void {
    this.composing = false;
    this.compositionTail = null;
    this.input.value = "";
  }
}
