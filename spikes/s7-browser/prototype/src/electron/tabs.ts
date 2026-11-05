// The tab host for the Electron checks: tabs as WebContentsViews, each in a session partition, sandboxed, with no
// Node and no preload (spec §12.1), in one of these places:
//   detached      — a WebContentsView in no window at all
//   hiddenWindow  — a view in a BaseWindow that is never shown (shared by several tabs, or one per tab)
//   shown         — a view in a visible window (the browser view), laid out at that view's size
//   osr           — an offscreen-rendering BrowserWindow (frames arrive as 'paint' events; can't be shown as a view)
// Headless tabs are laid out at the agent's 1280x800; a shown tab at the window's 1000x700.
import { BaseWindow, BrowserWindow, nativeImage, WebContentsView, type NativeImage, type WebContents } from "electron";
import { ageMs, decodeMarker, rgbaReader, type Marker } from "../shared/marker.ts";
import { errorText, sleep, waitFor, withTimeout } from "../shared/stats.ts";

export const AGENT_W = 1280;
export const AGENT_H = 800;
export const SHOWN_W = 1000;
export const SHOWN_H = 700;

export type Place = "detached" | "hiddenWindow" | "ownHiddenWindow" | "shown" | "osr";

export interface Tab {
  id: string;
  place: Place;
  partition: string;
  throttling: boolean;
  wc: WebContents;
  view?: WebContentsView;
  /** The window this tab's view is in now (a hidden host or the shown window), or its own OSR window. */
  win?: BaseWindow | BrowserWindow;
  ownWin?: BaseWindow;
  loads: number;
  navigations: number;
  gone: string[];
  /** OSR: paint events and the newest frame. */
  paints: number;
  lastPaint?: { at: number; image: NativeImage };
  debuggerOn: boolean;
}

export interface CreateOptions {
  place: Place;
  partition: string;
  throttling: boolean;
  /** Path and query on the spike server, e.g. "/pages/probe.html?scenario=anim". */
  path: string;
  /** OSR frame rate. */
  fps?: number;
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

export class TabHost {
  private hiddenHost?: BaseWindow;
  private shownWin?: BaseWindow;
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

  async create(o: CreateOptions): Promise<Tab> {
    const id = `t${nextId++}`;
    const webPreferences = {
      partition: o.partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: o.throttling,
    };
    let tab: Tab;
    if (o.place === "osr") {
      const win = new BrowserWindow({ show: false, width: AGENT_W, height: AGENT_H, useContentSize: true, webPreferences: { ...webPreferences, offscreen: true } });
      tab = this.track({ id, place: o.place, partition: o.partition, throttling: o.throttling, wc: win.webContents, win, loads: 0, navigations: 0, gone: [], paints: 0, debuggerOn: false });
      win.webContents.setFrameRate(o.fps ?? 30);
      win.webContents.on("paint", (_e, _dirty, image) => {
        tab.paints++;
        tab.lastPaint = { at: Date.now(), image };
      });
    } else {
      const view = new WebContentsView({ webPreferences });
      tab = this.track({ id, place: o.place, partition: o.partition, throttling: o.throttling, wc: view.webContents, view, loads: 0, navigations: 0, gone: [], paints: 0, debuggerOn: false });
      if (o.place === "hiddenWindow") {
        this.host().contentView.addChildView(view);
        tab.win = this.host();
        view.setBounds({ x: 0, y: 0, width: AGENT_W, height: AGENT_H });
      } else if (o.place === "ownHiddenWindow") {
        const own = new BaseWindow({ show: false, width: AGENT_W, height: AGENT_H, useContentSize: true, title: `S7 hidden ${id}` });
        own.contentView.addChildView(view);
        view.setBounds({ x: 0, y: 0, width: AGENT_W, height: AGENT_H });
        tab.win = own;
        tab.ownWin = own;
      } else if (o.place === "shown") {
        this.shown().contentView.addChildView(view);
        tab.win = this.shown();
        view.setBounds({ x: 0, y: 0, width: SHOWN_W, height: SHOWN_H });
      } else {
        view.setBounds({ x: 0, y: 0, width: AGENT_W, height: AGENT_H }); // detached: bounds, but no parent
      }
    }
    const sep = o.path.includes("?") ? "&" : "?";
    const url = `${this.origin}${o.path}${sep}tab=${id}`;
    await withTimeout(tab.wc.loadURL(url), 20_000, `load ${url}`);
    return tab;
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
    if (t.view === undefined) throw new Error("an OSR tab can't be shown as a view");
    if (t.win !== undefined && t.win !== this.shown()) t.win.contentView.removeChildView(t.view);
    this.shown().contentView.addChildView(t.view);
    t.view.setBounds({ x: 0, y: 0, width: SHOWN_W, height: SHOWN_H });
    t.win = this.shown();
  }

  /** Move a tab back to headless: into its hidden window, or out of every window (detached), at 1280x800. */
  hide(t: Tab, place: "detached" | "hiddenWindow" | "ownHiddenWindow"): void {
    if (t.view === undefined) throw new Error("an OSR tab is always hidden");
    if (t.win !== undefined) t.win.contentView.removeChildView(t.view);
    t.win = undefined;
    if (place === "hiddenWindow") {
      this.host().contentView.addChildView(t.view);
      t.win = this.host();
    } else if (place === "ownHiddenWindow") {
      if (t.ownWin === undefined || t.ownWin.isDestroyed()) t.ownWin = new BaseWindow({ show: false, width: AGENT_W, height: AGENT_H, useContentSize: true });
      t.ownWin.contentView.addChildView(t.view);
      t.win = t.ownWin;
    }
    t.view.setBounds({ x: 0, y: 0, width: AGENT_W, height: AGENT_H });
  }

  async exec<T = unknown>(t: Tab, code: string, ms = 5000): Promise<T> {
    return (await withTimeout(t.wc.executeJavaScript(code, true), ms, `exec in ${t.id}`)) as T;
  }

  async snapshot(t: Tab): Promise<Snapshot> {
    return this.exec<Snapshot>(t, "window.__s7.snapshot()");
  }

  async close(t: Tab): Promise<void> {
    this.tabs.delete(t);
    try {
      if (t.debuggerOn) t.wc.debugger.detach();
    } catch {
      // gone
    }
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
      } else if (method === "osrPaint") {
        const p = await waitFor(() => t.lastPaint, timeoutMs);
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
