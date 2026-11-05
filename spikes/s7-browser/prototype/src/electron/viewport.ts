// Round twelve: Winter's model in Electron. Winter's headless tabs were windowless CEF (offscreen rendering, frames as
// shared GPU surfaces) and a live one was shown in the app's panel WITHOUT reloading: the panel is a viewport that
// draws the tab's frames and sends the person's input back. Electron's equivalent is a never-shown offscreen
// BrowserWindow (`webPreferences.offscreen`, frames as `paint` events: GPU shared textures with `useSharedTexture`,
// else CPU bitmaps) and a viewport page in the app's window. Three checks:
//   osr       bot tabs offscreen: the size they get, whether shared textures come on this machine, whether they draw
//             at their own rate with no window, screenshot cost, CPU and memory per tab, against the host window
//   viewport  one shown through the viewport: no reload across show and hide (Winter's oracle: the same document,
//             its timers, its SSE socket, its form state), then every kind of input, a resize, find-in-page, DevTools,
//             the accessibility tree, input-to-frame latency and frames per second against a native view
//   dialogs   JavaScript dialogs answered over CDP, offscreen and in the host window: does a native box still show?
import { app, BaseWindow, BrowserWindow, clipboard, ipcMain, sharedTexture, WebContentsView, type BrowserWindowConstructorOptions, type IpcMainEvent, type KeyboardInputEvent, type MouseInputEvent, type MouseWheelInputEvent, type Rectangle, type WebContents } from "electron";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costStep, rates, type CostStep, type Rates } from "./checks.ts";
import { cpuBetween, sample } from "./metrics.ts";
import { AGENT_H, AGENT_W, osrWindowFix, TabHost, type CaptureResult, type PaintEvent, type Tab } from "./tabs.ts";
import { visibleWindows, type WindowListing } from "./winlist.ts";
import { errorText, sleep, summarize, waitFor, withTimeout, type Summary } from "../shared/stats.ts";
import type { SpikeServer } from "../shared/server.ts";

type Log = (line: string) => void;
type Mode = "texture" | "bitmap";

const VP_W = 1000;
const VP_H = 700;

function box(r: Rectangle | undefined): string {
  return r === undefined ? "-" : `${r.width}x${r.height}+${r.x}+${r.y}`;
}
function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// --- 1. bot tabs offscreen ------------------------------------------------------------------------------------------

export interface OsrSizeRow { variant: string; windowSize: string; contentSize: string; layout: string; frame: string; ok: boolean; error?: string }
export interface OsrRateRow {
  config: string;
  mode: Mode | "host";
  fps?: number;
  painting?: boolean;
  rates?: Rates;
  paintsPerSec?: number;
  texturesPerSec?: number;
  cpuTotal?: number;
  cpuByType?: Record<string, number>;
  rendererPct?: number;
  error?: string;
}
export interface OsrCaptureRow { config: string; method: string; tries: number; ok: number; ms: Summary; staleMs: Summary; size: string; errors: string[] }
export interface OsrCostRow { config: string; perTabMiB: number; perTabCpuPct: number; base: CostStep; step: CostStep; error?: string }
export interface OsrResult {
  sizes: OsrSizeRow[];
  sizeFix: string;
  texture: { textures: number; popups: number; bitmaps: number; empties: number; paints: number; works: boolean; info?: Record<string, unknown>; error?: string };
  rates: OsrRateRow[];
  captures: OsrCaptureRow[];
  cost: OsrCostRow[];
  windows: Record<string, WindowListing>;
  error?: string;
}

const SIZE_VARIANTS: Array<{ name: string; opts: Partial<BrowserWindowConstructorOptions>; after?: (w: BrowserWindow) => void }> = [
  { name: "default", opts: {} },
  { name: "setContentSize after creation", opts: {}, after: (w) => w.setContentSize(AGENT_W, AGENT_H) },
  { name: "not resizable, then setContentSize", opts: { resizable: false }, after: (w) => w.setContentSize(AGENT_W, AGENT_H) },
  { name: "enableLargerThanScreen, then setContentSize", opts: { enableLargerThanScreen: true }, after: (w) => w.setContentSize(AGENT_W, AGENT_H) },
  { name: "not resizable, enableLargerThanScreen, then setBounds", opts: { resizable: false, enableLargerThanScreen: true }, after: (w) => w.setBounds({ x: 0, y: 0, width: AGENT_W, height: AGENT_H }) },
];

async function measure(host: TabHost, t: Tab, seconds: number): Promise<Omit<OsrRateRow, "config" | "mode">> {
  await host.exec(t, "window.__s7.resetGaps()");
  const a = await host.snapshot(t);
  const p0 = t.paints, x0 = t.textures;
  const m0 = sample();
  await sleep(seconds * 1000);
  const b = await host.snapshot(t);
  const m1 = sample();
  const cpu = cpuBetween(m0, m1);
  return {
    rates: rates(a, b),
    paintsPerSec: (t.paints - p0) / cpu.seconds,
    texturesPerSec: (t.textures - x0) / cpu.seconds,
    cpuTotal: cpu.total,
    cpuByType: cpu.byType,
    rendererPct: cpu.byPid[String(t.wc.getOSProcessId())] ?? Number.NaN,
  };
}

/** Which shared-texture result this machine gives, decided once per run (the viewport check reads it). */
export let textureWorks: boolean | undefined;

export async function osrCheck(host: TabHost, log: Log): Promise<OsrResult> {
  const result: OsrResult = { sizes: [], sizeFix: "default", texture: { textures: 0, popups: 0, bitmaps: 0, empties: 0, paints: 0, works: false }, rates: [], captures: [], cost: [], windows: {} };
  try {
    // a. the size an OSR tab gets (Windows fits a new window to the screen's work area)
    let chosen: (typeof SIZE_VARIANTS)[number] | undefined;
    for (const [i, v] of SIZE_VARIANTS.entries()) {
      osrWindowFix.name = v.name;
      osrWindowFix.opts = v.opts;
      osrWindowFix.after = v.after;
      const row: OsrSizeRow = { variant: v.name, windowSize: "-", contentSize: "-", layout: "-", frame: "-", ok: false };
      let t: Tab | undefined;
      try {
        t = await host.create({ place: "osr", partition: `bot-osr-size-${i}`, throttling: false, path: "/pages/probe.html?scenario=static&sse=0", fps: 30 });
        await sleep(1200);
        const s = await host.snapshot(t);
        const win = t.win as BrowserWindow;
        row.windowSize = win.getSize().join("x");
        row.contentSize = win.getContentSize().join("x");
        row.layout = `${s.innerWidth}x${s.innerHeight}@${s.dpr}`;
        row.frame = t.dirtyLog.at(-1)?.size ?? "-";
        row.ok = s.innerWidth === AGENT_W && s.innerHeight === AGENT_H;
      } catch (e) {
        row.error = errorText(e);
      } finally {
        if (t !== undefined) await host.close(t);
      }
      result.sizes.push(row);
      log(`  osr size, ${v.name}: window ${row.windowSize}, content ${row.contentSize}, page ${row.layout}, frame ${row.frame}${row.error ? `, error ${row.error}` : ""}`);
      if (row.ok && chosen === undefined) chosen = v;
      if (row.ok && i === 0) break; // nothing to undo on this OS
    }
    const fix = chosen ?? SIZE_VARIANTS[0]!;
    osrWindowFix.name = fix.name;
    osrWindowFix.opts = fix.opts;
    osrWindowFix.after = fix.after;
    result.sizeFix = chosen === undefined ? "none gave 1280x800" : fix.name;

    // b. do shared textures come here? (Electron drops a frame the capturer gave in CPU memory: no paint at all)
    {
      let t: Tab | undefined;
      try {
        t = await host.create({ place: "osr", osrTexture: true, partition: "bot-osr-texture", throttling: false, path: "/pages/probe.html?scenario=anim&sse=0", fps: 30 });
        let info: Record<string, unknown> | undefined;
        t.sink = (p: PaintEvent) => {
          if (p.texture !== undefined && info === undefined) {
            const ti = p.texture.textureInfo;
            info = { widgetType: ti.widgetType, pixelFormat: ti.pixelFormat, codedSize: `${ti.codedSize.width}x${ti.codedSize.height}`, visibleRect: box(ti.visibleRect), contentRect: box(ti.contentRect), handle: Object.keys(ti.handle ?? {}), colorSpace: ti.colorSpace, metadata: ti.metadata };
          }
          p.texture?.release();
        };
        await sleep(3000);
        result.texture = { textures: t.textures, popups: t.popupTextures, bitmaps: t.paints - t.textures - t.popupTextures - t.emptyPaints, empties: t.emptyPaints, paints: t.paints, works: t.textures > 0, info };
      } catch (e) {
        result.texture.error = errorText(e);
      } finally {
        if (t !== undefined) await host.close(t);
      }
      textureWorks = result.texture.works;
      log(`  osr shared textures: ${result.texture.textures} textures, ${result.texture.bitmaps} bitmaps, ${result.texture.empties} empty paints in 3 s → ${result.texture.works ? "textures work here" : "no textures here: the CPU bitmap path"}${result.texture.info ? ` (${JSON.stringify(result.texture.info).slice(0, 200)})` : ""}`);
    }

    // c. do they draw at their own rate with no window, and what does it cost?
    const modes: Mode[] = result.texture.works ? ["texture", "bitmap"] : ["bitmap"];
    const cfgs: Array<{ config: string; mode: Mode | "host"; fps?: number; painting?: boolean; page: string }> = [];
    for (const mode of modes) {
      for (const fps of [10, 30, 60]) cfgs.push({ config: `offscreen, ${mode}, ${fps} fps, animated`, mode, fps, painting: true, page: "anim" });
      cfgs.push({ config: `offscreen, ${mode}, 30 fps, painting stopped, animated`, mode, fps: 30, painting: false, page: "anim" });
      cfgs.push({ config: `offscreen, ${mode}, 10 fps, quiet page`, mode, fps: 10, painting: true, page: "idle" });
      cfgs.push({ config: `offscreen, ${mode}, painting stopped, quiet page`, mode, fps: 10, painting: false, page: "idle" });
    }
    cfgs.push({ config: "host window, animated", mode: "host", page: "anim" });
    cfgs.push({ config: "host window, quiet page", mode: "host", page: "idle" });
    for (const c of cfgs) {
      const row: OsrRateRow = { config: c.config, mode: c.mode, fps: c.fps, painting: c.painting };
      let t: Tab | undefined;
      try {
        const path = `/pages/probe.html?scenario=${c.page}&sse=0`;
        t = c.mode === "host"
          ? await host.create({ place: "tinyWindow", partition: `bot-osr-rate-${result.rates.length}`, throttling: false, path })
          : await host.create({ place: "osr", osrTexture: c.mode === "texture", partition: `bot-osr-rate-${result.rates.length}`, throttling: false, path, fps: c.fps });
        if (c.painting === false) t.wc.stopPainting();
        await sleep(1500);
        Object.assign(row, await measure(host, t, 4));
        log(`  osr ${c.config}: rAF ${row.rates?.rafHz.toFixed(1)} Hz (${row.rates?.visibility}), paints ${row.paintsPerSec?.toFixed(1)}/s (textures ${row.texturesPerSec?.toFixed(1)}/s), CPU ${row.cpuTotal?.toFixed(1)}% (renderer ${row.rendererPct?.toFixed(1)}, GPU ${(row.cpuByType?.GPU ?? 0).toFixed(1)}, browser ${(row.cpuByType?.Browser ?? 0).toFixed(1)})`);
      } catch (e) {
        row.error = errorText(e);
        log(`  osr ${c.config}: ERROR ${row.error}`);
      } finally {
        if (t !== undefined) await host.close(t);
      }
      result.rates.push(row);
    }

    // d. screenshots
    const capCfgs: Array<{ config: string; mode: Mode | "host"; painting: boolean }> = [];
    for (const mode of modes) for (const painting of [true, false]) capCfgs.push({ config: `offscreen, ${mode}, painting ${painting ? "on (10 fps)" : "stopped"}`, mode, painting });
    capCfgs.push({ config: "host window", mode: "host", painting: true });
    for (const c of capCfgs) {
      let t: Tab | undefined;
      try {
        const path = "/pages/probe.html?scenario=anim&sse=0";
        t = c.mode === "host"
          ? await host.create({ place: "tinyWindow", partition: `bot-osr-cap-${result.captures.length}`, throttling: false, path })
          : await host.create({ place: "osr", osrTexture: c.mode === "texture", partition: `bot-osr-cap-${result.captures.length}`, throttling: false, path, fps: 10 });
        if (!c.painting) t.wc.stopPainting();
        await sleep(1500);
        const s = await host.snapshot(t);
        const methods = ["capturePage", "cdpJpeg", ...(c.mode === "bitmap" && c.painting ? ["osrPaint"] : [])];
        for (const m of methods) {
          const rs: CaptureResult[] = [];
          for (let i = 0; i < 5; i++) {
            rs.push(await host.capture(t, m, s.innerWidth, 4000));
            if (rs.filter((r) => r.error?.includes("timed out")).length >= 2) break;
            await sleep(100);
          }
          const good = rs.filter((r) => r.ok);
          const row: OsrCaptureRow = { config: c.config, method: m, tries: rs.length, ok: good.length, ms: summarize(good.map((r) => r.ms)), staleMs: summarize(rs.map((r) => r.staleMs ?? Number.NaN)), size: good[0] !== undefined ? `${good[0].width}x${good[0].height}` : "-", errors: [...new Set(rs.map((r) => r.error).filter((e): e is string => e !== undefined))] };
          result.captures.push(row);
          log(`  osr capture ${c.config} / ${m}: ${row.ok}/${row.tries}, p50 ${row.ms.p50} ms, stale p50 ${row.staleMs.p50} ms, ${row.size}${row.errors.length ? `, ${row.errors.join("; ")}` : ""}`);
        }
        if (c.mode === "bitmap" && c.painting && t.lastPaint !== undefined) {
          // a bot's picture from the newest paint: JPEG-encoding it is all the work left
          const ms: number[] = [];
          for (let i = 0; i < 5; i++) { const s0 = performance.now(); t.lastPaint.image.toJPEG(80); ms.push(performance.now() - s0); }
          const sz = t.lastPaint.image.getSize();
          result.captures.push({ config: c.config, method: "newest paint → JPEG", tries: 5, ok: 5, ms: summarize(ms), staleMs: summarize([]), size: `${sz.width}x${sz.height}`, errors: [] });
        }
      } catch (e) {
        result.captures.push({ config: c.config, method: "setup", tries: 0, ok: 0, ms: summarize([]), staleMs: summarize([]), size: "-", errors: [errorText(e)] });
      } finally {
        if (t !== undefined) await host.close(t);
      }
    }

    // e. memory and CPU per tab: four quiet tabs each way
    const best: Mode = result.texture.works ? "texture" : "bitmap";
    const costCfgs: Array<{ config: string; kind: "osr" | "host"; painting: boolean }> = [
      { config: `4 quiet offscreen tabs (${best}, 10 fps)`, kind: "osr", painting: true },
      { config: `4 quiet offscreen tabs (${best}), painting stopped`, kind: "osr", painting: false },
      { config: "4 quiet tabs in one shared host window", kind: "host", painting: true },
    ];
    for (const c of costCfgs) {
      const tabs: Tab[] = [];
      try {
        const base = await costStep(0, 2500, 3000);
        for (let i = 0; i < 4; i++) {
          const path = "/pages/probe.html?scenario=idle&sse=0";
          const t = c.kind === "host"
            ? await host.create({ place: "sharedTinyWindow", partition: `persist:bot-osr-cost-${c.kind}-${i}`, throttling: false, path })
            : await host.create({ place: "osr", osrTexture: best === "texture", partition: `persist:bot-osr-cost-${c.kind}-${i}`, throttling: false, path, fps: 10 });
          if (!c.painting) t.wc.stopPainting();
          tabs.push(t);
        }
        const step = await costStep(4, 3000, 4000);
        if (c.kind === "osr" && c.painting) result.windows["4 offscreen tabs open (nothing else shown)"] = await visibleWindows();
        if (c.kind === "host") result.windows["4 tabs in the shared host window"] = await visibleWindows();
        const row: OsrCostRow = { config: c.config, perTabMiB: (step.memBest - base.memBest) / 4 / 1048576, perTabCpuPct: (step.cpuPct - base.cpuPct) / 4, base, step };
        result.cost.push(row);
        log(`  osr cost ${c.config}: ${row.perTabMiB.toFixed(1)} MiB and ${row.perTabCpuPct.toFixed(2)}% CPU a tab (${step.memKind})`);
      } catch (e) {
        result.cost.push({ config: c.config, perTabMiB: Number.NaN, perTabCpuPct: Number.NaN, base: {} as CostStep, step: {} as CostStep, error: errorText(e) });
      } finally {
        for (const t of tabs) await host.close(t);
      }
    }
    for (const [k, w] of Object.entries(result.windows)) log(`  osr windows on screen, ${k}: ${w.windows !== undefined ? `${w.windows.length} ${JSON.stringify(w.windows)}` : w.error} (${w.tool})`);
  } catch (e) {
    result.error = errorText(e);
    log(`  osr: ERROR ${result.error}`);
  }
  return result;
}

// --- 2. the viewport ------------------------------------------------------------------------------------------------

interface Meta { seq: number; widget: string; fullW: number; fullH: number; x: number; y: number; w: number; h: number; trial?: number }
interface InputEv { type?: string; kind?: string; cmd?: string; text?: string; x?: number; y?: number; [k: string]: unknown }
export interface ViewerStats {
  frames: number; textures: number; bitmaps: number; popups: number; popupSizes: string[]; lastSeq: number; lastSize: string; sizes: string[];
  drawMs: number[]; errors: string[]; inputs: number; control: boolean; cursor: string; textureReceiver: boolean; firstFrameAt: number; lastFrameAt: number;
  focused: string; hasFocus: boolean;
}
interface Probe { tPaint?: number; tDrawn?: number; tShown?: number; seq?: number }

/** The browser view's side: a shown window whose page draws one offscreen tab's frames and sends input back. */
export class Viewport {
  win!: BrowserWindow;
  wc!: WebContents;
  tab?: Tab;
  seq = 0;
  lastSentSeq = 0;
  /** Bitmaps sent and not yet drawn (the viewer acks each frame it draws). */
  readonly bitmapsInFlight = new Set<number>();
  acked = 0;
  ackedSize = "";
  ackLog: Array<{ seq: number; at: number; size: string }> = [];
  sent = 0;
  bytes = 0;
  dropped = 0;
  fullFrames = 0;
  needFull = false;
  carryTrial?: number;
  inFlight = false;
  /** Textures waiting behind the one on its way: the newest of each widget (the page's frame, a popup's). */
  readonly pending = new Map<string, { p: PaintEvent; meta: Meta }>();
  outstanding = 0;
  errors: string[] = [];
  size = { w: 0, h: 0, dpr: 1 };
  control = false;
  probe?: { trial: number; t0: number; rect: Rectangle };
  probes = new Map<number, Probe>();
  forwarded: Record<string, number> = {};
  cursorTypes: string[] = [];
  dragData?: unknown;
  dragEntered = false;
  dragIntercepts = 0;
  dragDispatches: string[] = [];
  dialogs: Array<{ tab: string; at: number; type: string; message: string; hasBrowserHandler: boolean }> = [];
  fileChoosers: Array<{ at: number; mode: string }> = [];
  autoFiles?: string[];
  pasteMode: "paste" | "insertText" = "paste";
  resizeGapMs = 0;
  lastResizeAt = 0;
  resizeTimer?: ReturnType<typeof setTimeout>;
  resizes: string[] = [];
  private readonly cdpWatched = new WeakSet<WebContents>();
  private readonly off: Array<() => void> = [];
  private readonly tabOff: Array<() => void> = [];
  private viewerDebugger = false;

  constructor(readonly host: TabHost, readonly origin: string, readonly root: string) {}

  private err(s: string): void {
    this.errors.push(s);
    if (this.errors.length > 40) this.errors.shift();
  }

  async open(): Promise<void> {
    this.win = new BrowserWindow({
      show: false, x: 60, y: 60, width: VP_W, height: VP_H, useContentSize: true, title: "S7 viewport",
      webPreferences: { preload: join(this.root, "out", "electron", "vp-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.wc = this.win.webContents;
    const on = <A extends unknown[]>(ch: string, fn: (e: IpcMainEvent, ...a: A) => void): void => {
      const h = (e: IpcMainEvent, ...a: unknown[]): void => { if (e.sender === this.wc) fn(e, ...(a as A)); };
      ipcMain.on(ch, h);
      this.off.push(() => ipcMain.removeListener(ch, h));
    };
    on<[InputEv]>("vp-input", (_e, ev) => this.input(ev));
    on<[{ w: number; h: number; dpr: number }]>("vp-size", (_e, s) => { this.size = s; this.applySize(); });
    on<[{ trial: number; tDrawn: number; tShown: number; seq: number }]>("vp-probe", (_e, r) => {
      const x = this.probes.get(r.trial) ?? {};
      Object.assign(x, { tDrawn: r.tDrawn, tShown: r.tShown, seq: r.seq });
      this.probes.set(r.trial, x);
    });
    on<[number, string]>("vp-ack", (_e, seq, size) => {
      this.bitmapsInFlight.delete(seq);
      this.acked = Math.max(this.acked, seq);
      this.ackedSize = size;
      this.ackLog.push({ seq, at: Date.now(), size });
      if (this.ackLog.length > 600) this.ackLog.shift();
    });
    await withTimeout(this.wc.loadURL(`${this.origin}/pages/vp-viewer.html`), 20_000, "load the viewer");
    if (process.platform === "darwin") app.focus({ steal: true });
    this.win.show();
    this.win.focus();
    this.wc.focus();
    await waitFor(() => (this.size.w > 0 ? true : undefined), 5000);
  }

  close(): void {
    this.detach();
    for (const f of this.off.splice(0)) f();
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  /** The viewer's counters (its isolated world answers over IPC). */
  stats(): Promise<ViewerStats | undefined> {
    return new Promise((resolve) => {
      const h = (e: IpcMainEvent, s: ViewerStats): void => {
        if (e.sender !== this.wc) return;
        clearTimeout(timer);
        ipcMain.removeListener("vp-stats", h);
        resolve(s);
      };
      const timer = setTimeout(() => { ipcMain.removeListener("vp-stats", h); resolve(undefined); }, 3000);
      ipcMain.on("vp-stats", h);
      this.wc.send("vp-stats?");
    });
  }

  /** CDP on a tab, with the events the viewport answers: dialogs, file choosers, intercepted drags. */
  async cdp(tab: Tab, method: string, params?: object): Promise<unknown> {
    await this.host.debuggerFor(tab);
    if (!this.cdpWatched.has(tab.wc)) {
      this.cdpWatched.add(tab.wc);
      tab.wc.debugger.on("message", (_e, m: string, p: Record<string, unknown>) => this.onCdp(tab, m, p));
    }
    return tab.wc.debugger.sendCommand(method, params);
  }

  async cdpViewer(method: string, params?: object): Promise<unknown> {
    if (!this.viewerDebugger) { this.wc.debugger.attach("1.3"); this.viewerDebugger = true; }
    return this.wc.debugger.sendCommand(method, params);
  }

  private onCdp(tab: Tab, method: string, p: Record<string, unknown>): void {
    if (method === "Page.javascriptDialogOpening") {
      this.dialogs.push({ tab: tab.id, at: Date.now(), type: String(p.type), message: String(p.message), hasBrowserHandler: p.hasBrowserHandler === true });
    } else if (method === "Page.fileChooserOpened") {
      this.fileChoosers.push({ at: Date.now(), mode: String(p.mode) });
      if (this.autoFiles !== undefined && typeof p.backendNodeId === "number") {
        void tab.wc.debugger.sendCommand("DOM.setFileInputFiles", { files: this.autoFiles, backendNodeId: p.backendNodeId }).catch((e: unknown) => this.err(`setFileInputFiles: ${errorText(e)}`));
      }
    } else if (method === "Input.dragIntercepted") {
      this.dragIntercepts++;
      this.dragData = p.data;
      this.dragEntered = false;
    }
  }

  /** Show `tab`: its frames come here, at the viewport's size and `fps`, and the person's input goes to it. */
  attach(tab: Tab, fps = 60): void {
    this.detach();
    this.tab = tab;
    tab.sink = (p) => this.push(p);
    tab.wc.setFrameRate(fps);
    const onCursor = (_e: unknown, type: string): void => {
      this.cursorTypes.push(type);
      if (this.cursorTypes.length > 100) this.cursorTypes.shift();
      if (!this.wc.isDestroyed()) this.wc.send("vp-cursor", type);
    };
    tab.wc.on("cursor-changed", onCursor);
    this.tabOff.push(() => tab.wc.removeListener("cursor-changed", onCursor));
    this.applySize(true);
    // a fresh whole frame now, for a page that isn't changing: a repaint (bitmaps), or the capturer restarted (textures)
    this.needFull = true;
    if (tab.osrTexture) { tab.wc.stopPainting(); tab.wc.startPainting(); } else tab.wc.invalidate();
    this.control = true;
    this.wc.send("vp-control", true);
  }

  /** Back to headless: no frames here, the bot's 10 fps and its own 1280x800. */
  detach(): void {
    const tab = this.tab;
    if (tab === undefined) return;
    this.control = false;
    if (!this.wc.isDestroyed()) this.wc.send("vp-control", false);
    tab.sink = undefined;
    for (const f of this.tabOff.splice(0)) f();
    for (const x of this.pending.values()) x.p.texture?.release();
    this.pending.clear();
    this.bitmapsInFlight.clear();
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    if (!tab.wc.isDestroyed()) tab.wc.setFrameRate(10);
    if (tab.win !== undefined && !tab.win.isDestroyed()) tab.win.setContentSize(AGENT_W, AGENT_H);
    this.tab = undefined;
  }

  /** Lay the shown tab out at the viewport's size (at most once every `resizeGapMs`, the newest size winning). */
  applySize(force = false): void {
    const tab = this.tab;
    if (tab === undefined || tab.win === undefined || tab.win.isDestroyed() || this.size.w <= 0) return;
    const now = Date.now();
    if (!force && this.resizeGapMs > 0 && now - this.lastResizeAt < this.resizeGapMs) {
      if (this.resizeTimer === undefined) this.resizeTimer = setTimeout(() => { this.resizeTimer = undefined; this.applySize(true); }, this.resizeGapMs - (now - this.lastResizeAt));
      return;
    }
    const w = Math.max(320, Math.min(4096, Math.round(this.size.w)));
    const h = Math.max(240, Math.min(4096, Math.round(this.size.h)));
    const [cw, ch] = tab.win.getContentSize();
    if (cw === w && ch === h) return;
    this.lastResizeAt = now;
    tab.win.setContentSize(w, h);
    this.resizes.push(`${now}:${w}x${h}`);
  }

  private meta(p: PaintEvent): Meta {
    const seq = ++this.seq;
    if (p.texture !== undefined) {
      const ti = p.texture.textureInfo;
      return { seq, widget: ti.widgetType, fullW: ti.visibleRect.width, fullH: ti.visibleRect.height, x: 0, y: 0, w: ti.visibleRect.width, h: ti.visibleRect.height };
    }
    const s = p.image.getSize();
    return { seq, widget: "frame", fullW: s.width, fullH: s.height, x: p.dirty.x, y: p.dirty.y, w: p.dirty.width, h: p.dirty.height };
  }

  private tag(p: PaintEvent, meta: Meta): void {
    const pr = this.probe;
    if (pr === undefined || p.at < pr.t0 || meta.widget !== "frame") return;
    const u = p.texture?.textureInfo.metadata?.captureUpdateRect ?? p.dirty;
    if (!intersects(u, pr.rect)) return;
    meta.trial = pr.trial;
    const r = this.probes.get(pr.trial) ?? {};
    r.tPaint = p.at;
    this.probes.set(pr.trial, r);
    this.probe = undefined;
  }

  private push(p: PaintEvent): void {
    if (this.tab === undefined || this.wc.isDestroyed()) { p.texture?.release(); return; }
    const meta = this.meta(p);
    this.tag(p, meta);
    if (p.texture !== undefined) {
      if (this.inFlight) {
        // one texture on its way at a time: keep only the newest of each widget behind it (dropped, never queued)
        const old = this.pending.get(meta.widget);
        if (old !== undefined) {
          if (old.meta.trial !== undefined && meta.trial === undefined) meta.trial = old.meta.trial;
          old.p.texture?.release();
          this.dropped++;
        }
        this.pending.set(meta.widget, { p, meta });
        return;
      }
      this.sendTexture(p, meta);
      return;
    }
    if (p.image.isEmpty()) return;
    if (this.bitmapsInFlight.size > 3) {
      // the viewer is behind: skip this one, and send the whole frame next
      this.needFull = true;
      this.dropped++;
      if (meta.trial !== undefined) this.carryTrial = meta.trial;
      return;
    }
    if (this.carryTrial !== undefined && meta.trial === undefined) { meta.trial = this.carryTrial; }
    this.carryTrial = undefined;
    let { x, y, w, h } = meta;
    x = Math.max(0, Math.min(x, meta.fullW));
    y = Math.max(0, Math.min(y, meta.fullH));
    w = Math.max(0, Math.min(w, meta.fullW - x));
    h = Math.max(0, Math.min(h, meta.fullH - y));
    let px: Buffer;
    if (this.needFull || (x === 0 && y === 0 && w === meta.fullW && h === meta.fullH)) {
      if (this.needFull) this.fullFrames++;
      this.needFull = false;
      x = 0; y = 0; w = meta.fullW; h = meta.fullH;
      px = p.image.toBitmap();
    } else {
      px = p.image.crop({ x, y, width: w, height: h }).toBitmap();
      if (px.length !== w * h * 4) { x = 0; y = 0; w = meta.fullW; h = meta.fullH; px = p.image.toBitmap(); }
    }
    Object.assign(meta, { x, y, w, h });
    this.wc.send("vp-bitmap", meta, px);
    this.bitmapsInFlight.add(meta.seq);
    this.lastSentSeq = meta.seq;
    this.sent++;
    this.bytes += px.length;
  }

  private sendTexture(p: PaintEvent, meta: Meta): void {
    const tex = p.texture!;
    this.inFlight = true;
    let imported: Electron.SharedTextureImported;
    try {
      this.outstanding++;
      imported = sharedTexture.importSharedTexture({ textureInfo: tex.textureInfo, allReferencesReleased: () => { this.outstanding--; tex.release(); } });
    } catch (e) {
      this.outstanding--;
      tex.release();
      this.inFlight = false;
      this.err(`import: ${errorText(e)}`);
      return;
    }
    sharedTexture.sendSharedTexture({ frame: this.wc.mainFrame, importedSharedTexture: imported }, meta)
      .then(() => { this.lastSentSeq = meta.seq; this.sent++; })
      .catch((e: unknown) => this.err(`send: ${errorText(e)}`))
      .finally(() => {
        imported.release();
        this.inFlight = false;
        const key = this.pending.has("frame") ? "frame" : this.pending.keys().next().value;
        const next = key !== undefined ? this.pending.get(key) : undefined;
        if (key !== undefined) this.pending.delete(key);
        if (next !== undefined) {
          if (this.tab !== undefined && next.p.texture !== undefined) this.sendTexture(next.p, next.meta);
          else next.p.texture?.release();
        }
      });
  }

  private input(ev: InputEv): void {
    const tab = this.tab;
    if (tab === undefined || !this.control || tab.wc.isDestroyed()) return;
    const k = String(ev.type ?? ev.kind);
    this.forwarded[k] = (this.forwarded[k] ?? 0) + 1;
    try {
      if (this.dragData !== undefined && (ev.type === "mouseMove" || ev.type === "mouseUp")) { void this.dragStep(tab, ev); return; }
      if (typeof ev.type === "string") {
        tab.wc.sendInputEvent(ev as unknown as MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent);
        return;
      }
      const text = String(ev.text ?? "");
      switch (ev.kind) {
        case "edit": {
          const cmds: Record<string, () => void> = { selectAll: () => tab.wc.selectAll(), copy: () => tab.wc.copy(), cut: () => tab.wc.cut(), undo: () => tab.wc.undo(), redo: () => tab.wc.redo() };
          cmds[String(ev.cmd)]?.();
          break;
        }
        case "paste":
          if (this.pasteMode === "paste") tab.wc.paste();
          else void tab.wc.insertText(text);
          break;
        case "text":
          void tab.wc.insertText(text);
          break;
        case "ime-set":
          void this.cdp(tab, "Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length }).catch((e: unknown) => this.err(`ime-set: ${errorText(e)}`));
          break;
        case "ime-commit":
          void this.cdp(tab, "Input.insertText", { text }).catch((e: unknown) => this.err(`ime-commit: ${errorText(e)}`));
          break;
        default:
          break;
      }
    } catch (e) {
      this.err(`input ${k}: ${errorText(e)}`);
    }
  }

  /** A drag the browser handed us (Input.setInterceptDrags): the person's moves become drag events, the release a drop. */
  private async dragStep(tab: Tab, ev: InputEv): Promise<void> {
    const x = Number(ev.x), y = Number(ev.y);
    const data = this.dragData;
    try {
      if (ev.type === "mouseMove") {
        const type = this.dragEntered ? "dragOver" : "dragEnter";
        this.dragEntered = true;
        await this.cdp(tab, "Input.dispatchDragEvent", { type, x, y, data });
        if (this.dragDispatches.at(-1) !== type) this.dragDispatches.push(type);
      } else {
        this.dragData = undefined;
        this.dragEntered = false;
        await this.cdp(tab, "Input.dispatchDragEvent", { type: "drop", x, y, data });
        this.dragDispatches.push("drop");
        tab.wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      }
    } catch (e) {
      this.err(`drag: ${errorText(e)}`);
    }
  }
}

export interface StepResult { name: string; ok: boolean; ms?: number; detail: string }
export interface OracleRow { when: string; sameDocument: boolean; ticksAdvanced: boolean; sseKept: boolean; formKept: boolean; layout: string; detail: string }
export interface ViewportResult {
  mode: Mode;
  modeWhy: string;
  shows: Array<{ cycle: number; firstFrameMs?: number; reflowMs?: number; layout?: string; frame?: string; hideMs?: number }>;
  oracle: OracleRow[];
  steps: StepResult[];
  latency: Record<string, { trials: number; ms: Summary; parts?: Record<string, Summary> }>;
  fps: Record<string, Record<string, number | string>>;
  windows: Record<string, WindowListing>;
  viewer?: ViewerStats & { drawMsSummary?: Summary };
  counters?: Record<string, unknown>;
  error?: string;
}

interface PageState {
  token: string; loadedAt: number; ticks: number; sse: { opens: number; msgs: number; errors: number }; field: string; checked: boolean; select: string; focused: string;
  hasFocus: boolean; innerWidth: number; innerHeight: number; dpr: number; scrollY: number; clicks: Array<{ x: number; y: number; t: number }>; keys: string[];
  compositions: string[]; pastes: string[]; inputTypes: string[]; selects: string[]; dialogs: string[]; files: string[]; popup: { opened: boolean; messages: string[] };
  drag: string[]; resizes: string[]; scrolls: number; wheels: number; lat: Array<{ n: number; kind: string; tIn: number; tFrame?: number }>; anim: { on: boolean; frames: number };
  smooth: { startedAt: number; endedAt: number; scrollEvents: number; rafs: number };
}
interface R { x: number; y: number; w: number; h: number; cx: number; cy: number }

const modKey = process.platform === "darwin" ? "meta" : "control";

export async function viewportCheck(host: TabHost, server: SpikeServer, root: string, log: Log): Promise<ViewportResult> {
  if (textureWorks === undefined) {
    // the osr check didn't run: find out here
    const t = await host.create({ place: "osr", osrTexture: true, partition: "bot-vp-texture", throttling: false, path: "/pages/probe.html?scenario=anim&sse=0", fps: 30 });
    await sleep(3000);
    textureWorks = t.textures > 0;
    await host.close(t);
  }
  const forced = process.env.S7_VIEWPORT_MODE;
  const mode: Mode = forced === "bitmap" ? "bitmap" : forced === "texture" ? "texture" : textureWorks ? "texture" : "bitmap";
  const result: ViewportResult = { mode, modeWhy: forced !== undefined ? `forced by S7_VIEWPORT_MODE=${forced}` : textureWorks ? "shared textures come on this machine" : "no shared textures on this machine (no GPU compositing): CPU bitmaps", shows: [], oracle: [], steps: [], latency: {}, fps: {}, windows: {} };
  const vp = new Viewport(host, server.origin, root);
  let tab: Tab | undefined;
  let native: { win: BaseWindow; view: WebContentsView } | undefined;
  const uploadDir = mkdtempSync(join(tmpdir(), "clover-s7-upload-"));
  const vin = (ev: MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent): void => vp.wc.sendInputEvent(ev);
  const vclick = async (x: number, y: number): Promise<void> => {
    vin({ type: "mouseMove", x, y });
    vin({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    await sleep(40);
    vin({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await sleep(60);
  };
  const vkey = async (keyCode: string, char?: string, modifiers?: KeyboardInputEvent["modifiers"]): Promise<void> => {
    vin({ type: "keyDown", keyCode, modifiers });
    if (char !== undefined) vin({ type: "char", keyCode: char, modifiers });
    vin({ type: "keyUp", keyCode, modifiers });
    await sleep(30);
  };
  const step = async (name: string, f: () => Promise<{ ok: boolean; detail: unknown }>): Promise<void> => {
    const t0 = Date.now();
    let r: StepResult;
    try {
      const x = await withTimeout(f(), 30_000, name);
      r = { name, ok: x.ok, ms: Date.now() - t0, detail: typeof x.detail === "string" ? x.detail : JSON.stringify(x.detail) };
    } catch (e) {
      r = { name, ok: false, ms: Date.now() - t0, detail: `error: ${errorText(e)}` };
    }
    result.steps.push(r);
    log(`  viewport ${r.ok ? "ok  " : "FAIL"} ${name} (${r.ms} ms): ${r.detail.slice(0, 400)}`);
  };
  try {
    await vp.open();
    tab = await host.create({ place: "osr", osrTexture: mode === "texture", partition: "persist:bot-vp", throttling: false, path: "/pages/vp-page.html", fps: 10 });
    const t = tab;
    const state = (): Promise<PageState> => host.exec<PageState>(t, "window.__vp.state()");
    const rect = async (id: string): Promise<R> => {
      const r = await host.exec<R | null>(t, `window.__vp.rect(${JSON.stringify(id)})`);
      if (r === null) throw new Error(`no #${id}`);
      return r;
    };
    await vp.cdp(t, "Runtime.enable");
    // a bot types and ticks before anyone looks: form state a reload would lose
    await host.exec(t, `window.__vp.fill("typed by the bot")`);
    await sleep(1500);
    const s0 = await state();
    const loads0 = t.loads, navs0 = t.navigations;
    const oracle = (when: string, a: PageState, b: PageState, field?: string): void => {
      const row: OracleRow = {
        when,
        sameDocument: a.token === b.token && b.token === s0.token && t.loads === loads0 && t.navigations === navs0,
        ticksAdvanced: b.ticks > a.ticks,
        sseKept: b.sse.opens === 1 && server.sseOpens(t.id) === 1 && b.sse.msgs > a.sse.msgs,
        formKept: b.checked && (field === undefined || b.field === field),
        layout: `${b.innerWidth}x${b.innerHeight}@${b.dpr}`,
        detail: `token ${b.token === s0.token ? "same" : "CHANGED"}, loads +${t.loads - loads0}, navigations +${t.navigations - navs0}, ticks ${a.ticks}→${b.ticks}, sse opens ${b.sse.opens} (server ${server.sseOpens(t.id)}) msgs ${a.sse.msgs}→${b.sse.msgs}, field "${b.field}", checked ${b.checked}`,
      };
      result.oracle.push(row);
      log(`  viewport oracle, ${when}: same document ${row.sameDocument}, timers ${row.ticksAdvanced}, socket ${row.sseKept}, form ${row.formKept}; ${row.detail}`);
    };
    result.windows["a hidden offscreen tab and the viewer"] = await visibleWindows();

    // show: the frames come to the viewport, and the page reflows to its size
    const show = async (cycle: number): Promise<void> => {
      const seq0 = vp.seq;
      const t0 = Date.now();
      vp.attach(t, 60);
      const first = await waitFor(() => vp.ackLog.find((a) => a.seq > seq0), 5000, 10);
      const want = `${vp.size.w}x${vp.size.h}`;
      const reflowed = await waitFor(async () => {
        const st = await state();
        return st.innerWidth === vp.size.w && vp.ackedSize === want ? st : undefined;
      }, 5000, 20);
      const sized = vp.ackLog.find((a) => a.seq > seq0 && a.size === want);
      result.shows.push({ cycle, firstFrameMs: first !== undefined ? first.at - t0 : undefined, reflowMs: reflowed !== undefined && sized !== undefined ? sized.at - t0 : undefined, layout: reflowed !== undefined ? `${reflowed.innerWidth}x${reflowed.innerHeight}` : undefined, frame: vp.ackedSize });
      log(`  viewport show ${cycle}: first frame ${first !== undefined ? first.at - t0 : "-"} ms, at the viewport's ${want} ${sized !== undefined ? sized.at - t0 : "-"} ms`);
    };
    const hide = async (): Promise<number | undefined> => {
      const t0 = Date.now();
      vp.detach();
      const back = await waitFor(async () => ((await state()).innerWidth === AGENT_W ? true : undefined), 4000, 20);
      return back !== undefined ? Date.now() - t0 : undefined;
    };
    await show(1);
    await vp.cdp(t, "Emulation.setFocusEmulationEnabled", { enabled: true });
    const s1 = await state();
    oracle("shown (first time)", s0, s1, "typed by the bot");

    // --- input through the viewport ------------------------------------------------------------------------------------
    await step("mouse: a click lands where the person clicked", async () => {
      const r = await rect("btn");
      const n0 = (await state()).clicks.length;
      await vclick(r.cx, r.cy);
      const st = await waitFor(async () => { const s = await state(); return s.clicks.length > n0 ? s : undefined; }, 2000);
      const c = st?.clicks.at(-1);
      return { ok: c !== undefined && Math.abs(c.x - r.cx) <= 2 && Math.abs(c.y - r.cy) <= 2, detail: { at: `${r.cx},${r.cy}`, page: c, forwarded: vp.forwarded } };
    });
    await step("wheel: the page scrolls", async () => {
      await host.exec(t, "window.__vp.scrollTop()");
      await sleep(200);
      vin({ type: "mouseMove", x: 500, y: 450 });
      for (let i = 0; i < 4; i++) { vin({ type: "mouseWheel", x: 500, y: 450, deltaY: -150, canScroll: true }); await sleep(30); }
      const st = await waitFor(async () => { const s = await state(); return s.scrollY > 0 ? s : undefined; }, 2000);
      const s = st ?? (await state());
      await host.exec(t, "window.__vp.scrollTop()");
      return { ok: s.scrollY > 0, detail: { scrollY: s.scrollY, wheels: s.wheels, forwardedWheels: vp.forwarded.mouseWheel ?? 0 } };
    });
    await step("keys: typing, Backspace and select-all in the field", async () => {
      const r = await rect("field");
      await vclick(r.cx, r.cy);
      await vkey("End");
      for (const ch of "abc") await vkey(ch, ch);
      await sleep(300);
      const a = await state();
      await vkey("Backspace");
      await sleep(300);
      const b = await state();
      await vkey("a", undefined, [modKey]);
      await vkey("x", "x");
      await sleep(300);
      const c = await state();
      const typed = a.field === "typed by the botabc";
      const back = b.field === "typed by the botab";
      const all = c.field === "x";
      return { ok: typed && back && all, detail: { typed: a.field, afterBackspace: b.field, afterSelectAllAndX: c.field, focused: c.focused, pageHasFocus: c.hasFocus, keys: c.keys.slice(-8) } };
    });
    await step("IME: a composition in the viewport is composed and committed in the page", async () => {
      const r = await rect("field");
      vp.wc.send("vp-caret", { x: r.x + r.w, y: r.y, h: r.h });
      await vp.cdpViewer("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
      await sleep(250);
      const mid = await state();
      await vp.cdpViewer("Input.insertText", { text: "日本" });
      await sleep(600);
      const st = await state();
      return { ok: st.field.endsWith("日本") && st.compositions.some((c) => c.startsWith("start")) && st.compositions.some((c) => c.startsWith("end")), detail: { field: st.field, midField: mid.field, compositions: st.compositions.slice(-6), forwarded: { set: vp.forwarded["ime-set"] ?? 0, commit: vp.forwarded["ime-commit"] ?? 0, text: vp.forwarded.text ?? 0 } } };
    });
    await step("paste: the person's paste reaches the page as a paste", async () => {
      clipboard.writeText("s7-paste-ok");
      const r = await rect("field");
      await vclick(r.cx, r.cy);
      await vkey("End");
      vp.wc.paste();
      await sleep(800);
      const st = await state();
      return { ok: st.field.includes("s7-paste-ok") && st.pastes.includes("s7-paste-ok"), detail: { field: st.field, pasteEvents: st.pastes, clipboard: clipboard.readText(), forwarded: vp.forwarded.paste ?? 0 } };
    });
    await step("<select>: it opens, and the keys choose an option", async () => {
      const r = await rect("sel");
      const before = { popups: t.popupTextures, dirty: t.dirtyLog.length };
      const v0 = await vp.stats();
      await vclick(r.cx, r.cy);
      await sleep(800);
      const popupDirty = t.dirtyLog.slice(before.dirty).filter((d) => d.widget === "popup" || (d.widget === "bitmap" && d.y >= r.y + r.h - 4 && d.h >= 60));
      result.windows["a <select> open"] = await visibleWindows();
      await vkey("Down");
      await vkey("Down");
      await vkey("Enter");
      await sleep(600);
      const st = await state();
      const v1 = await vp.stats();
      return { ok: st.select !== "a", detail: { value: st.select, changes: st.selects, popupTextures: t.popupTextures - before.popups, popupRects: popupDirty.slice(0, 3).map((d) => `${d.widget} ${d.w}x${d.h}+${d.x}+${d.y}`), viewerPopups: (v1?.popups ?? 0) - (v0?.popups ?? 0), viewerPopupSizes: v1?.popupSizes } };
    });
    await step("cursor: the page's cursor reaches the viewport", async () => {
      const n0 = vp.cursorTypes.length;
      const seen: string[] = [];
      for (const id of ["curPointer", "curText", "curCross", "curMove"]) {
        const r = await rect(id);
        vin({ type: "mouseMove", x: r.cx, y: r.cy });
        await sleep(300);
        seen.push((await vp.stats())?.cursor ?? "?");
      }
      const types = vp.cursorTypes.slice(n0);
      const want = ["text", "crosshair", "move"];
      return { ok: want.every((w) => types.includes(w)) && (types.includes("pointer") || types.includes("hand")), detail: { events: types, viewerCursors: seen } };
    });
    const dragOnce = async (): Promise<string[]> => {
      const a = await rect("drag"), b = await rect("drop");
      const n0 = (await state()).drag.length;
      vin({ type: "mouseMove", x: a.cx, y: a.cy });
      vin({ type: "mouseDown", x: a.cx, y: a.cy, button: "left", clickCount: 1 });
      await sleep(50);
      for (let i = 1; i <= 14; i++) {
        vin({ type: "mouseMove", x: Math.round(a.cx + ((b.cx - a.cx) * i) / 14), y: Math.round(a.cy + ((b.cy - a.cy) * i) / 14), modifiers: ["leftbuttondown"] });
        await sleep(40);
      }
      vin({ type: "mouseUp", x: b.cx, y: b.cy, button: "left", clickCount: 1 });
      await sleep(700);
      return (await state()).drag.slice(n0);
    };
    await step("drag: an HTML5 drag inside the page, sent as plain mouse events", async () => {
      const log2 = await dragOnce();
      return { ok: log2.some((d) => d.startsWith("drop")), detail: { page: log2 } };
    });
    await step("drag: the same, with the browser's drag handed to the viewport (CDP Input.setInterceptDrags)", async () => {
      await vp.cdp(t, "Input.setInterceptDrags", { enabled: true });
      const i0 = vp.dragIntercepts;
      const log2 = await dragOnce();
      await vp.cdp(t, "Input.setInterceptDrags", { enabled: false });
      return { ok: log2.some((d) => d === "drop:s7-dragged"), detail: { page: log2, intercepted: vp.dragIntercepts - i0, dispatched: vp.dragDispatches.slice(-4) } };
    });
    await step("file chooser: answered with a file, no dialog", async () => {
      const f = join(uploadDir, "s7-upload.txt");
      writeFileSync(f, "hello from the viewport");
      vp.autoFiles = [f];
      await vp.cdp(t, "Page.setInterceptFileChooserDialog", { enabled: true });
      const n0 = vp.fileChoosers.length;
      const r = await rect("file");
      await vclick(r.x + 30, r.cy);
      const opened = await waitFor(() => (vp.fileChoosers.length > n0 ? true : undefined), 3000);
      result.windows["a file chooser open"] = await visibleWindows();
      const st = await waitFor(async () => { const s = await state(); return s.files.length > 0 ? s : undefined; }, 3000);
      await vp.cdp(t, "Page.setInterceptFileChooserDialog", { enabled: false });
      vp.autoFiles = undefined;
      return { ok: opened === true && (st?.files.some((x) => x.startsWith("s7-upload.txt:23:hello")) ?? false), detail: { choosers: vp.fileChoosers.slice(n0), files: st?.files } };
    });
    await step("a window the page opens: offscreen too, its opener kept, shown in the viewport and clicked", async () => {
      let child: BrowserWindow | undefined;
      t.wc.setWindowOpenHandler(() => ({
        action: "allow",
        overrideBrowserWindowOptions: { show: false, width: 480, height: 360, webPreferences: { offscreen: mode === "texture" ? { useSharedTexture: true } : true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } },
      }));
      const created = (w: BrowserWindow): void => { child = w; };
      t.wc.once("did-create-window", created);
      const r = await rect("openBtn");
      await vclick(r.cx, r.cy);
      await waitFor(() => child, 4000);
      if (child === undefined) return { ok: false, detail: { opened: (await state()).popup, why: "no did-create-window" } };
      const childTab = host.adopt(child, "persist:bot-vp", 30, mode === "texture");
      const info = { offscreen: child.webContents.isOffscreen(), visible: child.isVisible(), size: child.getSize().join("x") };
      await waitFor(async () => ((await state()).popup.messages.includes("popup:hello") ? true : undefined), 3000);
      await sleep(800);
      const paints = childTab.paints;
      result.windows["the page's window open (offscreen)"] = await visibleWindows();
      let clicked = false;
      if (paints > 0 || info.offscreen) {
        const seq0 = vp.seq;
        vp.attach(childTab, 60);
        await waitFor(() => (vp.ackLog.some((a) => a.seq > seq0 && a.size === `${vp.size.w}x${vp.size.h}`) ? true : undefined), 3000);
        await sleep(300);
        await vclick(100, 40);
        clicked = (await waitFor(async () => ((await state()).popup.messages.includes("popup:click") ? true : undefined), 3000)) === true;
        vp.attach(t, 60);
        await sleep(500);
      }
      const st = await state();
      await host.close(childTab);
      return { ok: info.offscreen && st.popup.messages.includes("popup:hello") && clicked, detail: { ...info, paints, openerMessages: st.popup.messages, clickedInViewport: clicked } };
    });
    await step("resize: the page reflows to the viewport, no reload", async () => {
      const want = async (w: number, h: number, ms: number): Promise<number | undefined> => {
        const t0 = Date.now();
        const ok = await waitFor(async () => ((await state()).innerWidth === w && vp.ackedSize === `${w}x${h}` ? true : undefined), ms, 20);
        return ok === true ? Date.now() - t0 : undefined;
      };
      vp.win.setContentSize(800, 560);
      const one = await want(800, 560, 4000);
      // three changes 40 ms apart: does painting keep up, or stall as CEF's did?
      vp.win.setContentSize(900, 620); await sleep(40);
      vp.win.setContentSize(760, 520); await sleep(40);
      vp.win.setContentSize(820, 580);
      const quick = await want(820, 580, 4000);
      vp.win.setContentSize(VP_W, VP_H);
      const back = await want(VP_W, VP_H, 4000);
      const st = await state();
      return { ok: one !== undefined && quick !== undefined && back !== undefined && st.token === s0.token && t.loads === loads0, detail: { oneMs: one, quickThreeMs: quick, backMs: back, resizes: st.resizes.slice(-6), applied: vp.resizes.slice(-6), token: st.token === s0.token ? "same" : "changed" } };
    });
    await step("find-in-page: matches found and drawn", async () => {
      const found = new Promise<{ matches: number }>((resolve) => t.wc.once("found-in-page", (_e, r) => resolve(r)));
      t.wc.findInPage("drop");
      const r = await withTimeout(found, 4000, "found-in-page");
      t.wc.stopFindInPage("clearSelection");
      return { ok: r.matches >= 1, detail: r };
    });
    await step("DevTools: open on the offscreen tab (detached window)", async () => {
      const opened = new Promise<void>((resolve) => t.wc.once("devtools-opened", () => resolve()));
      t.wc.openDevTools({ mode: "detach", activate: false });
      await withTimeout(opened, 10_000, "devtools-opened");
      const ok = t.wc.isDevToolsOpened();
      t.wc.closeDevTools();
      await sleep(300);
      return { ok, detail: { opened: ok } };
    });
    await step("accessibility: the page's tree is there to read over CDP (the OS sees none of it)", async () => {
      await vp.cdp(t, "Accessibility.enable");
      const tree = (await vp.cdp(t, "Accessibility.getFullAXTree")) as { nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> };
      const button = tree.nodes.some((n) => n.role?.value === "button" && n.name?.value === "Click me");
      return { ok: button, detail: { nodes: tree.nodes.length, button, accessibilitySupport: app.isAccessibilitySupportEnabled() } };
    });
    await step("a 2x display: the device-metrics override at a scale of 2 gives the viewport 2x frames", async () => {
      await vp.cdp(t, "Emulation.setDeviceMetricsOverride", { width: vp.size.w, height: vp.size.h, deviceScaleFactor: 2, mobile: false });
      await sleep(1000);
      const st = await state();
      const frame = t.dirtyLog.at(-1)?.size ?? "-";
      await vp.cdp(t, "Emulation.clearDeviceMetricsOverride");
      await sleep(600);
      return { ok: frame === `${vp.size.w * 2}x${vp.size.h * 2}`, detail: { pageDpr: st.dpr, layout: `${st.innerWidth}x${st.innerHeight}`, frame, viewerCanvas: vp.ackedSize } };
    });
    await step("the tab's webContents.focus(): does the hidden window take the OS focus from the viewport?", async () => {
      const before = vp.win.isFocused();
      t.wc.focus();
      await sleep(500);
      const after = vp.win.isFocused();
      const focusedTitle = BaseWindow.getFocusedWindow()?.getTitle() ?? "(none)";
      const st = await state();
      vp.win.focus();
      vp.wc.focus();
      await sleep(200);
      return { ok: after === before, detail: { viewerFocusedBefore: before, after, focusedWindow: focusedTitle, pageHasFocus: st.hasFocus, tabVisible: (t.win as BrowserWindow).isVisible() } };
    });

    // --- input to frame, frames per second --------------------------------------------------------------------------
    await host.exec(t, "window.__vp.scrollTop()");
    const b = await rect("box");
    await vclick(b.cx, b.cy); // a warm-up, and the field loses focus (no caret blinking into the trials)
    await sleep(400);
    const viewportTrials = async (kind: "mouse" | "key", n: number): Promise<void> => {
      if (kind === "key") await host.exec(t, "window.__vp.latKeys(true)");
      const trials: Array<{ trial: number; t0: number }> = [];
      for (let i = 0; i < n; i++) {
        const trial = (kind === "mouse" ? 1000 : 2000) + i;
        const t0 = Date.now();
        vp.probe = { trial, t0, rect: { x: b.x, y: b.y, width: b.w, height: b.h } };
        if (kind === "mouse") {
          vin({ type: "mouseDown", x: b.cx, y: b.cy, button: "left", clickCount: 1 });
          vin({ type: "mouseUp", x: b.cx, y: b.cy, button: "left", clickCount: 1 });
        } else {
          vin({ type: "keyDown", keyCode: "k" });
          vin({ type: "char", keyCode: "k" });
          vin({ type: "keyUp", keyCode: "k" });
        }
        trials.push({ trial, t0 });
        await waitFor(() => (vp.probes.get(trial)?.tShown !== undefined ? true : undefined), 2000, 5);
        await sleep(200);
      }
      if (kind === "key") await host.exec(t, "window.__vp.latKeys(false)");
      vp.probe = undefined;
      const lat = (await state()).lat;
      const total: number[] = [], toPage: number[] = [], toPaint: number[] = [], toDrawn: number[] = [], toShown: number[] = [];
      for (const x of trials) {
        const p = vp.probes.get(x.trial);
        if (p?.tShown === undefined) continue;
        total.push(p.tShown - x.t0);
        const pageIn = lat.find((l) => l.tIn >= x.t0)?.tIn;
        if (pageIn !== undefined) toPage.push(pageIn - x.t0);
        if (p.tPaint !== undefined) toPaint.push(p.tPaint - x.t0);
        if (p.tDrawn !== undefined && p.tPaint !== undefined) toDrawn.push(p.tDrawn - p.tPaint);
        if (p.tDrawn !== undefined) toShown.push(p.tShown - p.tDrawn);
      }
      result.latency[`viewport, ${kind}`] = { trials: n, ms: summarize(total), parts: { "to the page's handler": summarize(toPage), "to the paint event": summarize(toPaint), "paint → drawn in the viewer": summarize(toDrawn), "drawn → on screen (2 rAFs)": summarize(toShown) } };
      log(`  viewport latency (${kind}): ${total.length}/${n} trials, p50 ${summarize(total).p50} ms, p95 ${summarize(total).p95} ms (to page ${summarize(toPage).p50}, to paint ${summarize(toPaint).p50}, paint→drawn ${summarize(toDrawn).p50}, drawn→shown ${summarize(toShown).p50})`);
    };
    await viewportTrials("mouse", 20);
    await viewportTrials("key", 10);

    const fpsWindow = async (label: string, extra: () => Promise<void>, stop: () => Promise<void>): Promise<void> => {
      await extra();
      await sleep(1000);
      const v0 = await vp.stats();
      const a0 = (await state()).anim.frames;
      const p0 = t.paints, sent0 = vp.sent, drop0 = vp.dropped, bytes0 = vp.bytes;
      const m0 = sample();
      await sleep(4000);
      const m1 = sample();
      const v1 = await vp.stats();
      const a1 = (await state()).anim.frames;
      await stop();
      const cpu = cpuBetween(m0, m1);
      const s = cpu.seconds;
      const draw = summarize((v1?.drawMs ?? []).slice(-120));
      result.fps[label] = {
        drawnPerSec: ((v1?.frames ?? 0) - (v0?.frames ?? 0)) / s, paintsPerSec: (t.paints - p0) / s, sentPerSec: (vp.sent - sent0) / s, droppedPerSec: (vp.dropped - drop0) / s,
        pageRafPerSec: (a1 - a0) / s, mbPerSec: (vp.bytes - bytes0) / s / 1048576, drawMsP50: draw.p50, drawMsP95: draw.p95,
        cpuTotal: cpu.total, cpuBrowser: cpu.byType.Browser ?? 0, cpuGpu: cpu.byType.GPU ?? 0, cpuOffscreenRenderer: cpu.byPid[String(t.wc.getOSProcessId())] ?? Number.NaN, cpuViewerRenderer: cpu.byPid[String(vp.wc.getOSProcessId())] ?? Number.NaN,
      };
      log(`  viewport fps, ${label}: ${JSON.stringify(result.fps[label])}`);
    };
    await fpsWindow("viewport, animated page", () => host.exec(t, "window.__vp.anim(true)"), () => host.exec(t, "window.__vp.anim(false)"));
    {
      const v0 = await vp.stats();
      await host.exec(t, "window.__vp.smoothScroll(3000)");
      const st = await waitFor(async () => { const s = await state(); return s.smooth.endedAt !== 0 ? s : undefined; }, 7000, 50);
      const v1 = await vp.stats();
      const ms = st !== undefined && st.smooth.endedAt > 0 ? st.smooth.endedAt - st.smooth.startedAt : Number.NaN;
      result.fps["viewport, smooth scroll"] = { ms, viewerFramesPerSec: (((v1?.frames ?? 0) - (v0?.frames ?? 0)) * 1000) / ms, pageRafPerSec: st !== undefined ? (st.smooth.rafs * 1000) / ms : Number.NaN };
      log(`  viewport fps, smooth scroll: ${JSON.stringify(result.fps["viewport, smooth scroll"])}`);
      await host.exec(t, "window.__vp.scrollTop()");
    }

    // --- hide, and a second show ------------------------------------------------------------------------------------
    const sBefore = await state();
    const hideMs = await hide();
    await sleep(1500);
    const s2 = await state();
    oracle("hidden again (the agent's 1280x800)", sBefore, s2, sBefore.field);
    result.shows[0]!.hideMs = hideMs;
    await show(2);
    await sleep(800);
    const s3 = await state();
    oracle("shown again", s2, s3, sBefore.field);
    result.shows[1]!.hideMs = await hide();
    const s4 = await state();
    oracle("hidden at the end", s3, s4, sBefore.field);
    const viewer = await vp.stats();
    if (viewer !== undefined) result.viewer = { ...viewer, drawMs: [], drawMsSummary: summarize(viewer.drawMs) };
    result.counters = { sent: vp.sent, dropped: vp.dropped, fullFrames: vp.fullFrames, mbSent: vp.bytes / 1048576, outstandingTextures: vp.outstanding, forwarded: vp.forwarded, errors: vp.errors, tabTextures: t.textures, tabPopupTextures: t.popupTextures, tabEmptyPaints: t.emptyPaints, tabPaints: t.paints };

    // --- the same page in a native view: latency and frames per second -------------------------------------------------
    {
      const win = new BaseWindow({ show: true, x: 80, y: 80, width: VP_W, height: VP_H, useContentSize: true, title: "S7 native view" });
      const view = new WebContentsView({ webPreferences: { partition: "persist:bot-native", sandbox: true, contextIsolation: true, nodeIntegration: false } });
      win.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: VP_W, height: VP_H });
      native = { win, view };
      const nwc = view.webContents;
      await withTimeout(nwc.loadURL(`${server.origin}/pages/vp-page.html?tab=native&sse=0`), 20_000, "load the native view");
      win.focus();
      nwc.focus();
      await sleep(1000);
      const nstate = async (): Promise<PageState> => (await withTimeout(nwc.executeJavaScript("window.__vp.state()", true), 5000, "native state")) as PageState;
      const nb = (await withTimeout(nwc.executeJavaScript(`window.__vp.rect("box")`, true), 5000, "native rect")) as R;
      const nativeTrials = async (kind: "mouse" | "key", n: number): Promise<void> => {
        if (kind === "key") await nwc.executeJavaScript("window.__vp.latKeys(true)", true);
        const t0s: number[] = [];
        for (let i = 0; i < n; i++) {
          const t0 = Date.now();
          t0s.push(t0);
          if (kind === "mouse") {
            nwc.sendInputEvent({ type: "mouseDown", x: nb.cx, y: nb.cy, button: "left", clickCount: 1 });
            nwc.sendInputEvent({ type: "mouseUp", x: nb.cx, y: nb.cy, button: "left", clickCount: 1 });
          } else {
            nwc.sendInputEvent({ type: "keyDown", keyCode: "k" });
            nwc.sendInputEvent({ type: "char", keyCode: "k" });
            nwc.sendInputEvent({ type: "keyUp", keyCode: "k" });
          }
          await sleep(250);
        }
        if (kind === "key") await nwc.executeJavaScript("window.__vp.latKeys(false)", true);
        await sleep(200);
        const lat = (await nstate()).lat;
        const total: number[] = [], toPage: number[] = [];
        for (const t0 of t0s) {
          const l = lat.find((x) => x.tIn >= t0);
          if (l === undefined) continue;
          toPage.push(l.tIn - t0);
          if (l.tFrame !== undefined) total.push(l.tFrame - t0);
        }
        result.latency[`native view, ${kind}`] = { trials: n, ms: summarize(total), parts: { "to the page's handler": summarize(toPage) } };
        log(`  native latency (${kind}): ${total.length}/${n}, p50 ${summarize(total).p50} ms, p95 ${summarize(total).p95} ms (to page ${summarize(toPage).p50})`);
      };
      await nativeTrials("mouse", 20);
      await nativeTrials("key", 10);
      await nwc.executeJavaScript("window.__vp.anim(true)", true);
      await sleep(1000);
      const a0 = (await nstate()).anim.frames;
      const m0 = sample();
      await sleep(4000);
      const m1 = sample();
      const a1 = (await nstate()).anim.frames;
      await nwc.executeJavaScript("window.__vp.anim(false)", true);
      const cpu = cpuBetween(m0, m1);
      result.fps["native view, animated page"] = { pageRafPerSec: (a1 - a0) / cpu.seconds, cpuTotal: cpu.total, cpuBrowser: cpu.byType.Browser ?? 0, cpuGpu: cpu.byType.GPU ?? 0, cpuRenderer: cpu.byPid[String(nwc.getOSProcessId())] ?? Number.NaN };
      log(`  native fps, animated page: ${JSON.stringify(result.fps["native view, animated page"])}`);
      await nwc.executeJavaScript("window.__vp.smoothScroll(3000)", true);
      const st = await waitFor(async () => { const s = await nstate(); return s.smooth.endedAt !== 0 ? s : undefined; }, 7000, 50);
      const ms = st !== undefined && st.smooth.endedAt > 0 ? st.smooth.endedAt - st.smooth.startedAt : Number.NaN;
      result.fps["native view, smooth scroll"] = { ms, pageRafPerSec: st !== undefined ? (st.smooth.rafs * 1000) / ms : Number.NaN };
    }
  } catch (e) {
    result.error = errorText(e);
    log(`  viewport: ERROR ${result.error}`);
  } finally {
    try { vp.close(); } catch { /* gone */ }
    if (native !== undefined && !native.win.isDestroyed()) native.win.destroy();
    if (tab !== undefined) await host.close(tab);
    rmSync(uploadDir, { recursive: true, force: true });
  }
  return result;
}

// --- 3. JavaScript dialogs ------------------------------------------------------------------------------------------

export interface DialogRow {
  place: string;
  kind: string;
  cdpEvent: boolean;
  hasBrowserHandler?: boolean;
  windowsBefore?: string[];
  windowsDuring?: WindowListing;
  windowsAfter?: WindowListing;
  page: string;
  error?: string;
}

/**
 * JavaScript dialogs answered over CDP (Page.javascriptDialogOpening → Page.handleJavaScriptDialog), as the report's
 * edit has it, in an offscreen tab and in the host window. Electron has no dialog hook of its own: does its native
 * message box still show (and stay) when CDP answers? Run apart (its own process): a box nobody closes may stay up.
 */
export async function dialogCheck(host: TabHost, root: string, server: SpikeServer, log: Log): Promise<DialogRow[]> {
  const rows: DialogRow[] = [];
  const vp = new Viewport(host, server.origin, root);
  const places: Array<{ name: string; place: "osr" | "tinyWindow" }> = [
    { name: "offscreen tab", place: "osr" },
    { name: "host window tab", place: "tinyWindow" },
  ];
  for (const p of places) {
    let t: Tab | undefined;
    try {
      t = await host.create({ place: p.place, partition: `bot-dialog-${p.place}`, throttling: false, path: "/pages/vp-page.html?sse=0", fps: 10 });
      await vp.cdp(t, "Runtime.enable");
      for (const kind of ["alert", "confirm", "prompt"]) {
        const row: DialogRow = { place: p.name, kind, cdpEvent: false, page: "" };
        try {
          const before = await visibleWindows();
          row.windowsBefore = before.windows;
          const n0 = vp.dialogs.length;
          await host.exec(t, `window.__vp.runDialog(${JSON.stringify(kind)})`);
          const ev = await waitFor(() => (vp.dialogs.length > n0 ? vp.dialogs[vp.dialogs.length - 1] : undefined), 4000);
          row.cdpEvent = ev !== undefined;
          row.hasBrowserHandler = ev?.hasBrowserHandler;
          row.windowsDuring = await visibleWindows();
          if (ev !== undefined) {
            await vp.cdp(t, "Page.handleJavaScriptDialog", { accept: true, ...(kind === "prompt" ? { promptText: "typed in the app" } : {}) }).catch((e: unknown) => { row.error = `handle: ${errorText(e)}`; });
          }
          await sleep(1000);
          row.windowsAfter = await visibleWindows();
          row.page = await host.exec<string[]>(t, "window.__vp.state().dialogs", 4000).then((d) => d.join(" | ")).catch((e: unknown) => `page not answering: ${errorText(e)}`);
        } catch (e) {
          row.error = errorText(e);
        }
        rows.push(row);
        log(`  dialog ${p.name} ${kind}: CDP event ${row.cdpEvent} (browser handler ${row.hasBrowserHandler}), windows before ${JSON.stringify(row.windowsBefore)} during ${JSON.stringify(row.windowsDuring?.windows ?? row.windowsDuring?.error)} after ${JSON.stringify(row.windowsAfter?.windows ?? row.windowsAfter?.error)}; page "${row.page}"${row.error ? `; ${row.error}` : ""}`);
      }
    } catch (e) {
      rows.push({ place: p.name, kind: "setup", cdpEvent: false, page: "", error: errorText(e) });
    } finally {
      if (t !== undefined) await host.close(t);
    }
  }
  return rows;
}
