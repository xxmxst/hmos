export const CAPTURE_RECOVERY_TIMEOUT_MS = 12_000;

type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface CaptureRecoveryTimeout {
  kind: "transport" | "first-frame";
  message: string;
}

export class CaptureRecoveryGate {
  private timer: TimeoutHandle | null = null;
  private latestTimeout: CaptureRecoveryTimeout | null = null;

  constructor(
    private readonly onTimeout: (timeout: CaptureRecoveryTimeout) => void,
    private readonly timeoutMs = CAPTURE_RECOVERY_TIMEOUT_MS
  ) {}

  get active(): boolean {
    return this.timer !== null;
  }

  begin(message: string, recoverableHint?: boolean): boolean {
    if (!isRecoverableCaptureError(message, recoverableHint)) {
      return false;
    }
    this.arm({ kind: "transport", message }, false);
    return true;
  }

  awaitFirstFrame(message: string): void {
    this.arm({ kind: "first-frame", message }, true);
  }

  recovered(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.latestTimeout = null;
  }

  dispose(): void {
    this.recovered();
  }

  private arm(timeout: CaptureRecoveryTimeout, restart: boolean): void {
    this.latestTimeout = timeout;
    if (restart && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const latestTimeout = this.latestTimeout;
        this.latestTimeout = null;
        if (latestTimeout) {
          this.onTimeout(latestTimeout);
        }
      }, this.timeoutMs);
    }
  }
}

export function isRecoverableCaptureError(message: string, recoverableHint?: boolean): boolean {
  if (recoverableHint === true) {
    return true;
  }
  const normalized = message.toUpperCase();
  return normalized.includes("UNAVAILABLE")
    && (
      normalized.includes("IO EXCEPTION")
      || normalized.includes("CONNECTION")
      || normalized.includes("CHANNEL")
      || normalized.includes("TRANSPORT")
    );
}

export function friendlyCaptureError(message: string, code?: string): string {
  if (code?.toUpperCase() === "UNAVAILABLE" || message.toUpperCase().includes("UNAVAILABLE")) {
    return "无法连接手机端投屏服务，请停止投屏后重新连接";
  }
  return message || "手机投屏服务发生错误";
}
