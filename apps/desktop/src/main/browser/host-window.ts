// The hidden host window for the screen-reader hybrid (the owner's decision 93; design A's host, S7 §2–§3, used only
// for bot tabs made while a screen reader is on). A tab in a window that is never shown never draws, so these tabs
// live in a window that is shown but that the person isn't meant to see or use. It exists only while it holds a tab.
//
// Its invariants, each from S7: 1×1 (on Windows a 32×32 tool window, since a smaller one lost its content area at a
// scale of 2), frameless, never focusable, out of the taskbar, the Dock, Mission Control and the Window menu,
// click-through, at opacity 0 where the OS allows it (macOS, Windows; on X11 an empty window shape instead), shown
// without activating, kept out of screen captures, and its pages never throttled.
import { BaseWindow, powerSaveBlocker, type WebContents } from "electron";

/** Linux: how long a new tab keeps the host's pixel after its page loads, so it has drawn once. */
const LINUX_UNSHAPED_AFTER_LOAD_MS = 300;
/** Linux: the longest the host's pixel stays for a new tab, loaded or not. */
const LINUX_UNSHAPED_MAX_MS = 3000;

export class HostWindow {
  private window: BaseWindow | undefined;
  private blocker: number | undefined;
  private starting = 0;

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
    // X11 (and XWayland): no opacity, but an empty window shape shows no pixel and takes no click (S7 §3). It is
    // set once the window is mapped and its first tab draws (`tabStarting`). On Wayland the compositor places a
    // one-pixel window, which the live gates check.
    window.showInactive();
    // App Nap would stop the host's tabs on macOS while the person isn't using Clover.
    this.blocker = powerSaveBlocker.start("prevent-app-suspension");
    this.window = window;
    return window;
  }

  /** A new tab's view was just added. On Linux a page that never drew in a mapped window with a shape doesn't start
   *  drawing once the shape is empty (X11 takes a window with no shape as covered, S7 §3; throttling off keeps only
   *  a page that already draws), so the host shows its one pixel until the new page has loaded and drawn, then takes
   *  it away again. In S7 a shaped host drew at 60 Hz and took no click. Elsewhere nothing changes. */
  tabStarting(contents: WebContents): void {
    const window = this.window;
    if (process.platform !== "linux" || window === undefined || window.isDestroyed()) return;
    this.starting += 1;
    window.setShape([{ x: 0, y: 0, width: 1, height: 1 }]);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(cap);
      this.starting -= 1;
      if (this.starting === 0 && this.window === window && !window.isDestroyed()) window.setShape([]);
    };
    const cap = setTimeout(finish, LINUX_UNSHAPED_MAX_MS);
    contents.once("did-finish-load", () => setTimeout(finish, LINUX_UNSHAPED_AFTER_LOAD_MS));
    contents.once("destroyed", finish);
  }

  /** Closes the host once its last tab is gone. */
  closeIfEmpty(): void {
    const window = this.window;
    if (window === undefined || window.isDestroyed() || window.contentView.children.length > 0) return;
    window.destroy();
    this.window = undefined;
    this.starting = 0;
    if (this.blocker !== undefined && powerSaveBlocker.isStarted(this.blocker)) powerSaveBlocker.stop(this.blocker);
    this.blocker = undefined;
  }
}
