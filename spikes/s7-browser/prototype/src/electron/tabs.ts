// The tab host for the Electron checks: tabs as WebContentsViews, each in a session partition, sandboxed, with no
// Node and no preload (spec §12.1), in one of these places:
//   detached         a WebContentsView in no window at all
//   hiddenWindow     a view in a BaseWindow that is never shown (one window shared by many tabs)
//   ownHiddenWindow  the same, one never-shown window per tab
//   invisibleWindow  a view in a window that IS shown, but can't be seen or touched: opacity 0 (macOS, Windows) or
//                    placed off every screen (X11), click-through, not focusable, not in the taskbar (not on Wayland,
//                    where an app can neither hide nor place a shown window)
//   tinyWindow       a view of 1280x800 in a shown 1x1 window, click-through, not focusable, not in the taskbar
//   shown            a view in the visible browser view's window, laid out at that view's size
//   osr              an offscreen-rendering BrowserWindow (frames arrive as 'paint' events; can't be shown as a view)
//   osrView          an offscreen-rendering WebContentsView in no window
// Headless tabs are laid out at the agent's 1280x800; a shown tab at the window's 1000x700.
import { app, BaseWindow, BrowserWindow, nativeImage, screen, WebContentsView, type NativeImage, type WebContents } from "electron";
import { ageMs, decodeMarker, rgbaReader, type Marker } from "../shared/marker.ts";
import { errorText, sleep, waitFor, withTimeout } from "../shared/stats.ts";

export const AGENT_W = 1280;
export const AGENT_H = 800;
export const SHOWN_W = 1000;
export const SHOWN_H = 700;

export type Place = "detached" | "hiddenWindow" | "ownHiddenWindow" | "invisibleWindow" | "tinyWindow" | "shown" | "osr" | "osrView";

/** The places a headless tab can live in, as views that can later be shown. */
export type HeadlessPlace = "detached" | "hiddenWindow" | "ownHiddenWindow" | "invisibleWindow" | "tinyWindow";

export function onWayland(): boolean {
  return process.platform === "linux" && (app.commandLine.getSwitchValue("ozone-platform") === "wayland" || (app.commandLine.getSwitchValue("ozone-platform") === "" && process.env.WAYLAND_DISPLAY !== undefined && process.env.DISPLAY === undefined));
}

/** Whether a place can be made on this platform (an invisible window can't on Wayland). */
export function placeAvailable(p: Place): boolean {
  if (p === "invisibleWindow") return !onWayland();
  return true;
}

export interface Tab {
  id: string;
  place: Place;
  partition: string;
  throttling: boolean;
  wc: WebContents;
  view?: WebContentsView;
  /** The window this tab's view is in now (a hidden host, its own window, or the shown window), or its OSR window. */
  win?: BaseWindow | BrowserWindow;
  /** The window a headless tab goes back to (undefined: detached). */
  home?: BaseWindow;
  ownWin?: BaseWindow;
  loads: number;
  navigations: number;
  gone: string[];
  /** OSR: paint events and the newest frame. */
  paints: number;
  lastPaint?: { at: number; image: NativeImage };
  debuggerOn: boolean;
  /** Frames delivered to a running frame pump. */
  pumpFrames: number;
  pumping: boolean;
  fitted: boolean;
}

export interface CreateOptions {
  place: Place;
  partition: string;
  throttling: boolean;
  /** Path and query on the spike server, e.g. "/pages/probe.html?scenario=anim". */
  path: string;
  /** OSR frame rate. */
  fps?: number;
  /** A shown host window (tiny, invisible) kept above other windows: always on top at the highest level. */
  onTop?: boolean;
}

export interface CaptureResult {
  method: string;
  ok: boolean;
  /** When the picture was asked for (ms since the epoch). */
  askedAt: number;
  ms: number;
  width: number;
  height: number;
  empty: boolean;
  /** How old the picture was when it was asked for (ms; negative: drawn after the call began), from its marker. */
  staleMs?: number;
  frame?: number;
  error?: string;
}

let nextId = 1;

function invisibleWindow(title: string): BaseWindow {
  const w = new BaseWindow({
    show: false, x: 0, y: 0, width: AGENT_W, height: AGENT_H, useContentSize: true, frame: false, focusable: false,
    skipTaskbar: true, hasShadow: false, resizable: false, minimizable: false, maximizable: false, title,
  });
  w.setIgnoreMouseEvents(true);
  if (process.platform === "darwin" || process.platform === "win32") w.setOpacity(0);
  else w.setPosition(-AGENT_W - 200, -AGENT_H - 200); // X11: off every screen
  w.showInactive();
  return w;
}

function tinyWindow(title: string): BaseWindow {
  const w = new BaseWindow({
    show: false, x: 0, y: 0, width: 1, height: 1, useContentSize: true, frame: false, focusable: false,
    skipTaskbar: true, hasShadow: false, resizable: false, minimizable: false, maximizable: false, title,
  });
  w.setIgnoreMouseEvents(true);
  w.showInactive();
  return w;
}

export class TabHost {
  private hiddenHost?: BaseWindow;
  private shownWin?: BaseWindow;
  private coverWin?: BaseWindow;
  private readonly tabs = new Set<Tab>();

  constructor(readonly origin: string) {}

  /** The shared hidden window: created with show:false and never shown. */
  host(): BaseWindow {
    if (this.hiddenHost === undefined || this.hiddenHost.isDestroyed()) {
      this.hiddenHost = new BaseWindow({ show: false, width: AGENT_W, height: AGENT_H, useContentSize: true, title: "S7 hidden host" });
    }
    return this.hiddenHost;
  }

  /** The visible browser view's window. */
  shown(): BaseWindow {
    if (this.shownWin === undefined || this.shownWin.isDestroyed()) {
      this.shownWin = new BaseWindow({ show: true, x: 40, y: 40, width: SHOWN_W, height: SHOWN_H, useContentSize: true, title: "S7 browser view" });
    }
    return this.shownWin;
  }

  /**
   * An opaque window over a tab's host window, as the user's own windows would be on a real desktop: shown without
   * focus, above normal windows (but below an always-on-top host at the "screen-saver" level), click-through. On
   * Wayland, where nothing can be placed, it is made full screen instead. Returns where it ended up.
   */
  cover(t: Tab): string {
    this.uncover();
    const d = screen.getPrimaryDisplay().bounds;
    const at = t.win !== undefined && !t.win.isDestroyed() ? t.win.getBounds() : { x: 0, y: 0, width: 1, height: 1 };
    const x = Math.min(d.x, at.x), y = Math.min(d.y, at.y);
    const w = new BaseWindow({
      show: false, x, y, width: Math.max(d.x + d.width, at.x + at.width) - x, height: Math.max(d.y + d.height, at.y + at.height) - y,
      frame: false, focusable: false, skipTaskbar: true, hasShadow: false, backgroundColor: "#202020", title: "S7 cover",
    });
    w.setIgnoreMouseEvents(true);
    if (onWayland()) w.setFullScreen(true);
    else w.setAlwaysOnTop(true, "floating");
    w.showInactive();
    if (t.win !== undefined && !t.win.isDestroyed() && t.win.isAlwaysOnTop()) t.win.moveTop();
    this.coverWin = w;
    const b = w.getBounds();
    return `cover ${b.x},${b.y} ${b.width}x${b.height} over host ${at.x},${at.y} ${at.width}x${at.height}`;
  }

  uncover(): void {
    if (this.coverWin !== undefined && !this.coverWin.isDestroyed()) this.coverWin.destroy();
    this.coverWin = undefined;
  }

  async create(o: CreateOptions): Promise<Tab> {
    if (!placeAvailable(o.place)) throw new Error(`${o.place} is not possible here`);
    const id = `t${nextId++}`;
    const webPreferences = {
      partition: o.partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: o.throttling,
    };
    const base = { id, place: o.place, partition: o.partition, throttling: o.throttling, loads: 0, navigations: 0, gone: [], paints: 0, debuggerOn: false, pumpFrames: 0, pumping: false, fitted: false };
    let tab: Tab;
    if (o.place === "osr") {
      const win = new BrowserWindow({ show: false, width: AGENT_W, height: AGENT_H, useContentSize: true, webPreferences: { ...webPreferences, offscreen: true } });
      tab = this.track({ ...base, wc: win.webContents, win });
      this.paints(tab, o.fps ?? 30);
    } else if (o.place === "osrView") {
      const view = new WebContentsView({ webPreferences: { ...webPreferences, offscreen: true } });
      view.setBounds({ x: 0, y: 0, width: AGENT_W, height: AGENT_H });
      tab = this.track({ ...base, wc: view.webContents, view });
      this.paints(tab, o.fps ?? 30);
    } else {
      const view = new WebContentsView({ webPreferences });
      tab = this.track({ ...base, wc: view.webContents, view });
      let home: BaseWindow | undefined;
      if (o.place === "hiddenWindow") home = this.host();
      else if (o.place === "ownHiddenWindow") home = new BaseWindow({ show: false, width: AGENT_W, height: AGENT_H, useContentSize: true, title: `S7 hidden ${id}` });
      else if (o.place === "invisibleWindow") home = invisibleWindow(`S7 invisible ${id}`);
      else if (o.place === "tinyWindow") home = tinyWindow(`S7 tiny ${id}`);
      else if (o.place === "shown") home = this.shown();
      if (o.place === "ownHiddenWindow" || o.place === "invisibleWindow" || o.place === "tinyWindow") tab.ownWin = home;
      if (o.onTop === true && home !== undefined && (o.place === "invisibleWindow" || o.place === "tinyWindow")) home.setAlwaysOnTop(true, "screen-saver");
      if (o.place !== "shown") tab.home = home;
      if (home !== undefined) home.contentView.addChildView(view);
      tab.win = home;
      view.setBounds(o.place === "shown" ? { x: 0, y: 0, width: SHOWN_W, height: SHOWN_H } : { x: 0, y: 0, width: AGENT_W, height: AGENT_H });
    }
    const sep = o.path.includes("?") ? "&" : "?";
    const url = `${this.origin}${o.path}${sep}tab=${id}`;
    await withTimeout(tab.wc.loadURL(url), 20_000, `load ${url}`);
    return tab;
  }

  private paints(tab: Tab, fps: number): void {
    tab.wc.setFrameRate(fps);
    tab.wc.on("paint", (_e, _dirty, image) => {
      tab.paints++;
      tab.lastPaint = { at: Date.now(), image };
    });
  }

  private track(t: Tab): Tab {
    t.wc.on("did-finish-load", () => { t.loads++; });
    t.wc.on("did-start-navigation", (details) => { if (details.isMainFrame && !details.isSameDocument) t.navigations++; });
    t.wc.on("render-process-gone", (_e, d) => { t.gone.push(d.reason); });
    this.tabs.add(t);
    return t;
  }

  /** Move a tab into the visible window, at the view's size. */
  show(t: Tab): void {
    if (t.view === undefined || t.place === "osr" || t.place === "osrView") throw new Error("an OSR tab can't be shown as a view");
    if (t.win !== undefined && t.win !== this.shown()) t.win.contentView.removeChildView(t.view);
    this.shown().contentView.addChildView(t.view);
    t.view.setBounds({ x: 0, y: 0, width: SHOWN_W, height: SHOWN_H });
    t.win = this.shown();
  }

  /** Move a tab back to headless: to its home window (or out of every window when detached), at 1280x800. */
  hide(t: Tab): void {
    if (t.view === undefined) throw new Error("no view");
    if (t.win !== undefined) t.win.contentView.removeChildView(t.view);
    t.win = t.home;
    t.home?.contentView.addChildView(t.view);
    t.view.setBounds({ x: 0, y: 0, width: AGENT_W, height: AGENT_H });
  }

  /** The agent's layout for a headless tab, whatever its view's size: a CDP device-metrics override (1280x800 at 1). */
  async fit(t: Tab): Promise<void> {
    await this.debuggerFor(t);
    await t.wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: AGENT_W, height: AGENT_H, deviceScaleFactor: 1, mobile: false });
    t.fitted = true;
  }

  async unfit(t: Tab): Promise<void> {
    if (!t.fitted) return;
    await t.wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    t.fitted = false;
  }

  /**
   * Keep frames coming for a hidden tab: a frame subscription that only counts what it gets. Not `onlyDirty` (round
   * two: a dirty-only subscription on a hidden tab delivered nothing); every frame is copied into an image, so this
   * is a probe of what frames do to the page, not a design.
   */
  startPump(t: Tab): void {
    t.pumpFrames = 0;
    t.wc.beginFrameSubscription(false, () => { t.pumpFrames++; });
    t.pumping = true;
  }

  stopPump(t: Tab): void {
    if (!t.pumping) return;
    t.wc.endFrameSubscription();
    t.pumping = false;
  }

  async exec<T = unknown>(t: Tab, code: string, ms = 5000): Promise<T> {
    return (await withTimeout(t.wc.executeJavaScript(code, true), ms, `exec in ${t.id}`)) as T;
  }

  async snapshot(t: Tab): Promise<Snapshot> {
    return this.exec<Snapshot>(t, "window.__s7.snapshot()");
  }

  async close(t: Tab): Promise<void> {
    this.tabs.delete(t);
    try { this.stopPump(t); } catch { /* gone */ }
    try { if (t.debuggerOn) t.wc.debugger.detach(); } catch { /* gone */ }
    try {
      if (t.view !== undefined && t.win !== undefined && !t.win.isDestroyed()) t.win.contentView.removeChildView(t.view);
      if (t.place === "osr" && t.win !== undefined && !t.win.isDestroyed()) t.win.destroy();
      else if (!t.wc.isDestroyed()) t.wc.close();
      if (t.ownWin !== undefined && !t.ownWin.isDestroyed()) t.ownWin.destroy();
    } catch {
      // already gone
    }
    await sleep(50);
  }

  async closeAll(): Promise<void> {
    for (const t of [...this.tabs]) await this.close(t);
  }

  // --- pictures ---------------------------------------------------------------------------------------------------

  async debuggerFor(t: Tab): Promise<void> {
    if (t.debuggerOn) return;
    t.wc.debugger.attach("1.3");
    t.debuggerOn = true;
    await t.wc.debugger.sendCommand("Page.enable");
  }

  /** One picture of a tab by `method`, decoded for freshness. `innerWidth` is the page's CSS width (for the scale). */
  async capture(t: Tab, method: string, innerWidth: number, timeoutMs = 5000): Promise<CaptureResult> {
    const start = Date.now();
    try {
      let image: NativeImage;
      if (method === "capturePage") {
        image = await withTimeout(t.wc.capturePage(), timeoutMs, "capturePage");
      } else if (method === "capturePageHidden") {
        image = await withTimeout(t.wc.capturePage(undefined, { stayHidden: true }), timeoutMs, "capturePage stayHidden");
      } else if (method === "cdpPng" || method === "cdpJpeg") {
        await this.debuggerFor(t);
        const params = method === "cdpPng" ? { format: "png" } : { format: "jpeg", quality: 80 };
        const r = (await withTimeout(t.wc.debugger.sendCommand("Page.captureScreenshot", { ...params, captureBeyondViewport: false }), timeoutMs, "Page.captureScreenshot")) as { data: string };
        image = nativeImage.createFromBuffer(Buffer.from(r.data, "base64"));
      } else if (method === "frameSub") {
        // one frame from a frame subscription (Chromium's frame-sink video capturer), then unsubscribe
        const wasPumping = t.pumping;
        image = await withTimeout(new Promise<NativeImage>((resolve) => {
          t.wc.beginFrameSubscription(false, (img) => {
            try { t.wc.endFrameSubscription(); } catch { /* ended */ }
            resolve(img);
          });
        }), timeoutMs, "frame subscription").finally(() => {
          try { t.wc.endFrameSubscription(); } catch { /* ended */ }
          if (wasPumping) this.startPump(t);
        });
      } else if (method === "osrPaint") {
        const p = await waitFor(() => (t.lastPaint !== undefined && t.lastPaint.at >= start - 2000 ? t.lastPaint : undefined), timeoutMs);
        if (p === undefined) throw new Error("no paint event");
        image = p.image;
      } else {
        throw new Error(`unknown method ${method}`);
      }
      const ms = Date.now() - start;
      return { method, askedAt: start, ms, ...decodeImage(image, innerWidth, start) };
    } catch (e) {
      return { method, ok: false, askedAt: start, ms: Date.now() - start, width: 0, height: 0, empty: true, error: errorText(e) };
    }
  }
}

export interface Snapshot {
  token: string;
  loadedAt: number;
  navType: string;
  now: number;
  visibility: string;
  hidden: boolean;
  hasFocus: boolean;
  innerWidth: number;
  innerHeight: number;
  dpr: number;
  scrollY: number;
  field: string;
  session: string | null;
  interval: { n: number; lastAt: number; maxGap: number };
  chain: { n: number; lastAt: number; maxGap: number };
  raf: { n: number; lastAt: number; maxGap: number };
  frame: number;
  lastMarkerAt: number;
  sse: { opens: number; errors: number; msgs: number; lastSeq: number; gaps: number };
  media: null | {
    played: number; currentTime: number; paused: boolean; readyState: number; decodedFrames: number; droppedFrames: number;
    pauses: number; plays: number; waiting: number; error: string; audioState: string; audioTime: number;
  };
  events: Array<{ t: number; kind: string; detail?: string }>;
}

/** A NativeImage's pixel size, emptiness and marker. */
export function decodeImage(image: NativeImage, innerWidth: number, askedAt: number): Omit<CaptureResult, "method" | "ms" | "askedAt"> {
  if (image.isEmpty()) return { ok: false, width: 0, height: 0, empty: true, error: "empty image" };
  const size = image.getSize();
  const bmp = image.toBitmap();
  let w = size.width, h = size.height;
  if (w * h * 4 !== bmp.length && w > 0 && h > 0) {
    const f = Math.sqrt(bmp.length / (w * h * 4));
    w = Math.round(w * f);
    h = Math.round(h * f);
  }
  if (w * h * 4 !== bmp.length) return { ok: true, width: w, height: h, empty: false, error: "bitmap size mismatch" };
  const m: Marker | null = innerWidth > 0 ? decodeMarker(rgbaReader(bmp, w, h), w / innerWidth) : null;
  const r: Omit<CaptureResult, "method" | "ms" | "askedAt"> = { ok: true, width: w, height: h, empty: false };
  if (m !== null) { r.staleMs = ageMs(askedAt, m.t24); r.frame = m.frame; }
  return r;
}
