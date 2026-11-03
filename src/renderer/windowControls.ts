import type { WindowState } from "../shared/types";

export class WindowControls {
  private mode: WindowState["mode"] = "full";
  private pending = false;
  private readonly app = document.querySelector<HTMLElement>("#app")!;
  private readonly toggle = document.querySelector<HTMLButtonElement>("#window-mode-toggle")!;
  private readonly connectionPanel = document.querySelector<HTMLElement>("#compact-connection")!;
  private readonly connectionControls = ["device-select", "refresh-devices", "connect-button"].map((id) => {
    const control = document.getElementById(id)!;
    const anchor = document.createComment("connection-control");
    control.before(anchor);
    return { control, anchor };
  });

  constructor(private readonly onModeChanged: () => void, private readonly onError: (message: string) => void) {
    this.toggle.addEventListener("click", () => void this.changeMode());
    document.querySelector("#expand-connect")!.addEventListener("click", () => void this.changeMode("full"));
    window.hmRemote.onWindowState((state) => this.apply(state));
    void window.hmRemote.getWindowState().then((state) => this.apply(state))
      .catch(() => onError("无法读取窗口模式"));
  }

  private async changeMode(mode: WindowState["mode"] = this.mode === "full" ? "compact" : "full"): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    this.toggle.disabled = true;
    try { this.apply(await window.hmRemote.setWindowMode(mode)); }
    catch { this.onError("窗口模式切换失败，请重试"); }
    finally { this.pending = false; this.toggle.disabled = false; }
  }

  private apply(state: WindowState): void {
    const changed = this.mode !== state.mode;
    this.mode = state.mode;
    this.app.dataset.windowMode = state.mode;
    this.toggle.title = state.mode === "compact" ? "展开完整模式" : "切换极简模式";
    this.toggle.setAttribute("aria-label", this.toggle.title);
    this.toggle.querySelector("small")!.textContent = state.mode === "compact" ? "展开" : "极简";
    this.toggle.querySelector("span")!.textContent = state.mode === "compact" ? "⤢" : "⤡";
    if (changed) {
      for (const { control, anchor } of this.connectionControls) {
        if (state.mode === "compact") this.connectionPanel.append(control); else anchor.after(control);
      }
      this.onModeChanged();
    }
  }

}
