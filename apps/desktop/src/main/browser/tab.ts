// A tab of the Clover Browser in the app's main process (spec §12.1, the owner's decisions 92–94). Two kinds:
// * `OffscreenTab` (design B, every bot tab by default): an offscreen `BrowserWindow` that is never shown, drawing at
//   the rate the app sets, its frames CPU bitmaps (stock Electron; GPU frames come later, S7 §7.1). The person sees
//   it through the viewport (`viewport.ts`), and it never reloads to be shown or hidden.
// * `HostTab` (the hybrid, only for tabs made while a screen reader is on): a real `WebContentsView` kept in a hidden
//   host window (`host-window.ts`), moved into the app's window to be shown, so a screen reader reads it.
// Either kind lives in its owner's partition, sandboxed, with no Node and no preload, its dialogs answered at once
// (`disableDialogs`: a dialog would otherwise bring an offscreen tab's window on screen on macOS, S7 §7.6).
import { BrowserWindow, WebContentsView, type BaseWindow, type ContextMenuParams, type NativeImage, type Rectangle, type WebContents, type WebPreferences } from "electron";
import { TabDebugger } from "./cdp";
import { AGENT_VIEWPORT, isBrowserUrlAllowed, partitionFor, type AppTabEvent, type Screenshot, type ScreenshotFormat, type TabOwner, type TabPlace, type TabView, type Viewport } from "./contract";
import { FrameStore } from "./frames";
import { guardPage, hardenSession } from "./session";

/** Frame rates (S7 §7.1): a bot's tab draws at 10 fps while nobody watches, at 60 while the person does. */
export const BOT_FPS = 10;
export const WATCHED_FPS = 60;
/** The newest frame is the picture while it is younger than this; older, the tab is asked for a fresh one. */
export const FRESH_MS = 250;
/** A tab asked for a frame that gives none in this long has stalled. A slow machine's full repaint can take over a
 *  second (the linux-arm64 runner drew about 2 frames a second). */
export const STALL_MS = 3000;
/** A new or resized tab's first frame can take longer still: seconds on that runner, and over 5 s on a loaded Linux
 *  runner once (#193's merge-queue run). The tab is asked again every `REPAINT_EVERY_MS` until then. */
export const FIRST_FRAME_MS = 15_000;
/** How often a tab that hasn't answered is asked to repaint again (and the compositor for its copy). */
export const REPAINT_EVERY_MS = 1_000;

export interface TabEnv {
  computer: string;
  report(event: AppTabEvent): void;
  /** A page opened a window: the host decides what becomes of it. */
  windowOpen(tab: BrowserTab, details: { url: string; frameName: string; disposition: string }): ReturnType<Parameters<WebContents["setWindowOpenHandler"]>[0]>;
  /** A page's window was made (cross-site popups stay offscreen tabs). */
  windowCreated(tab: BrowserTab, child: BrowserWindow, details: { url: string }): void;
  /** While the tab is shown: its page asked for its menu, or a file. */
  contextMenu(tab: BrowserTab, params: ContextMenuParams): void;
  fileChooser(tab: BrowserTab, chooser: { backendNodeId: number; mode: string }): void;
  cursor(tab: BrowserTab, type: string): void;
  paint(tab: BrowserTab, dirty: Rectangle, image: NativeImage): void;
  dragIntercepted(tab: BrowserTab, data: unknown): void;
}

export function tabWebPreferences(partition: string, offscreen: boolean): WebPreferences {
  return {
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    backgroundThrottling: false,
    disableDialogs: true,
    spellcheck: false,
    ...(offscreen ? { offscreen: { useSharedTexture: false, deviceScaleFactor: 1 } } : {}),
  };
}

export abstract class BrowserTab {
  readonly partition: string;
  place: TabPlace = "headless";
  viewport: Viewport = { ...AGENT_VIEWPORT };
  view: string | undefined;
  readonly debugger: TabDebugger;
  private closedBy: "user" | "page" | "crash" | undefined;

  protected constructor(readonly id: string, readonly owner: TabOwner, readonly kind: "offscreen" | "host", readonly contents: WebContents, protected readonly env: TabEnv) {
    this.partition = partitionFor(owner);
    this.debugger = new TabDebugger(contents, (method, params) => env.report({ kind: "cdp", id, method, params }));
  }

  /** Wires the page's events; called once by each kind's constructor, after its contents exist. */
  protected wire(): void {
    const c = this.contents;
    hardenSession(c.session); // already done before the tab was made (`prepareTabSession`); a no-op then
    // The URL rule for navigations however they start (the session refuses the requests too), no `beforeunload`
    // prompt, no <webview>, the WebRTC policy.
    guardPage(c);
    c.setWindowOpenHandler((details) => this.env.windowOpen(this, details));
    c.on("did-create-window", (child, details) => this.env.windowCreated(this, child, details));
    for (const ev of ["did-start-loading", "did-stop-loading", "page-title-updated", "did-navigate", "did-navigate-in-page"] as const) {
      c.on(ev as "did-start-loading", () => this.changed());
    }
    c.on("render-process-gone", (_e, details) => {
      if (details.reason === "clean-exit") return;
      this.closedBy = "crash";
      this.close();
    });
    c.on("context-menu", (_e, params) => { if (this.place === "shown") this.env.contextMenu(this, params); });
    c.on("cursor-changed", (_e, type) => { if (this.place === "shown") this.env.cursor(this, type); });
    this.debugger.attach();
    // File choosers never open a native dialog on their own: while shown, the person picks through the app's dialog.
    void this.debugger.internal("Page.enable").then(() => this.debugger.internal("Page.setInterceptFileChooserDialog", { enabled: true })).catch(() => undefined);
    this.debugger.on("Page.fileChooserOpened", (p) => {
      if (this.place === "shown" && typeof p.backendNodeId === "number") this.env.fileChooser(this, { backendNodeId: p.backendNodeId, mode: String(p.mode ?? "selectSingle") });
    });
    this.debugger.on("Input.dragIntercepted", (p) => this.env.dragIntercepted(this, p.data));
  }

  toView(): TabView {
    const c = this.contents;
    const destroyed = c.isDestroyed();
    return {
      id: this.id,
      computer: this.env.computer,
      owner: this.owner,
      partition: this.partition,
      url: destroyed ? "about:blank" : c.getURL() || "about:blank",
      title: destroyed ? "" : c.getTitle(),
      place: this.place,
      viewport: { ...this.viewport },
      loading: destroyed ? false : c.isLoading(),
      heldByUser: false,
    };
  }

  changed(): void {
    if (!this.contents.isDestroyed()) this.env.report({ kind: "changed", tab: this.toView() });
  }

  async navigate(url: string): Promise<void> {
    if (!isBrowserUrlAllowed(url)) throw new Error(`the browser doesn't open ${url}`);
    // Not awaited to the load's end: a slow page shouldn't hold the call (the bot waits for what it needs).
    this.contents.loadURL(url).catch(() => undefined);
    this.changed();
  }

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.debugger.call(method, params);
  }

  abstract setPlace(place: TabPlace, viewport: Viewport, target?: { window: BaseWindow; bounds: Rectangle }): void;
  protected abstract picture(): Promise<{ image: NativeImage; contentAgeMs: number } | undefined>;
  protected abstract destroy(): void;

  async screenshot(format: ScreenshotFormat, quality?: number): Promise<Screenshot> {
    const takenAt = Date.now();
    if (format === "webp") {
      // Electron's images encode PNG and JPEG only: the page's compositor does WebP.
      const r = (await this.debugger.internal("Page.captureScreenshot", { format: "webp", ...(quality !== undefined ? { quality } : {}) })) as { data: string };
      return { format, data: r.data, width: this.viewport.width, height: this.viewport.height, takenAt };
    }
    const pic = await this.picture();
    if (pic === undefined || pic.image.isEmpty()) {
      this.env.report({ kind: "stalled", id: this.id, sinceMs: STALL_MS });
      throw new Error("the tab stopped drawing, so there's no fresh picture of it");
    }
    const { width, height } = pic.image.getSize();
    const data = format === "jpeg" ? pic.image.toJPEG(quality ?? 80) : pic.image.toPNG();
    return { format, data: data.toString("base64"), width, height, takenAt, contentAgeMs: pic.contentAgeMs };
  }

  close(): void {
    if (this.contents.isDestroyed()) return;
    this.debugger.detach();
    this.destroy();
    this.env.report({ kind: "closed", id: this.id, by: this.closedBy ?? "user" });
  }

  get closed(): boolean {
    return this.contents.isDestroyed();
  }
}

/** Design B: never shown, drawing offscreen. */
export class OffscreenTab extends BrowserTab {
  readonly window: BrowserWindow;
  /** Frames at the tab's current size only: one painted before a resize is never a picture of the page now. */
  readonly frames = new FrameStore();
  /** A frame at the current size has come since the tab was made or resized. */
  private drawn = false;

  private constructor(id: string, owner: TabOwner, window: BrowserWindow, env: TabEnv) {
    super(id, owner, "offscreen", window.webContents, env);
    this.window = window;
  }

  static create(id: string, owner: TabOwner, env: TabEnv): OffscreenTab {
    const window = new BrowserWindow({
      show: false,
      width: AGENT_VIEWPORT.width,
      height: AGENT_VIEWPORT.height,
      useContentSize: true,
      title: "Clover",
      skipTaskbar: true,
      webPreferences: tabWebPreferences(partitionFor(owner), true),
    });
    return OffscreenTab.adopt(id, owner, window, env);
  }

  /** A window Electron already made (a page's cross-site popup, made offscreen by the open handler). */
  static adopt(id: string, owner: TabOwner, window: BrowserWindow, env: TabEnv): OffscreenTab {
    // macOS lists every window in the Window and Dock menus unless told not to, shown or not (S7 check2).
    if (process.platform === "darwin") window.excludedFromShownWindowsMenu = true;
    // Windows fits a new window to the screen's work area: the page's size is set after it is made (S7 §7.1).
    window.setContentSize(AGENT_VIEWPORT.width, AGENT_VIEWPORT.height);
    const tab = new OffscreenTab(id, owner, window, env);
    tab.contents.setFrameRate(BOT_FPS);
    tab.contents.on("paint", (_e, dirty, image) => {
      if (tab.fits(image)) {
        tab.drawn = true;
        tab.frames.put(image, Date.now());
      }
      env.paint(tab, dirty, image);
    });
    tab.wire();
    return tab;
  }

  setPlace(place: TabPlace, viewport: Viewport): void {
    this.place = place;
    this.viewport = { ...viewport };
    const [w, h] = this.window.getContentSize();
    if (w !== viewport.width || h !== viewport.height) {
      this.window.setContentSize(viewport.width, viewport.height);
      this.frames.clear();
      this.drawn = false;
    }
    if (place === "resting") {
      this.contents.stopPainting();
    } else {
      if (!this.contents.isPainting()) this.contents.startPainting();
      this.contents.setFrameRate(place === "shown" ? WATCHED_FPS : BOT_FPS);
      this.contents.invalidate();
    }
    this.changed();
  }

  protected async picture(): Promise<{ image: NativeImage; contentAgeMs: number } | undefined> {
    const painting = this.contents.isPainting();
    const newest = this.frames.get();
    const now = Date.now();
    // A still page sends no frames, so an old frame can still be the page as it is; ask for a fresh one to be sure.
    if (painting) {
      if (newest !== undefined && now - newest.at < FRESH_MS) return { image: newest.image, contentAgeMs: now - newest.at };
      // Asked again every second, with the compositor's copy tried between (a repaint request can be lost while a
      // loaded machine catches up), until the tab has had its time.
      const deadline = now + (this.drawn ? STALL_MS : FIRST_FRAME_MS);
      while (Date.now() < deadline && !this.contents.isDestroyed()) {
        const next = this.frames.next(Math.min(REPAINT_EVERY_MS, Math.max(1, deadline - Date.now())));
        this.contents.invalidate();
        const frame = await next;
        if (frame !== undefined) return { image: frame.image, contentAgeMs: Date.now() - frame.at };
        const copy = await withTimeout(this.contents.capturePage(), REPAINT_EVERY_MS).catch(() => undefined);
        if (copy !== undefined && this.fits(copy)) return { image: copy, contentAgeMs: 0 };
      }
      return undefined;
    }
    // Painting stopped (a resting tab), or no frame came: the compositor's own copy (about one frame's wait).
    try {
      const image = await withTimeout(this.contents.capturePage(), STALL_MS);
      // Linux can hand back the compositor's last frame from before a resize: that one isn't the page now.
      if (this.fits(image)) return { image, contentAgeMs: 0 };
    } catch {
      // Below.
    }
    if (painting) return undefined;
    // Linux gives no copy while painting is stopped (M1's CI; Windows does): wake the tab for one frame.
    const next = this.frames.next(this.drawn ? STALL_MS : FIRST_FRAME_MS);
    this.contents.startPainting();
    this.contents.invalidate();
    const frame = await next;
    if (this.place === "resting" && !this.contents.isDestroyed()) this.contents.stopPainting();
    return frame !== undefined ? { image: frame.image, contentAgeMs: Date.now() - frame.at } : undefined;
  }

  /** The image is of the tab at its current size (the offscreen scale factor is 1). */
  fits(image: NativeImage): boolean {
    if (image.isEmpty()) return false;
    const { width, height } = image.getSize();
    return width === this.viewport.width && height === this.viewport.height;
  }

  protected destroy(): void {
    this.window.destroy();
  }
}

/** The hybrid: a real view in the hidden host window, moved into the app's window to be shown. */
export class HostTab extends BrowserTab {
  readonly webView: WebContentsView;
  private parent: BaseWindow;

  private constructor(id: string, owner: TabOwner, webView: WebContentsView, private readonly host: BaseWindow, env: TabEnv) {
    super(id, owner, "host", webView.webContents, env);
    this.webView = webView;
    this.parent = host;
  }

  static create(id: string, owner: TabOwner, host: BaseWindow, env: TabEnv): HostTab {
    const webView = new WebContentsView({ webPreferences: tabWebPreferences(partitionFor(owner), false) });
    host.contentView.addChildView(webView);
    webView.setBounds({ x: 0, y: 0, width: AGENT_VIEWPORT.width, height: AGENT_VIEWPORT.height });
    const tab = new HostTab(id, owner, webView, host, env);
    tab.wire();
    return tab;
  }

  setPlace(place: TabPlace, viewport: Viewport, target?: { window: BaseWindow; bounds: Rectangle }): void {
    this.place = place;
    this.viewport = { ...viewport };
    const next = place === "shown" && target !== undefined ? target.window : this.host;
    if (next !== this.parent) {
      // Moving a view between windows keeps its page: no reload (S7 §1).
      this.parent.contentView.removeChildView(this.webView);
      next.contentView.addChildView(this.webView);
      this.parent = next;
    }
    this.webView.setBounds(place === "shown" && target !== undefined
      ? { x: target.bounds.x, y: target.bounds.y, width: viewport.width, height: viewport.height }
      : { x: 0, y: 0, width: viewport.width, height: viewport.height });
    this.changed();
  }

  protected async picture(): Promise<{ image: NativeImage; contentAgeMs: number } | undefined> {
    try {
      const image = await withTimeout(this.contents.capturePage(undefined, { stayHidden: true }), STALL_MS);
      return image.isEmpty() ? undefined : { image, contentAgeMs: 0 };
    } catch {
      return undefined;
    }
  }

  protected destroy(): void {
    this.parent.contentView.removeChildView(this.webView);
    this.contents.close();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}
