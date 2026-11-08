// The streamed view for other devices (spec §12.1 "[P] From another device"; S7 §6): a tab, encoded as video in the
// app, its chunks handed to the daemon (`streamData`), which frames them onto the link (`packages/core/src/browser/
// stream.ts`). The core asks with `app.tab.command` `stream` (on/off) and `stream-control` (a keyframe, a bitrate).
//
// Where the frames come from: the tab's own paints, not a tab capture. An offscreen tab (design B) already hands the
// main process every frame it paints as a CPU bitmap (`paint`), the same frames the viewport draws; a screen-reader
// host tab gives them through `beginFrameSubscription`. S7's tab capture (`getMediaSourceId` + `chromeMediaSource:
// "tab"`) was measured only on windowed tabs, failed under Wayland, and needs a media permission in the encoder's
// session; the paints work for both kinds of tab on every OS the browser runs on, and need no permission at all
// (S7's closing note: "in design B the streamed view can start from the viewport's frames").
//
// The encoder is WebCodecs in a page of the browser's own (`stream-page/`): a `WebContentsView` in no window, so it is
// never shown; sandboxed, context-isolated, no Node, in the viewport pages' in-memory partition, where no request
// but the page's own file is allowed (so `isBrowserContents` counts it and lane E's guards leave it alone). One page
// serves every stream; it goes when the last stream stops. While a tab streams it paints at least 30 fps (a resting
// or headless offscreen tab paints at 10 fps or not at all), and goes back to its own rate after.
import { ipcMain, WebContentsView, type IpcMainEvent, type NativeImage, type Rectangle } from "electron";
import { STREAM_FRAME_B64_MAX_LENGTH } from "@waifucave/clover-protocol";
import type { StreamChunk, StreamCodec } from "./contract";
import { BROWSER_WEBRTC_POLICY, prepareViewportSession, VIEWPORT_PARTITION } from "./session";
import { HostTab, OffscreenTab, type BrowserTab } from "./tab";

export const STREAM_CHANNEL = "clover-browser-stream";
/** The rate a streamed tab paints at, and its frames are encoded at (S7: 30 fps for motion). */
export const STREAM_FPS = 30;
/** The bitrate a stream starts at when the daemon names none (S7: about 2.3 Mbit/s for 30 fps of motion). */
export const DEFAULT_STREAM_KBPS = 2500;
/** Pictures sent to the encoder page and not yet taken, past which the next ones wait. */
const MAX_IN_FLIGHT = 2;
/** JPEG frames (a receiver that decodes no video) at most this often. */
const JPEG_MAX_FPS = 15;

export interface StreamPageAssets {
  /** The encoder page's sandboxed preload, bundled to one CommonJS file. */
  preload: string;
  /** The encoder page. */
  html: string;
}

/** One stream, as the host reports it (diagnostics, the CI test). */
export interface StreamStats {
  stream: string;
  tab: string;
  codec?: StreamCodec;
  codecString?: string;
  /** A hardware encoder (H.264 only); false for VP8, software H.264 and JPEG. */
  hardware?: boolean;
  /** The target the encoder runs at now (`kbps` is the one asked for; they differ for a moment after a change). */
  encoderKbps?: number;
  width?: number;
  height?: number;
  kbps: number;
  frames: number;
  keyframes: number;
  bytes: number;
}

interface Source {
  tab: BrowserTab;
  streams: Set<string>;
  seq: number;
  inFlight: Set<number>;
  /** The whole picture goes next (a new stream, a new size, a picture the page never got). */
  needFull: boolean;
  /** What changed since the last picture sent, while pictures wait (the rate, or the page being behind). */
  dirty?: Rectangle;
  latest?: NativeImage;
  lastSentAt: number;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
}

interface Stream {
  id: string;
  source: Source;
  mode: "video" | "jpeg";
  codecs?: StreamCodec[];
  kbps: number;
  stats: StreamStats;
  /** JPEG: the config went out at this size. */
  jpegSize?: { w: number; h: number };
  lastJpegAt: number;
}

type PageOut =
  | { type: "ready" }
  | { type: "ack"; source: string; seq: number }
  | { type: "config"; stream: string; codec: StreamCodec; codecString: string; width: number; height: number; hardware: boolean }
  | { type: "chunk"; stream: string; key: boolean; timestamp: number }
  | { type: "rate"; stream: string; kbps: number }
  | { type: "ended"; stream: string; message: string }
  | { type: "unsupported"; stream: string; message: string };

export class TabStreamer {
  private readonly streams = new Map<string, Stream>();
  private readonly sources = new Map<string, Source>();
  private page: WebContentsView | undefined;
  private pageReady: Promise<void> | undefined;
  private readonly onOut = (e: IpcMainEvent, msg: PageOut, bytes?: Uint8Array): void => {
    if (this.page !== undefined && e.sender === this.page.webContents) this.fromPage(msg, bytes);
  };

  constructor(private readonly opts: { assets: StreamPageAssets; send(stream: string, chunk: StreamChunk): void }) {}

  /** `stream` on. Resolves once the encoder page is up; the config and the first keyframe follow as chunks. */
  async start(tab: BrowserTab, cmd: { stream: string; maxKbps?: number; codecs?: StreamCodec[] }): Promise<void> {
    if (this.streams.has(cmd.stream)) throw new Error(`there's already a stream ${cmd.stream}`);
    const codecs = cmd.codecs !== undefined && cmd.codecs.length > 0 ? [...new Set(cmd.codecs)] : undefined;
    const kbps = Math.max(50, Math.round(cmd.maxKbps ?? DEFAULT_STREAM_KBPS));
    const jpegOnly = codecs !== undefined && codecs.every((c) => c === "jpeg");
    if (!jpegOnly) await this.ensurePage();
    if (tab.closed) throw new Error(`there's no tab ${tab.id}`);
    if (this.streams.has(cmd.stream)) throw new Error(`there's already a stream ${cmd.stream}`);
    const source = this.sourceFor(tab);
    const stream: Stream = {
      id: cmd.stream, source, mode: jpegOnly ? "jpeg" : "video", ...(codecs !== undefined ? { codecs } : {}), kbps,
      stats: { stream: cmd.stream, tab: tab.id, kbps, frames: 0, keyframes: 0, bytes: 0 }, lastJpegAt: 0,
    };
    this.streams.set(stream.id, stream);
    source.streams.add(stream.id);
    if (stream.mode === "video") this.toPage("start", { stream: stream.id, source: tab.id, ...(codecs !== undefined ? { codecs } : {}), kbps });
    source.needFull = true;
    this.kick(source);
  }

  /** `stream-control`: a keyframe next, and/or a new target bitrate. */
  control(cmd: { stream: string; keyframe?: boolean; kbps?: number }): void {
    const stream = this.streams.get(cmd.stream);
    if (stream === undefined) throw new Error(`there's no stream ${cmd.stream}`);
    const kbps = cmd.kbps !== undefined ? Math.max(50, Math.round(cmd.kbps)) : undefined;
    if (kbps !== undefined) {
      stream.kbps = kbps;
      stream.stats.kbps = kbps;
    }
    if (stream.mode === "jpeg") {
      if (cmd.keyframe === true) {
        stream.lastJpegAt = 0;
        const latest = stream.source.latest;
        if (latest !== undefined) this.jpeg(stream, latest);
      }
      return;
    }
    this.toPage("control", { stream: stream.id, ...(cmd.keyframe === true ? { keyframe: true } : {}), ...(kbps !== undefined ? { kbps } : {}) });
  }

  /** `stream` off, the tab closing, or the encoder failing: `ended` to the daemon, and everything let go. */
  stop(id: string, reason: "stopped" | "closed" | "failed", message?: string): void {
    const stream = this.streams.get(id);
    if (stream === undefined) return;
    this.streams.delete(id);
    if (stream.mode === "video") this.toPage("stop", id);
    const source = stream.source;
    source.streams.delete(id);
    if (source.streams.size === 0) this.release(source);
    this.emit(id, message !== undefined ? { kind: "ended", reason, message } : { kind: "ended", reason });
    if (this.streams.size === 0 || ![...this.streams.values()].some((s) => s.mode === "video")) this.closePage();
  }

  tabClosed(tabId: string): void {
    for (const s of [...this.streams.values()]) if (s.source.tab.id === tabId) this.stop(s.id, "closed");
  }

  /** Every stream stops (the host is shutting down). */
  shutdown(): void {
    for (const id of [...this.streams.keys()]) this.stop(id, "stopped");
    this.closePage();
  }

  /** A frame an offscreen tab painted (the host's `paint`, for every offscreen tab). */
  paint(tab: BrowserTab, dirty: Rectangle, image: NativeImage): void {
    const source = this.sources.get(tab.id);
    if (source !== undefined && source.tab === tab) this.frame(source, dirty, image);
  }

  stats(): StreamStats[] {
    return [...this.streams.values()].map((s) => ({ ...s.stats }));
  }

  get streaming(): boolean {
    return this.streams.size > 0;
  }

  // -----------------------------------------------------------------------------------------------

  private sourceFor(tab: BrowserTab): Source {
    const had = this.sources.get(tab.id);
    if (had !== undefined) return had;
    const source: Source = { tab, streams: new Set(), seq: 0, inFlight: new Set(), needFull: true, lastSentAt: 0 };
    this.sources.set(tab.id, source);
    if (tab instanceof OffscreenTab) {
      // Painting at the stream's rate, even resting; the paints come through the host (`paint`).
      tab.setStreamRate(STREAM_FPS);
    } else if (tab instanceof HostTab) {
      const c = tab.contents;
      c.beginFrameSubscription(false, (image, dirty) => this.frame(source, dirty, image));
      source.unsubscribe = () => { if (!c.isDestroyed()) c.endFrameSubscription(); };
      // A still page sends no new frames: its picture as it is now is the first.
      void c.capturePage(undefined, { stayHidden: true }).then((image) => {
        if (this.sources.get(tab.id) === source && source.latest === undefined && !image.isEmpty()) {
          const { width, height } = image.getSize();
          this.frame(source, { x: 0, y: 0, width, height }, image);
        }
      }, () => undefined);
    }
    return source;
  }

  private release(source: Source): void {
    if (this.sources.get(source.tab.id) === source) this.sources.delete(source.tab.id);
    if (source.timer !== undefined) clearTimeout(source.timer);
    source.unsubscribe?.();
    if (source.tab instanceof OffscreenTab && !source.tab.closed) source.tab.setStreamRate(0);
  }

  /** A new stream wants a picture now: an offscreen tab repaints, else the newest one goes again whole. */
  private kick(source: Source): void {
    if (source.tab.closed) return;
    if (source.latest !== undefined) {
      const { width, height } = source.latest.getSize();
      this.frame(source, { x: 0, y: 0, width, height }, source.latest);
    }
    source.tab.contents.invalidate();
  }

  private frame(source: Source, dirty: Rectangle, image: NativeImage): void {
    if (image.isEmpty() || source.streams.size === 0) return;
    source.latest = image;
    source.dirty = source.dirty === undefined ? dirty : union(source.dirty, dirty);
    const now = Date.now();
    const gap = 1000 / STREAM_FPS - 3;
    const due = now - source.lastSentAt >= gap;
    if (!due || source.inFlight.size >= MAX_IN_FLIGHT) {
      // Later: the newest picture, with everything that changed meanwhile, so the last one of a motion isn't lost.
      if (source.timer === undefined) {
        source.timer = setTimeout(() => {
          source.timer = undefined;
          const latest = source.latest;
          if (latest !== undefined && source.dirty !== undefined && this.sources.get(source.tab.id) === source) this.frame(source, { x: 0, y: 0, width: 0, height: 0 }, latest);
        }, Math.max(5, gap - (now - source.lastSentAt)));
      }
      return;
    }
    const changed = source.dirty;
    source.dirty = undefined;
    source.lastSentAt = now;
    let videoWants = false;
    for (const id of source.streams) {
      const s = this.streams.get(id);
      if (s?.mode === "jpeg") this.jpeg(s, image);
      else if (s !== undefined) videoWants = true;
    }
    if (videoWants) this.toEncoder(source, changed, image, now);
  }

  private toEncoder(source: Source, dirty: Rectangle, image: NativeImage, at: number): void {
    const page = this.page;
    if (page === undefined || page.webContents.isDestroyed()) return;
    const { width: fullW, height: fullH } = image.getSize();
    let x = Math.max(0, Math.min(dirty.x, fullW));
    let y = Math.max(0, Math.min(dirty.y, fullH));
    let w = Math.max(0, Math.min(dirty.width, fullW - x));
    let h = Math.max(0, Math.min(dirty.height, fullH - y));
    let px: Buffer;
    if (source.needFull || (x === 0 && y === 0 && w === fullW && h === fullH)) {
      source.needFull = false;
      x = 0; y = 0; w = fullW; h = fullH;
      px = image.toBitmap();
    } else if (w === 0 || h === 0) {
      return;
    } else {
      px = image.crop({ x, y, width: w, height: h }).toBitmap();
      if (px.length !== w * h * 4) { x = 0; y = 0; w = fullW; h = fullH; px = image.toBitmap(); }
    }
    const seq = ++source.seq;
    source.inFlight.add(seq);
    page.webContents.send(`${STREAM_CHANNEL}:frame`, { source: source.tab.id, seq, at, fullW, fullH, x, y, w, h }, px);
  }

  /** A JPEG stream (a receiver that decodes no video): the whole picture, each one a keyframe, as often as the
   *  bitrate allows and at most 15 a second. */
  private jpeg(stream: Stream, image: NativeImage): void {
    const now = Date.now();
    const { width, height } = image.getSize();
    if (stream.jpegSize === undefined || stream.jpegSize.w !== width || stream.jpegSize.h !== height) {
      stream.jpegSize = { w: width, h: height };
      stream.lastJpegAt = 0;
      Object.assign(stream.stats, { codec: "jpeg", codecString: "jpeg", hardware: false, width, height });
      this.emit(stream.id, { kind: "config", codec: "jpeg", width, height, codecString: "jpeg" });
    }
    const last = stream.stats.frames > 0 ? stream.stats.bytes / stream.stats.frames : 60_000;
    const fps = Math.max(1, Math.min(JPEG_MAX_FPS, (stream.kbps * 1000) / 8 / last));
    if (stream.lastJpegAt !== 0 && now - stream.lastJpegAt < 1000 / fps) return;
    stream.lastJpegAt = now;
    const quality = stream.kbps >= 2000 ? 70 : stream.kbps >= 800 ? 55 : 40;
    const data = image.toJPEG(quality);
    this.emit(stream.id, { kind: "frame", key: true, timestamp: now * 1000, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
  }

  private fromPage(msg: PageOut, bytes?: Uint8Array): void {
    switch (msg.type) {
      case "ready":
        return;
      case "ack": {
        const source = this.sources.get(msg.source);
        source?.inFlight.delete(msg.seq);
        return;
      }
      case "config": {
        const s = this.streams.get(msg.stream);
        if (s === undefined) return;
        Object.assign(s.stats, { codec: msg.codec, codecString: msg.codecString, hardware: msg.hardware, width: msg.width, height: msg.height });
        this.emit(s.id, { kind: "config", codec: msg.codec, width: msg.width, height: msg.height, codecString: msg.codecString });
        return;
      }
      case "rate": {
        const s = this.streams.get(msg.stream);
        if (s !== undefined) s.stats.encoderKbps = msg.kbps;
        return;
      }
      case "chunk": {
        if (!this.streams.has(msg.stream) || bytes === undefined) return;
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
        this.emit(msg.stream, { kind: "frame", key: msg.key, timestamp: msg.timestamp, data });
        return;
      }
      case "unsupported": {
        const s = this.streams.get(msg.stream);
        if (s === undefined) return;
        // No video encoder suits the receiver: JPEG pictures if it takes them, else the stream fails.
        if (s.codecs?.includes("jpeg")) {
          s.mode = "jpeg";
          if (s.source.latest !== undefined) this.jpeg(s, s.source.latest);
          else s.source.tab.contents.invalidate();
          return;
        }
        this.stop(s.id, "failed", msg.message);
        return;
      }
      case "ended":
        this.stop(msg.stream, "failed", msg.message);
        return;
    }
  }

  private emit(stream: string, chunk: StreamChunk): void {
    const s = this.streams.get(stream);
    if (s !== undefined && chunk.kind === "frame") {
      // Over the wire cap the frame never goes: it is dropped here, before the stats or the send,
      // and the core asks for a keyframe when its backpressure needs one (S3: the next keyframe resyncs).
      if (Math.ceil(chunk.data.byteLength / 3) * 4 > STREAM_FRAME_B64_MAX_LENGTH) return;
      s.stats.frames++;
      if (chunk.key) s.stats.keyframes++;
      s.stats.bytes += chunk.data.byteLength;
    }
    try {
      this.opts.send(stream, chunk);
    } catch {
      // The daemon is away: the stream goes on; the core stops it when its viewer goes.
    }
  }

  // The encoder page

  private ensurePage(): Promise<void> {
    if (this.pageReady !== undefined && this.page !== undefined && !this.page.webContents.isDestroyed()) return this.pageReady;
    // The viewport pages' partition: in memory, no permission, no request but the browser's own page files, and
    // counted by `isBrowserContents` from the moment the page is made.
    prepareViewportSession(this.opts.assets.html);
    const page = new WebContentsView({
      webPreferences: {
        partition: VIEWPORT_PARTITION, preload: this.opts.assets.preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, webviewTag: false, backgroundThrottling: false, spellcheck: false,
      },
    });
    const wc = page.webContents;
    wc.on("will-navigate", (e) => e.preventDefault());
    wc.on("will-frame-navigate", (e) => { if (!e.isMainFrame) e.preventDefault(); });
    wc.on("will-attach-webview", (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.setWebRTCIPHandlingPolicy(BROWSER_WEBRTC_POLICY);
    wc.on("render-process-gone", () => {
      if (this.page !== page) return;
      this.page = undefined;
      this.pageReady = undefined;
      for (const s of [...this.streams.values()]) if (s.mode === "video") this.stop(s.id, "failed", "the encoder page stopped");
    });
    this.page = page;
    ipcMain.on(`${STREAM_CHANNEL}:out`, this.onOut);
    this.pageReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("the stream encoder didn't start")); }, 15_000);
      const ready = (e: IpcMainEvent, msg: PageOut): void => {
        if (e.sender === wc && msg.type === "ready") { off(); resolve(); }
      };
      const off = (): void => { clearTimeout(timer); ipcMain.removeListener(`${STREAM_CHANNEL}:out`, ready); };
      ipcMain.on(`${STREAM_CHANNEL}:out`, ready);
      wc.loadFile(this.opts.assets.html).catch((e: unknown) => { off(); reject(e instanceof Error ? e : new Error(String(e))); });
    });
    this.pageReady.catch(() => this.closePage());
    return this.pageReady;
  }

  private toPage(what: string, arg: unknown): void {
    const page = this.page;
    if (page !== undefined && !page.webContents.isDestroyed()) page.webContents.send(`${STREAM_CHANNEL}:${what}`, arg);
  }

  private closePage(): void {
    const page = this.page;
    if (page === undefined) return;
    this.page = undefined;
    this.pageReady = undefined;
    ipcMain.removeListener(`${STREAM_CHANNEL}:out`, this.onOut);
    for (const source of this.sources.values()) {
      source.inFlight.clear();
      source.needFull = true;
    }
    if (!page.webContents.isDestroyed()) page.webContents.close();
  }
}

function union(a: Rectangle, b: Rectangle): Rectangle {
  if (a.width === 0 || a.height === 0) return b;
  if (b.width === 0 || b.height === 0) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
