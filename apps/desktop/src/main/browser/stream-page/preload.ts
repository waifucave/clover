// The streamed view's encoder page (spec §12.1 "[P] From another device"; S7 §6's WebCodecs road): it takes a tab's
// painted frames (CPU bitmaps of the changed area, as the viewport gets them), keeps each tab's whole picture, and
// encodes it with WebCodecs' `VideoEncoder` for every stream of that tab: H.264 (Annex B) where a hardware encoder
// exists, else VP8; software H.264 only when the receiver names H.264 and not VP8. It runs as the sandboxed preload
// of a page that is never shown, in the viewport pages' in-memory partition (no network). The main process side is
// `../stream.ts`. Bundled to one CommonJS file (`BROWSER_ASSETS.streamPreload` in `../assets.ts`).
//
// Main → here:  start ({stream, source, codecs?, kbps}), frame (meta, BGRA pixels), control ({stream, keyframe?,
//               kbps?}), stop (stream)
// Here → main, all on one channel in order (`out`): ready, config, chunk (+ bytes), ended, unsupported, ack

export {};

interface Ipc {
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
}
const ipc = (require("electron") as { ipcRenderer: Ipc }).ipcRenderer;
const CH = "clover-browser-stream";

type Codec = "h264" | "vp8" | "jpeg";
interface FrameMeta { source: string; seq: number; at: number; fullW: number; fullH: number; x: number; y: number; w: number; h: number }
interface Source { w: number; h: number; buf: Uint8Array; at: number }
interface Stream {
  id: string;
  source: string;
  codecs?: Codec[];
  kbps: number;
  encoder?: VideoEncoder;
  config?: VideoEncoderConfig;
  codec?: Codec;
  width: number;
  height: number;
  configuring: boolean;
  /** What the last config said, so a new encoder at the same codec and size sends none. */
  told?: string;
  forceKey: boolean;
  n: number;
  lastTs: number;
  t0: number;
}

/** 30 fps for motion (S7), a keyframe every 2 s of it, and one at the start and on request. */
const FPS = 30;
const KEY_EVERY = 60;

const sources = new Map<string, Source>();
const streams = new Map<string, Stream>();

function out(msg: Record<string, unknown>, bytes?: Uint8Array): void {
  if (bytes !== undefined) ipc.send(`${CH}:out`, msg, bytes);
  else ipc.send(`${CH}:out`, msg);
}

/** Constrained Baseline H.264 (what VideoToolbox, Safari and every hardware decoder take) at the lowest level whose
 *  frame size fits the picture. */
function avcCodec(w: number, h: number): string {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const level = mbs <= 3600 ? "1F" : mbs <= 5120 ? "20" : mbs <= 8192 ? "28" : mbs <= 8704 ? "2A" : mbs <= 22080 ? "32" : "33";
  return `avc1.42E0${level}`;
}

/** The encoder for a stream, in order: hardware H.264, VP8, then software H.264 only if the receiver named H.264
 *  (spec §12.1: shipping a software H.264 encoder raises a patent-licensing question). */
async function choose(st: Stream, w: number, h: number): Promise<{ codec: Codec; config: VideoEncoderConfig; hardware: boolean } | undefined> {
  const wants = st.codecs ?? ["h264", "vp8"];
  const base = { width: w, height: h, bitrate: st.kbps * 1000, framerate: FPS, latencyMode: "realtime" as const };
  const tries: { codec: Codec; config: VideoEncoderConfig; hardware: boolean }[] = [];
  if (wants.includes("h264")) tries.push({ codec: "h264", hardware: true, config: { ...base, codec: avcCodec(w, h), hardwareAcceleration: "prefer-hardware", avc: { format: "annexb" } } });
  if (wants.includes("vp8")) tries.push({ codec: "vp8", hardware: false, config: { ...base, codec: "vp8", hardwareAcceleration: "no-preference" } });
  if (st.codecs?.includes("h264")) tries.push({ codec: "h264", hardware: false, config: { ...base, codec: avcCodec(w, h), hardwareAcceleration: "prefer-software", avc: { format: "annexb" } } });
  for (const t of tries) {
    try {
      const support = await VideoEncoder.isConfigSupported(t.config);
      if (support.supported === true) return t;
    } catch {
      // Next.
    }
  }
  return undefined;
}

async function configure(st: Stream, w: number, h: number): Promise<void> {
  st.configuring = true;
  try {
    const old = st.encoder;
    st.encoder = undefined;
    if (old !== undefined && old.state !== "closed") {
      try { await old.flush(); } catch { /* reconfiguring */ }
      old.close();
    }
    const pick = await choose(st, w, h);
    if (!streams.has(st.id)) return;
    if (pick === undefined) {
      streams.delete(st.id);
      out({ type: "unsupported", stream: st.id, message: `no encoder here for ${(st.codecs ?? ["h264", "vp8"]).join(" or ")} at ${w}x${h}` });
      return;
    }
    const encoder = new VideoEncoder({
      output: (chunk) => {
        if (streams.get(st.id) !== st) return;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        out({ type: "chunk", stream: st.id, key: chunk.type === "key", timestamp: chunk.timestamp }, data);
      },
      error: (e) => {
        if (streams.get(st.id) !== st) return;
        streams.delete(st.id);
        out({ type: "ended", stream: st.id, message: `the encoder failed: ${e.message}` });
      },
    });
    encoder.configure(pick.config);
    st.encoder = encoder;
    st.config = pick.config;
    st.codec = pick.codec;
    st.width = w;
    st.height = h;
    st.forceKey = true;
    const told = `${pick.config.codec} ${w}x${h}`;
    if (told !== st.told) {
      st.told = told;
      out({ type: "config", stream: st.id, codec: pick.codec, codecString: pick.config.codec, width: w, height: h, hardware: pick.hardware });
    }
    out({ type: "rate", stream: st.id, kbps: st.kbps });
  } catch (e) {
    streams.delete(st.id);
    out({ type: "ended", stream: st.id, message: `the encoder couldn't start: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    st.configuring = false;
  }
  // The target changed while the encoder was being made: again, at the new one.
  if (streams.get(st.id) === st && st.config !== undefined && st.config.bitrate !== st.kbps * 1000) await configure(st, w, h);
}

/** Encodes the source's picture as it is now into one stream. */
function encode(st: Stream, src: Source, at: number): void {
  if (st.configuring) return;
  // H.264's 4:2:0 wants even sizes: an odd last column or row is left out.
  const w = src.w & ~1, h = src.h & ~1;
  if (w === 0 || h === 0) return;
  if (st.encoder === undefined || st.width !== w || st.height !== h) {
    void configure(st, w, h).then(() => { if (streams.get(st.id) === st && st.encoder !== undefined) encode(st, src, Date.now()); });
    return;
  }
  const enc = st.encoder;
  if (enc.state !== "configured") return;
  // The encoder is behind: skip this picture (the next one carries what changed).
  if (enc.encodeQueueSize > 2) return;
  const ts = Math.max(st.lastTs + 1, Math.round((at - st.t0) * 1000));
  st.lastTs = ts;
  const frame = new VideoFrame(src.buf, { format: "BGRX", codedWidth: src.w, codedHeight: src.h, timestamp: ts, visibleRect: { x: 0, y: 0, width: w, height: h } });
  try {
    const key = st.forceKey || st.n % KEY_EVERY === 0;
    enc.encode(frame, { keyFrame: key });
    st.forceKey = false;
    st.n++;
  } finally {
    frame.close();
  }
}

ipc.on(`${CH}:start`, (_e, a: { stream: string; source: string; codecs?: Codec[]; kbps: number }) => {
  const st: Stream = { id: a.stream, source: a.source, ...(a.codecs !== undefined ? { codecs: a.codecs } : {}), kbps: a.kbps, width: 0, height: 0, configuring: false, forceKey: true, n: 0, lastTs: -1, t0: Date.now() };
  streams.set(st.id, st);
  const src = sources.get(a.source);
  if (src !== undefined) encode(st, src, Date.now());
});

ipc.on(`${CH}:frame`, (_e, meta: FrameMeta, px: Uint8Array) => {
  let src = sources.get(meta.source);
  if (src === undefined || src.w !== meta.fullW || src.h !== meta.fullH) {
    src = { w: meta.fullW, h: meta.fullH, buf: new Uint8Array(meta.fullW * meta.fullH * 4), at: meta.at };
    sources.set(meta.source, src);
  }
  // The changed rectangle, row by row, into the whole picture.
  const rowBytes = meta.w * 4;
  if (meta.w > 0 && meta.h > 0 && px.byteLength >= rowBytes * meta.h) {
    for (let r = 0; r < meta.h; r++) src.buf.set(px.subarray(r * rowBytes, (r + 1) * rowBytes), ((meta.y + r) * meta.fullW + meta.x) * 4);
  }
  src.at = meta.at;
  for (const st of streams.values()) if (st.source === meta.source) encode(st, src, meta.at);
  out({ type: "ack", source: meta.source, seq: meta.seq });
});

ipc.on(`${CH}:control`, (_e, c: { stream: string; keyframe?: boolean; kbps?: number }) => {
  const st = streams.get(c.stream);
  if (st === undefined) return;
  if (c.kbps !== undefined && c.kbps > 0 && c.kbps !== st.kbps) {
    st.kbps = c.kbps;
    // A new encoder at the new target, starting with a keyframe. Electron 45's VP8 kept its old target after an
    // in-place `configure()` with a new bitrate (CI: 2.4 Mbit/s asked for 0.3), though the headless shell's follows
    // it; a fresh encoder always starts at its target. The core lowers the target only when it also asks for a
    // keyframe, and raises it at most every few seconds, so the keyframe costs little.
    if (st.encoder !== undefined && !st.configuring) {
      const src = sources.get(st.source);
      void configure(st, st.width, st.height).then(() => { if (src !== undefined && streams.get(st.id) === st) encode(st, src, Date.now()); });
    }
  }
  if (c.keyframe === true) {
    st.forceKey = true;
    // A still page paints nothing: the picture as it is, encoded now as a keyframe.
    const src = sources.get(st.source);
    if (src !== undefined) encode(st, src, Date.now());
  }
});

ipc.on(`${CH}:stop`, (_e, stream: string) => {
  const st = streams.get(stream);
  if (st === undefined) return;
  streams.delete(stream);
  if (st.encoder !== undefined && st.encoder.state !== "closed") st.encoder.close();
  if (![...streams.values()].some((s) => s.source === st.source)) sources.delete(st.source);
});

out({ type: "ready" });
