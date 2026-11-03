import { deviceKey, type DeviceInfo } from "../shared/types";

interface ConnectionOptions {
  listDevices(): Promise<DeviceInfo[]>;
  isBusy(): boolean;
  devicesChanged(devices: DeviceInfo[]): void;
  connect(device: DeviceInfo): Promise<void>;
  scanningChanged(): void;
  failed(error: unknown, phase: "discovery" | "connection"): void;
}

/** Detect USB changes in compact mode; attempt each ready device once per attachment. */
export class CompactConnection {
  scanning = false;
  private enabled = false;
  private disposed = false;
  private devices: DeviceInfo[] = [];
  private signature: string | null = null;
  private attempted = new Set<string>();
  private task: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ConnectionOptions) {}

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    clearTimeout(this.timer);
    if (enabled) {
      this.attempted.clear();
      void this.refresh();
    }
  }

  refresh(): Promise<void> {
    if (this.task) return this.task;
    if (this.disposed || this.options.isBusy()) {
      this.schedule();
      return Promise.resolve();
    }
    clearTimeout(this.timer);
    this.scanning = true;
    this.options.scanningChanged();
    this.task = this.scan().finally(() => {
      this.task = null;
      this.scanning = false;
      if (!this.disposed) this.options.scanningChanged();
      this.schedule();
    });
    return this.task;
  }

  markAttempt(key: string): void { this.attempted.add(key); }

  suppressAutomatic(): void {
    for (const device of this.devices) this.attempted.add(deviceKey(device));
  }

  dispose(): void {
    this.disposed = true;
    this.enabled = false;
    clearTimeout(this.timer);
  }

  private async scan(): Promise<void> {
    let devices: DeviceInfo[];
    try { devices = await this.options.listDevices(); }
    catch (error) {
      this.signature = null;
      if (!this.disposed && !this.options.isBusy()) this.options.failed(error, "discovery");
      return;
    }
    if (this.disposed || this.options.isBusy()) return;
    this.devices = devices;
    const ready = devices.filter((device) => device.state === "ready");
    const keys = new Set(ready.map(deviceKey));
    for (const key of this.attempted) if (!keys.has(key)) this.attempted.delete(key);
    const signature = JSON.stringify(devices);
    if (signature !== this.signature) {
      this.signature = signature;
      this.options.devicesChanged(devices);
    }
    const device = ready.length === 1 ? ready[0] : undefined;
    if (!this.enabled || !device || this.options.isBusy() || this.attempted.has(deviceKey(device))) return;
    this.markAttempt(deviceKey(device));
    try { await this.options.connect(device); }
    catch (error) { if (!this.disposed) this.options.failed(error, "connection"); }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.enabled && !this.disposed) this.timer = setTimeout(() => void this.refresh(), 2000);
  }
}
