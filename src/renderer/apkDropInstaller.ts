import { deviceKey, type DeviceInfo } from "../shared/types";

export interface ApkDropState {
  dragging: boolean;
  busy: boolean;
  fileName: string;
  targetLabel: string;
}

interface Options {
  surface: EventTarget;
  target(): DeviceInfo | undefined;
  isConnecting(): boolean;
  install(key: string, file: File): Promise<void>;
  beforeInstall(): void;
  changed(state: ApkDropState): void;
  notify(message: string): void;
}

export class ApkDropInstaller {
  private depth = 0;
  private state: ApkDropState = { dragging: false, busy: false, fileName: "", targetLabel: "" };
  private readonly listeners: [string, EventListener][];

  constructor(private readonly options: Options) {
    this.listeners = [
      ["dragenter", (event) => {
        if (!this.isFileDrag(event)) return;
        event.preventDefault();
        this.depth++;
        this.update({ dragging: true });
      }],
      ["dragover", (event) => {
        event.preventDefault();
        const transfer = (event as DragEvent).dataTransfer;
        if (transfer) transfer.dropEffect = this.isFileDrag(event) ? "copy" : "none";
      }],
      ["dragleave", () => {
        if (--this.depth <= 0) { this.depth = 0; this.update({ dragging: false }); }
      }],
      ["drop", (event) => {
        event.preventDefault();
        this.depth = 0;
        this.update({ dragging: false });
        void this.installFiles(Array.from((event as DragEvent).dataTransfer?.files ?? []));
      }]
    ];
    for (const [type, listener] of this.listeners) options.surface.addEventListener(type, listener);
  }

  get busy(): boolean { return this.state.busy; }

  dispose(): void {
    for (const [type, listener] of this.listeners) this.options.surface.removeEventListener(type, listener);
  }

  async installFiles(files: File[]): Promise<void> {
    if (this.busy) { this.options.notify("正在安装 APK，请等待本次安装完成"); return; }
    if (files.length !== 1 || !/\.apk$/i.test(files[0]!.name)) {
      this.options.notify("请一次拖入一个 .apk 文件（暂不支持拆分安装包）"); return;
    }
    if (this.options.isConnecting()) { this.options.notify("正在连接设备，请等待连接完成后再安装 APK"); return; }
    const target = this.readyTarget();
    if (!target) { this.options.notify("请先选择一台已授权的 Android / ADB USB 设备"); return; }
    const file = files[0]!;
    const key = deviceKey(target);
    this.update({ busy: true, fileName: file.name, targetLabel: target.label });
    try {
      this.options.beforeInstall();
      await this.options.install(key, file);
      this.options.notify(`APK 安装成功：${file.name}`);
    } catch (error) {
      this.options.notify(error instanceof Error ? error.message : "APK 安装失败，请检查手机连接后重试");
    } finally {
      this.update({ busy: false, fileName: "", targetLabel: "" });
    }
  }

  private readyTarget(): DeviceInfo | undefined {
    const device = this.options.target();
    return device?.backend === "adb" && device.state === "ready" && device.transport === "USB" ? device : undefined;
  }

  private isFileDrag(event: Event): boolean {
    return Array.from((event as DragEvent).dataTransfer?.types ?? []).includes("Files");
  }

  private update(state: Partial<ApkDropState>): void {
    this.state = { ...this.state, ...state };
    this.options.changed(this.state);
  }
}
