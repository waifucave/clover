// The hidden host window for the screen-reader hybrid (the owner's decision 93; design A's host, S7 §2–§3, used only
// for bot tabs made while a screen reader is on). A tab in a window that is never shown never draws, so these tabs
// live in a window that is shown but that the person isn't meant to see or use. It exists only while it holds a tab.
//
// Its invariants, each from S7: 1×1 (on Windows a 32×32 tool window, since a smaller one lost its content area at a
// scale of 2), frameless, never focusable, out of the taskbar, the Dock, Mission Control and the Window menu,
// click-through, at opacity 0 where the OS allows it (macOS, Windows; on X11 an empty window shape instead), shown
// without activating, kept out of screen captures, and its pages never throttled.
import { BaseWindow, powerSaveBlocker } from "electron";

export class HostWindow {
  private window: BaseWindow | undefined;
  private blocker: number | undefined;

  get(): BaseWindow {
    if (this.window !== undefined && !this.window.isDestroyed()) return this.window;
    const windows = process.platform === "win32";
    const window = new BaseWindow({
      width: windows ? 32 : 1,
      height: windows ? 32 : 1,
      x: 0,
      y: 0,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      transparent: process.platform !== "linux",
      title: "Clover",
      ...(windows ? { type: "toolbar" } : {}),
    });
    window.setIgnoreMouseEvents(true);
    window.setContentProtection(true);
    if (process.platform !== "linux") window.setOpacity(0);
    if (process.platform === "darwin") {
      window.setHiddenInMissionControl(true);
      window.excludedFromShownWindowsMenu = true;
    }
    // X11 (and XWayland): no opacity, but an empty window shape shows no pixel and takes no click (S7 §3). On
    // Wayland the compositor places a one-pixel window, which the live gates check.
    if (process.platform === "linux") window.setShape([]);
    window.showInactive();
    // App Nap would stop the host's tabs on macOS while the person isn't using Clover.
    this.blocker = powerSaveBlocker.start("prevent-app-suspension");
    this.window = window;
    return window;
  }

  /** Closes the host once its last tab is gone. */
  closeIfEmpty(): void {
    const window = this.window;
    if (window === undefined || window.isDestroyed() || window.contentView.children.length > 0) return;
    window.destroy();
    this.window = undefined;
    if (this.blocker !== undefined && powerSaveBlocker.isStarted(this.blocker)) powerSaveBlocker.stop(this.blocker);
    this.blocker = undefined;
  }
}
