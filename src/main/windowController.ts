import { screen, type BrowserWindow } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WindowAction, WindowMode, WindowState } from "../shared/types";
import {
  clampBounds, compactSize, fitCompactBounds, parseWindowPreferences, resizeCompactBounds, validSize,
  type Bounds, type Size, type WindowPreferences
} from "./windowGeometry";

export class WindowController {
  private preferences: WindowPreferences;
  private changing = false;
  private resizing = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private videoTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly window: BrowserWindow, private readonly file: string) {
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { /* First launch or damaged preferences. */ }
    this.preferences = parseWindowPreferences(saved);
    // Native title-bar insets are reliable after the first layout, not during construction.
    window.once("ready-to-show", () => {
      this.changing = true;
      try { this.applyBounds(); } finally { this.changing = false; }
      this.notify();
    });
    window.on("show", () => this.ensureVisible());
    window.on("will-resize", (event, bounds, details) => {
      if (this.preferences.mode !== "compact" || this.changing) return;
      event.preventDefault();
      this.setBounds(resizeCompactBounds(bounds, window.getBounds(), this.preferences.videoSize,
        screen.getDisplayMatching(bounds).workArea, details.edge, this.chrome()));
      this.scheduleSave();
    });
    window.on("resize", () => {
      if (this.changing || this.resizing || window.isMinimized()) return;
      if (this.preferences.mode === "compact" && !window.isMaximized()) {
        const bounds = window.getBounds();
        const fitted = fitCompactBounds(this.preferences.videoSize, screen.getDisplayMatching(bounds).workArea,
          bounds, false, this.chrome());
        if (Math.abs(bounds.width - fitted.width) > 1 || Math.abs(bounds.height - fitted.height) > 1) this.setBounds(fitted);
      }
      this.scheduleSave();
    });
    window.on("move", () => this.scheduleSave());
    window.on("moved", () => this.ensureVisible());
    window.on("restore", () => this.ensureVisible());
    window.on("maximize", () => { this.scheduleSave(); this.notify(); });
    window.on("unmaximize", () => { this.scheduleSave(); this.notify(); });
    window.on("close", () => this.save());
    const displayChanged = () => this.ensureVisible();
    screen.on("display-metrics-changed", displayChanged);
    screen.on("display-removed", displayChanged);
    window.on("closed", () => {
      clearTimeout(this.saveTimer);
      clearTimeout(this.videoTimer);
      screen.removeListener("display-metrics-changed", displayChanged);
      screen.removeListener("display-removed", displayChanged);
    });
  }

  get state(): WindowState {
    return { mode: this.preferences.mode, maximized: this.window.isMaximized() };
  }

  async setMode(mode: WindowMode): Promise<WindowState> {
    if (this.changing || mode === this.preferences.mode) return this.state;
    this.save();
    this.changing = true;
    try {
      if (this.window.isMaximized()) {
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); this.window.removeListener("unmaximize", done); resolve(); };
          const timer = setTimeout(done, 500);
          this.window.once("unmaximize", done);
          this.window.unmaximize();
        });
      }
      this.preferences.mode = mode;
      this.applyBounds();
    } finally { this.changing = false; }
    this.save();
    this.notify();
    return this.state;
  }

  action(action: WindowAction): void {
    if (action === "close") this.window.close();
    else if (action === "minimize") this.window.minimize();
    else if (this.preferences.mode === "full") {
      if (this.window.isMaximized()) this.window.unmaximize(); else this.window.maximize();
    }
  }

  reportVideoSize(value: unknown): void {
    if (!validSize(value)) return;
    const previous = this.preferences.videoSize;
    const changed = value.width * previous.height !== value.height * previous.width;
    this.preferences.videoSize = { width: value.width, height: value.height };
    if (changed) {
      clearTimeout(this.videoTimer);
      this.videoTimer = setTimeout(() => {
        if (this.window.isDestroyed()) return;
        if (this.preferences.mode === "compact" && !this.window.isMinimized()) {
          const bounds = this.window.getBounds();
          const work = screen.getDisplayMatching(bounds).workArea;
          this.setCompactMinimum(work);
          this.setBounds(fitCompactBounds(this.preferences.videoSize, work, bounds, true, this.chrome()));
        }
        this.scheduleSave();
      }, 120);
    }
    this.scheduleSave();
  }

  private chrome(): Size {
    const outer = this.window.getBounds();
    const content = this.window.getContentBounds();
    return { width: Math.max(0, outer.width - content.width), height: Math.max(0, outer.height - content.height) };
  }

  private applyBounds(): void {
    const compact = this.preferences.mode === "compact";
    this.window.setMinimumSize(0, 0);
    this.window.setMaximizable(!compact);
    const saved = compact ? this.preferences.compactBounds : this.preferences.fullBounds;
    const work = (saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay()).workArea;
    if (compact) {
      this.setCompactMinimum(work);
      this.setBounds(fitCompactBounds(this.preferences.videoSize, work, saved, false, this.chrome()));
    } else {
      const bounds = clampBounds(saved ?? { width: 1180, height: 820,
        x: work.x + (work.width - 1180) / 2, y: work.y + (work.height - 820) / 2 }, work);
      this.setBounds(bounds);
      this.window.setMinimumSize(Math.min(820, work.width), Math.min(620, work.height));
      if (this.preferences.fullMaximized) this.window.maximize();
    }
  }

  private setCompactMinimum(work: Bounds): void {
    const size = compactSize(this.preferences.videoSize, work, 0, this.chrome());
    this.window.setMinimumSize(size.width, size.height);
  }

  private setBounds(bounds: Bounds): void {
    this.resizing = true;
    try { this.window.setBounds(bounds); } finally { this.resizing = false; }
  }

  private ensureVisible(): void {
    if (this.changing || this.resizing || this.window.isMinimized() || this.window.isMaximized()) return;
    const bounds = this.window.getBounds();
    const work = screen.getDisplayMatching(bounds).workArea;
    if (this.preferences.mode === "compact") {
      this.setCompactMinimum(work);
      this.setBounds(fitCompactBounds(this.preferences.videoSize, work, bounds, false, this.chrome()));
    } else this.setBounds(clampBounds(bounds, work));
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.changing || this.window.isDestroyed()) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 250);
  }

  private save(): void {
    clearTimeout(this.saveTimer);
    if (this.window.isDestroyed() || this.changing) return;
    if (!this.window.isMinimized()) {
      if (this.preferences.mode === "full") {
        this.preferences.fullBounds = this.window.getNormalBounds();
        this.preferences.fullMaximized = this.window.isMaximized();
      } else this.preferences.compactBounds = this.window.getBounds();
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.preferences), "utf8");
    } catch { console.error("[window] Could not save window preferences"); }
  }

  private notify(): void {
    if (!this.window.webContents.isDestroyed()) this.window.webContents.send("window:state", this.state);
  }
}
