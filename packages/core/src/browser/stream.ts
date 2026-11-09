// The streamed view for other devices (spec §12.1 "[P] From another device"; S7 §6): a tab, encoded as video by the
// app (WebCodecs H.264 where a hardware encoder exists, else VP8), goes to another device on a link stream of its
// own, at the link's low priority (`screenshots`). The core's part is here: it asks the app to stream a tab
// (`app.tab.command` `stream`), takes the app's chunks (`data`), frames them onto each viewer's link stream, and
// follows the link: when a viewer's writes back up it drops delta frames until the next keyframe, asks the app for
// one and lowers the bitrate; when the viewer has kept up for a while it raises it again, never past `maxKbps`.
//
// `BrowserService.stream()` (the L lead's) checks the caller and the tab first, then calls `start`/`stop` here.
//
// ## The link stream (for lane I: the phone and web companions decode this)
//
// The sender opens one stream per (tab, device): `link.openStream("browser.stream", "screenshots", meta)` with
// `meta = { v: 1, stream, tab, computer }`, where `stream` is what `browser.stream` answered. Every write is one
// frame, and every frame says its own length, so a reader that gets the bytes as one run can split them
// (`StreamFrameReader`). All integers are big-endian.
//
//   offset  size  field
//   0       1     version, 1
//   1       1     kind: 1 config, 2 frame, 3 ended
//   2       1     flags: bit 0 = keyframe (kind 2 only); the other bits are 0
//   3       1     reserved, 0
//   4       8     timestamp in microseconds, a signed 64-bit integer (kind 2; 0 otherwise)
//   12      4     payload length in bytes, unsigned, at most 16 MiB (`STREAM_MAX_PAYLOAD`): a receiver refuses a
//                 longer one as a broken stream, and the sender never sends one (it drops the frame and asks for a
//                 keyframe at a lower bitrate)
//   16      n     payload:
//                   config: UTF-8 JSON {"codec":"h264"|"vp8"|"jpeg","width":W,"height":H,"codecString":"avc1.42E028"}
//                   frame:  the encoded chunk, as the app's VideoEncoder made it: H.264 in Annex B (start codes, the
//                           SPS and PPS in band before each keyframe), a VP8 frame, or a whole JPEG picture
//                   ended:  UTF-8 JSON {"reason":"stopped"|"closed"|"failed","message"?:"…"}
//
// A stream starts with a config, then a keyframe. A new config (the tab was resized, or the encoder changed) is
// followed by a keyframe too. For `h264` and `vp8`, configure a decoder from the config (`VideoDecoder.configure({
// codec: codecString, codedWidth, codedHeight, optimizeForLatency: true })`, or VideoToolbox from the in-band
// SPS/PPS), and decode each frame in order. A `jpeg` stream has no decoder to configure (its codecString is "jpeg",
// which isn't a WebCodecs codec): every frame is a whole JPEG picture and a keyframe, and the picture's own size is
// the one to draw at; the config's width and height are the tab's viewport, which the picture may be scaled down
// from (the headless shell's screencast). A frame is never sent with a gap before it except up to a keyframe, so a receiver never needs to
// ask for one. An `ended` frame is the last, and the sender ends the stream after it.
//
// ## Acknowledgements (receiver to sender, on the same link stream)
//
// The meta carries `acks: true`. The receiver answers each `frame` it has decoded, or has dropped without decoding
// (a decoder that fell behind, a hidden page), with an ack: the same 16-byte header, kind 4, flags 0, the TIMESTAMP of
// that frame in the timestamp field, payload length 0 (a sender reads past at most 1 KiB of payload, `STREAM_MAX_ACK_PAYLOAD`). A receiver acks in order and never acks a config or an ended
// frame. The sender keeps at most `maxUnacked` (2) frames unacknowledged: while two are out, a frame it would send is
// dropped, and so are the deltas after it until a keyframe (as when the link backs up). The window is enforced only
// once the first ack has arrived, so a receiver that doesn't ack (an older one) gets the stream as before, and one
// whose acks stop for `ackTimeoutMs` (5 s) is let go on: the window clears and a keyframe is asked for. This is what
// keeps the picture near real time whatever the link's buffers (QUIC's windows, the sidecar's) hold. (Measured, real
// TCP through a 1 Mbit relay: median latency 10.4 s without acks, 0.25 s with them, at the same ~86% of the link; on the
// simulated 100 ms-RTT wire with a 1 MiB buffer the p95 went 33 s to 11.5 s. Two frames per round trip caps the frame
// rate at about 2/RTT. A full window lowers the bitrate only once its oldest frame, sent after the last lowering, has
// waited `ackSlowMs`: a window full for one round trip is not a narrow link.) Parse acks with
// `StreamAckReader` (the sender) and write them with `encodeStreamAck` (the receiver).
import { randomBytes } from "node:crypto";
import type { LinkStream, LinkTransport } from "../contracts/link-transport";
import { MAX_VIEWPORT_PIXELS, type StreamChunk, type StreamCodec } from "./contract";
import { BrowserError } from "./policy";
import type { AppTabPort } from "./service";

export const STREAM_FRAME_VERSION = 1;
/** The most a frame's payload may be: 16 MiB. A reader refuses more; the sender drops such a frame. */
export const STREAM_MAX_PAYLOAD = 16 * 1024 * 1024;
/** An ack carries no payload; a receiver that says more (a newer one) says at most this much, and the sender reads past it. */
export const STREAM_MAX_ACK_PAYLOAD = 1024;
/** The link stream's label: a receiver takes these with `transport.onStream("browser.stream", …)`. */
export const STREAM_LINK_LABEL = "browser.stream";
export const STREAM_HEADER_BYTES = 16;

/** What the link stream's `meta` carries. */
export interface StreamLinkMeta {
  v: typeof STREAM_FRAME_VERSION;
  /** The stream's id, as `browser.stream` answered it. */
  stream: string;
  tab: string;
  /** The computer whose tab it is. */
  computer: string;
  /** The receiver acknowledges each frame (the format above). */
  acks: true;
}

const KIND = { config: 1, frame: 2, ended: 3, ack: 4 } as const;
const CODECS: readonly StreamCodec[] = ["h264", "vp8", "jpeg"];
const REASONS = ["stopped", "closed", "failed"] as const;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/** One chunk as one frame of the link stream (the format above). */
export function encodeStreamFrame(chunk: StreamChunk): Uint8Array {
  let payload: Uint8Array;
  let flags = 0;
  let timestamp = 0;
  switch (chunk.kind) {
    case "config":
      payload = utf8.encode(JSON.stringify({ codec: chunk.codec, width: chunk.width, height: chunk.height, codecString: chunk.codecString }));
      break;
    case "frame":
      payload = chunk.data;
      flags = chunk.key ? 1 : 0;
      timestamp = chunk.timestamp;
      break;
    case "ended":
      payload = utf8.encode(JSON.stringify(chunk.message !== undefined ? { reason: chunk.reason, message: chunk.message } : { reason: chunk.reason }));
      break;
  }
  if (payload.byteLength > STREAM_MAX_PAYLOAD) throw new Error(`a stream frame's payload is at most ${STREAM_MAX_PAYLOAD} bytes`);
  const out = new Uint8Array(STREAM_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, STREAM_FRAME_VERSION);
  view.setUint8(1, KIND[chunk.kind]);
  view.setUint8(2, flags);
  view.setUint8(3, 0);
  view.setBigInt64(4, BigInt(Math.round(timestamp)));
  view.setUint32(12, payload.byteLength);
  out.set(payload, STREAM_HEADER_BYTES);
  return out;
}

/** One frame of the link stream back to its chunk. Throws on anything that isn't exactly one well-formed frame. */
export function decodeStreamFrame(bytes: Uint8Array): StreamChunk {
  if (bytes.byteLength < STREAM_HEADER_BYTES) throw new Error("a stream frame is at least 16 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== STREAM_FRAME_VERSION) throw new Error(`stream frame version ${version} isn't one this reads`);
  const length = view.getUint32(12);
  if (length > STREAM_MAX_PAYLOAD) throw new Error(`a stream frame's payload is at most ${STREAM_MAX_PAYLOAD} bytes`);
  if (bytes.byteLength !== STREAM_HEADER_BYTES + length) throw new Error("the stream frame's length doesn't match its bytes");
  const payload = bytes.subarray(STREAM_HEADER_BYTES);
  const kind = view.getUint8(1);
  switch (kind) {
    case KIND.config: {
      const c = jsonObject(payload);
      if (!CODECS.includes(c.codec as StreamCodec) || !isSize(c.width) || !isSize(c.height) || !fitsArea(c.width, c.height) || typeof c.codecString !== "string") throw new Error("a bad stream config");
      return { kind: "config", codec: c.codec as StreamCodec, width: c.width, height: c.height, codecString: c.codecString };
    }
    case KIND.frame:
      return { kind: "frame", key: (view.getUint8(2) & 1) === 1, timestamp: Number(view.getBigInt64(4)), data: payload.slice() };
    case KIND.ended: {
      const e = jsonObject(payload);
      const reason = REASONS.includes(e.reason as (typeof REASONS)[number]) ? (e.reason as (typeof REASONS)[number]) : "failed";
      return typeof e.message === "string" ? { kind: "ended", reason, message: e.message } : { kind: "ended", reason };
    }
    default:
      throw new Error(`stream frame kind ${kind} isn't one this reads`);
  }
}

/** The receiver's ack for the frame stamped `timestamp` (µs): the header with kind 4 and no payload. */
export function encodeStreamAck(timestamp: number): Uint8Array {
  const out = new Uint8Array(STREAM_HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, STREAM_FRAME_VERSION);
  view.setUint8(1, KIND.ack);
  view.setBigInt64(4, BigInt(Math.round(timestamp)));
  return out;
}

/** The sender's reader for acks, which may arrive cut anywhere: the timestamps acknowledged, in order. A frame that
 *  isn't an ack, or has a payload, is skipped by its own length (a newer receiver may say more). */
export class StreamAckReader {
  private head = new Uint8Array(STREAM_HEADER_BYTES);
  private have = 0;
  /** Payload bytes of the current frame still to skip. */
  private skip = 0;

  /** Walks the bytes as they come: no buffer holds more than one header, and nothing is copied per chunk. */
  push(bytes: Uint8Array): number[] {
    const out: number[] = [];
    let at = 0;
    while (at < bytes.byteLength) {
      if (this.skip > 0) {
        const take = Math.min(this.skip, bytes.byteLength - at);
        this.skip -= take;
        at += take;
        continue;
      }
      const take = Math.min(STREAM_HEADER_BYTES - this.have, bytes.byteLength - at);
      this.head.set(bytes.subarray(at, at + take), this.have);
      this.have += take;
      at += take;
      if (this.have < STREAM_HEADER_BYTES) break;
      const view = new DataView(this.head.buffer);
      const length = view.getUint32(12);
      if (length > STREAM_MAX_ACK_PAYLOAD) throw new Error("a bad ack frame");
      if (view.getUint8(0) === STREAM_FRAME_VERSION && view.getUint8(1) === KIND.ack) out.push(Number(view.getBigInt64(4)));
      this.skip = length;
      this.have = 0;
    }
    return out;
  }
}

/** Splits bytes that arrive as one run (a byte stream rather than frames) back into chunks. */
export class StreamFrameReader {
  private buffered = new Uint8Array(0);

  push(bytes: Uint8Array): StreamChunk[] {
    const all = new Uint8Array(this.buffered.byteLength + bytes.byteLength);
    all.set(this.buffered, 0);
    all.set(bytes, this.buffered.byteLength);
    const out: StreamChunk[] = [];
    let at = 0;
    while (all.byteLength - at >= STREAM_HEADER_BYTES) {
      const length = new DataView(all.buffer, at, STREAM_HEADER_BYTES).getUint32(12);
      // A length over the cap is a broken stream: refused before anything that long is buffered.
      if (length > STREAM_MAX_PAYLOAD) throw new Error(`a stream frame's payload is at most ${STREAM_MAX_PAYLOAD} bytes`);
      const end = at + STREAM_HEADER_BYTES + length;
      if (end > all.byteLength) break;
      out.push(decodeStreamFrame(all.subarray(at, end)));
      at = end;
    }
    this.buffered = all.slice(at);
    return out;
  }
}

/** A config's or an ended frame's payload: a JSON object, or a format error (lane I's receivers refuse the same). */
function jsonObject(payload: Uint8Array): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(fromUtf8.decode(payload));
  } catch {
    throw new Error("a stream frame's JSON doesn't parse");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("a stream frame's JSON isn't an object");
  return v as Record<string, unknown>;
}

function isSize(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 16384;
}

/** A picture's two sides together: within the viewport area cap (`MAX_VIEWPORT_PIXELS`). */
function fitsArea(w: number, h: number): boolean {
  return w * h <= MAX_VIEWPORT_PIXELS;
}

// -------------------------------------------------------------------------------------------------
// The sender
// -------------------------------------------------------------------------------------------------

/** How the sender follows the link. The start bitrate is S7's figure; the thresholds were measured on a throttled link
 *  (`test/browser/stream-measure.ts`, 6 bandwidth scenarios, a socket buffer of 0, 64 and 256 KiB): against the first
 *  guess (0.5 s, x0.6, x1.25, 4 s, 1 s) the picture lagged a third as long and its worst 95th-percentile delay fell from
 *  2 s to 0.35 s on a link that takes bytes as they are written, for about a fifth less of the link used. */
export interface StreamTuning {
  /** The bitrate a stream starts at when the caller names no `maxKbps` (S7: about 2.3 Mbit/s for 30 fps of motion). */
  defaultKbps: number;
  /** Never lower than this (nor than `maxKbps`). */
  minKbps: number;
  /** Falling behind multiplies the bitrate by this… */
  lowerFactor: number;
  /** …at most once in this long. */
  lowerEveryMs: number;
  /** Keeping up for `raiseAfterMs` multiplies it by this, up to `maxKbps`. */
  raiseFactor: number;
  raiseAfterMs: number;
  /** Bytes written to a viewer's link stream and not yet taken past which it has fallen behind; by default
   *  `highWaterSeconds` of video at its current bitrate, and at least `highWaterMinBytes`. It has caught up again
   *  under `lowWaterFraction` of that. */
  highWaterBytes?: number;
  highWaterSeconds: number;
  highWaterMinBytes: number;
  lowWaterFraction: number;
  /** A keyframe asked for that hasn't come in this long is asked for again. */
  keyframeRetryMs: number;
  /** Frames sent and not yet acknowledged at most (once the receiver acks at all), and how long without an ack before
   *  the window is let go of. */
  maxUnacked: number;
  ackTimeoutMs: number;
  /** The oldest unacknowledged frame this old, with the window full, counts as congestion (the bitrate is lowered). */
  ackSlowMs: number;
}

export const DEFAULT_STREAM_TUNING: StreamTuning = {
  defaultKbps: 2500,
  minKbps: 100,
  lowerFactor: 0.5,
  lowerEveryMs: 250,
  raiseFactor: 1.1,
  raiseAfterMs: 8000,
  highWaterSeconds: 0.35,
  highWaterMinBytes: 64 * 1024,
  lowWaterFraction: 0.25,
  keyframeRetryMs: 1000,
  maxUnacked: 2,
  ackTimeoutMs: 5000,
  ackSlowMs: 400,
};

export interface TabStreamsOptions {
  /** This computer's name, for the link stream's meta. */
  computer: string;
  /** Lane H's transport: the link to each viewer's device, and the links going down. */
  transport: Pick<LinkTransport, "connect" | "watch">;
  /** The app's port (the same one `BrowserService` has), or undefined while no app runs here. */
  app: () => AppTabPort | undefined;
  now?: () => number;
  newId?: () => string;
  tuning?: Partial<StreamTuning>;
  /** A viewer's stream ended (stopped, the tab closed, the device went, or the link cut it). */
  ended?(info: { stream: string; tab: string; device: string; reason: "stopped" | "closed" | "gone" | "failed" }): void;
}

/** One stream as `TabStreams.list()` shows it (diagnostics, tests). */
export interface StreamInfo {
  stream: string;
  tab: string;
  device: string;
  /** The app's stream this viewer shares (one encoder per tab and codec set). */
  appStream: string;
  codec?: StreamCodec;
  kbps: number;
  maxKbps: number;
  backlogBytes: number;
  /** Waiting for a keyframe: deltas are dropped meanwhile. */
  waitingForKey: boolean;
  sent: number;
  dropped: number;
  lowered: number;
  raised: number;
}

interface Viewer {
  id: string;
  tab: string;
  device: string;
  link: LinkStream;
  group: AppStream;
  maxKbps: number;
  kbps: number;
  codecs?: StreamCodec[];
  backlog: number;
  configSent: boolean;
  needKey: boolean;
  /** Since when its backlog has stayed under the low mark. */
  calmSince: number;
  loweredAt?: number;
  done: boolean;
  offEnd: () => void;
  offData: () => void;
  /** Frames sent and not yet acknowledged: their timestamps and when they were sent. */
  unacked: { ts: number; at: number }[];
  /** The receiver has acked at least once: the window applies. */
  acking: boolean;
  acks: StreamAckReader;
  sent: number;
  dropped: number;
  lowered: number;
  raised: number;
}

/** One stream the app runs (one encoder): a tab, shared by every viewer whose codecs it suits. */
interface AppStream {
  id: string;
  tab: string;
  codecs?: StreamCodec[];
  viewers: Set<Viewer>;
  config?: Extract<StreamChunk, { kind: "config" }>;
  /** The bitrate last asked of the app. */
  kbps: number;
  keyAskedAt?: number;
  /** The app has said yes (its `stream` command resolved). */
  started: boolean;
}

export class TabStreams {
  private readonly groups = new Map<string, AppStream>();
  private readonly viewers = new Map<string, Viewer>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly tuning: StreamTuning;
  private readonly offWatch: () => void;

  constructor(private readonly opts: TabStreamsOptions) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `bs_${randomBytes(9).toString("base64url")}`);
    this.tuning = { ...DEFAULT_STREAM_TUNING, ...opts.tuning };
    this.offWatch = opts.transport.watch((view) => { if (!view.up) this.deviceGone(view.peer); });
  }

  /** Starts streaming `tab` to `device` (after the caller's checks). A second call for the same pair answers the
   *  same stream. A second device on the same tab shares the tab's encoder when its codecs suit it, at the lower of
   *  the two bitrates, and gets its own keyframe; one that needs another codec gets an encoder of its own. */
  async start(args: { tab: string; device: string; maxKbps?: number; codecs?: StreamCodec[] }): Promise<{ stream: string }> {
    const existing = this.find(args.tab, args.device);
    if (existing !== undefined) return { stream: existing.id };
    const app = this.opts.app();
    if (app === undefined) throw new BrowserError("no_app", "the Clover app isn't running on this computer, so it can't stream a tab");
    const codecs = args.codecs !== undefined && args.codecs.length > 0 ? [...new Set(args.codecs)] : undefined;
    const maxKbps = Math.max(this.tuning.minKbps, Math.round(args.maxKbps ?? this.tuning.defaultKbps));
    const link = await this.opts.transport.connect(args.device);
    // Another start for the same pair may have finished while this one dialled.
    const raced = this.find(args.tab, args.device);
    if (raced !== undefined) return { stream: raced.id };
    const id = this.newId();
    const meta: StreamLinkMeta = { v: STREAM_FRAME_VERSION, stream: id, tab: args.tab, computer: this.opts.computer, acks: true };
    const stream = link.openStream(STREAM_LINK_LABEL, "screenshots", meta);
    let group = [...this.groups.values()].find((g) => g.tab === args.tab && suits(g, codecs));
    const fresh = group === undefined;
    group ??= { id: this.newId(), tab: args.tab, ...(codecs !== undefined ? { codecs } : {}), viewers: new Set(), kbps: maxKbps, started: false };
    const now = this.now();
    const viewer: Viewer = {
      id, tab: args.tab, device: args.device, link: stream, group, maxKbps, kbps: maxKbps, ...(codecs !== undefined ? { codecs } : {}),
      backlog: 0, configSent: false, needKey: true, calmSince: now, done: false, offEnd: () => {}, offData: () => {}, unacked: [], acking: false, acks: new StreamAckReader(), sent: 0, dropped: 0, lowered: 0, raised: 0,
    };
    viewer.offData = stream.onData((bytes) => this.onAck(viewer, bytes));
    viewer.offEnd = stream.onEnd((error) => { if (!viewer.done) this.remove(viewer, error === undefined ? "stopped" : "gone", false); });
    group.viewers.add(viewer);
    this.viewers.set(id, viewer);
    if (fresh) {
      this.groups.set(group.id, group);
      try {
        await app.command(args.tab, { kind: "stream", stream: group.id, on: true, maxKbps, ...(codecs !== undefined ? { codecs } : {}) });
        group.started = true;
        // Every viewer left while the app was starting it.
        if (group.viewers.size === 0 && this.groups.delete(group.id)) app.command(args.tab, { kind: "stream", stream: group.id, on: false }).catch(() => undefined);
      } catch (e) {
        this.groups.delete(group.id);
        for (const v of [...group.viewers]) {
          v.done = true;
          v.offEnd();
          v.offData();
          this.viewers.delete(v.id);
          v.link.abort("the app couldn't stream the tab");
        }
        group.viewers.clear();
        throw new BrowserError("app_failed", `the app couldn't stream the tab: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      // Joining a running encoder: its config first, then a keyframe of its own.
      if (group.config !== undefined) this.send(viewer, group.config);
      this.askKey(group, true);
      this.syncKbps(group);
    }
    return { stream: id };
  }

  /** Stops `tab`'s stream to `device`: an `ended` frame, the link stream ended, and the app's encoder stopped once no
   *  viewer is left on it. */
  async stop(args: { tab: string; device: string }): Promise<void> {
    const viewer = this.find(args.tab, args.device);
    if (viewer !== undefined) this.remove(viewer, "stopped", true);
  }

  /** A chunk from the app (`streamData`, carried by lane E's pair), for the app stream `stream`. */
  data(stream: string, chunk: StreamChunk): void {
    const group = this.groups.get(stream);
    if (group === undefined) return;
    switch (chunk.kind) {
      case "config":
        group.config = chunk;
        for (const v of group.viewers) {
          this.send(v, chunk);
          v.needKey = true; // a new config is followed by a keyframe
        }
        return;
      case "ended":
        this.groups.delete(group.id);
        for (const v of [...group.viewers]) this.finish(v, chunk);
        group.viewers.clear();
        return;
      case "frame":
        this.frame(group, chunk);
        return;
    }
  }

  /** The tab closed: its streams end (`closed`); the app has nothing left to stop. */
  tabClosed(tab: string): void {
    for (const group of [...this.groups.values()]) {
      if (group.tab !== tab) continue;
      this.groups.delete(group.id);
      for (const v of [...group.viewers]) this.finish(v, { kind: "ended", reason: "closed" });
      group.viewers.clear();
    }
  }

  /** The app stopped or restarted (lane E's pair went down): its encoders are gone, so every stream ends (`failed`);
   *  a viewer that still wants the tab asks again. */
  appGone(): void {
    for (const group of [...this.groups.values()]) {
      this.groups.delete(group.id);
      for (const v of [...group.viewers]) this.finish(v, { kind: "ended", reason: "failed", message: "the Clover app stopped" });
      group.viewers.clear();
    }
  }

  /** A device's link went down (also wired to the transport's `watch`): its streams go, quietly. */
  deviceGone(device: string): void {
    for (const v of [...this.viewers.values()]) if (v.device === device) this.remove(v, "gone", false);
  }

  list(): StreamInfo[] {
    return [...this.viewers.values()].map((v) => ({
      stream: v.id, tab: v.tab, device: v.device, appStream: v.group.id, ...(v.group.config !== undefined ? { codec: v.group.config.codec } : {}),
      kbps: v.kbps, maxKbps: v.maxKbps, backlogBytes: v.backlog, waitingForKey: v.needKey, sent: v.sent, dropped: v.dropped, lowered: v.lowered, raised: v.raised,
    }));
  }

  /** Every stream stops (the core is shutting down). */
  close(): void {
    this.offWatch();
    for (const v of [...this.viewers.values()]) this.remove(v, "stopped", true);
  }

  // -----------------------------------------------------------------------------------------------

  private find(tab: string, device: string): Viewer | undefined {
    for (const v of this.viewers.values()) if (v.tab === tab && v.device === device) return v;
    return undefined;
  }

  private high(v: Viewer): number {
    return this.tuning.highWaterBytes ?? Math.max(this.tuning.highWaterMinBytes, Math.round(((v.kbps * 1000) / 8) * this.tuning.highWaterSeconds));
  }

  private low(v: Viewer): number {
    return this.high(v) * this.tuning.lowWaterFraction;
  }

  private frame(group: AppStream, chunk: Extract<StreamChunk, { kind: "frame" }>): void {
    const now = this.now();
    if (chunk.data.byteLength > STREAM_MAX_PAYLOAD) {
      // Over the format's cap (a huge picture at a high quality): never sent; every viewer waits for a keyframe at a
      // lower bitrate.
      for (const v of group.viewers) {
        v.dropped++;
        v.needKey = true;
        this.fellBehind(v, now);
      }
      return;
    }
    if (chunk.key) group.keyAskedAt = undefined;
    for (const v of group.viewers) {
      if (!v.configSent) {
        v.dropped++;
        continue;
      }
      const high = this.high(v);
      const low = this.low(v);
      if (v.backlog > low) v.calmSince = now;
      if (v.backlog > high) this.fellBehind(v, now);
      if (v.needKey && (!chunk.key || v.backlog > low)) {
        // Deltas wait for a keyframe; so does a keyframe while the link is still full (newest only, for video).
        v.dropped++;
        continue;
      }
      if (v.acking && v.unacked.length >= this.tuning.maxUnacked) {
        // Two frames are out and unanswered: this one waits for nothing, and the deltas after it wait for a keyframe
        // (the link's buffers must never hold more than two frames of the picture).
        if (now - v.unacked[0]!.at > this.tuning.ackTimeoutMs) {
          v.unacked.length = 0; // acks stopped: let the window go and start again from a keyframe
          v.needKey = true;
        } else {
          v.dropped++;
          // A window full for a round trip is no sign of a narrow link; one full for `ackSlowMs` is.
          // Frames sent before the last lowering say nothing of the new rate: wait for one sent after it.
          const oldest = v.unacked[0]!;
          if (now - oldest.at > this.tuning.ackSlowMs && (v.loweredAt === undefined || oldest.at > v.loweredAt)) this.fellBehind(v, now);
          else v.needKey = true;
        }
        continue;
      }
      v.needKey = false;
      this.send(v, chunk);
      if (v.kbps < v.maxKbps && now - v.calmSince >= this.tuning.raiseAfterMs) {
        v.kbps = Math.min(v.maxKbps, Math.round(v.kbps * this.tuning.raiseFactor));
        v.calmSince = now;
        v.raised++;
      }
    }
    if ([...group.viewers].some((v) => v.needKey && v.configSent && v.backlog <= this.low(v))) this.askKey(group, false);
    this.syncKbps(group);
  }

  private fellBehind(v: Viewer, now: number): void {
    v.needKey = true;
    if (v.loweredAt !== undefined && now - v.loweredAt < this.tuning.lowerEveryMs) return;
    const floor = Math.min(v.maxKbps, this.tuning.minKbps);
    const next = Math.max(floor, Math.round(v.kbps * this.tuning.lowerFactor));
    if (next < v.kbps) v.lowered++;
    v.kbps = next;
    v.loweredAt = now;
  }

  private send(v: Viewer, chunk: StreamChunk): void {
    if (v.done) return;
    const bytes = encodeStreamFrame(chunk);
    v.backlog += bytes.byteLength;
    if (chunk.kind === "config") v.configSent = true;
    if (chunk.kind === "frame") {
      v.sent++;
      v.unacked.push({ ts: chunk.timestamp, at: this.now() });
    }
    v.link.write(bytes).then(
      () => {
        v.backlog -= bytes.byteLength;
        // Caught up while waiting for a keyframe: ask for one now rather than at the next frame.
        if (!v.done && v.needKey && v.configSent && v.backlog <= this.low(v)) this.askKey(v.group, false);
      },
      () => {
        v.backlog -= bytes.byteLength;
        if (!v.done) this.remove(v, "gone", false);
      },
    );
  }

  /** The receiver's acks: each frees its frame and the ones before it. */
  private onAck(v: Viewer, bytes: Uint8Array): void {
    let stamps: number[];
    try {
      stamps = v.acks.push(bytes);
    } catch {
      this.remove(v, "gone", false);
      return;
    }
    for (const ts of stamps) {
      const at = v.unacked.findIndex((u) => u.ts === ts);
      if (at >= 0) v.unacked.splice(0, at + 1);
      v.acking = true;
    }
    if (stamps.length > 0 && !v.done && v.needKey && v.configSent && v.backlog <= this.low(v) && v.unacked.length < this.tuning.maxUnacked) this.askKey(v.group, false);
  }

  /** Asks the app for a keyframe, at most once per `keyframeRetryMs` unless `now` (a viewer joined). */
  private askKey(group: AppStream, force: boolean): void {
    if (!this.groups.has(group.id)) return;
    const now = this.now();
    if (!force && group.keyAskedAt !== undefined && now - group.keyAskedAt < this.tuning.keyframeRetryMs) return;
    group.keyAskedAt = now;
    this.control(group, { keyframe: true });
  }

  /** The app's bitrate is the lowest any of its viewers can take. */
  private syncKbps(group: AppStream): void {
    if (!this.groups.has(group.id) || group.viewers.size === 0) return;
    const kbps = Math.min(...[...group.viewers].map((v) => v.kbps));
    if (kbps === group.kbps) return;
    group.kbps = kbps;
    this.control(group, { kbps });
  }

  private control(group: AppStream, what: { keyframe?: boolean; kbps?: number }): void {
    const app = this.opts.app();
    if (app === undefined) return;
    app.command(group.tab, { kind: "stream-control", stream: group.id, ...what }).catch(() => undefined);
  }

  /** Ends a viewer with `chunk` (the app's `ended`, or the tab closing), its link stream ended after it. */
  private finish(v: Viewer, chunk: Extract<StreamChunk, { kind: "ended" }>): void {
    this.send(v, chunk);
    v.done = true;
    v.offEnd();
    v.offData();
    this.viewers.delete(v.id);
    v.link.end();
    this.opts.ended?.({ stream: v.id, tab: v.tab, device: v.device, reason: chunk.reason === "closed" ? "closed" : chunk.reason === "failed" ? "failed" : "stopped" });
  }

  /** A viewer goes: told (`stopped`) when it can still hear it, else its stream just goes. The app's encoder stops
   *  once no viewer is left on it. */
  private remove(v: Viewer, reason: "stopped" | "gone", tell: boolean): void {
    if (v.done) return;
    const group = v.group;
    if (tell) {
      this.finish(v, { kind: "ended", reason: "stopped" });
    } else {
      v.done = true;
      v.offEnd();
      v.offData();
      this.viewers.delete(v.id);
      v.link.abort(reason === "gone" ? "the device went away" : "stopped");
      this.opts.ended?.({ stream: v.id, tab: v.tab, device: v.device, reason });
    }
    group.viewers.delete(v);
    // Not started yet: `start` stops it once the app has answered, so the app never hears "off" before "on".
    if (!this.groups.has(group.id) || !group.started) return;
    if (group.viewers.size > 0) {
      this.syncKbps(group);
      return;
    }
    this.groups.delete(group.id);
    const app = this.opts.app();
    app?.command(group.tab, { kind: "stream", stream: group.id, on: false }).catch(() => undefined);
  }
}

/** A viewer asking for `codecs` can share a running stream: the codec it runs (or would pick) suits it. */
function suits(group: AppStream, codecs: StreamCodec[] | undefined): boolean {
  // No preference means the default pick (hardware H.264, else VP8): a stream the default made, or one running either.
  if (codecs === undefined) return group.config !== undefined ? group.config.codec !== "jpeg" : group.codecs === undefined;
  if (group.config !== undefined) return codecs.includes(group.config.codec);
  return group.codecs !== undefined && group.codecs.length === codecs.length && group.codecs.every((c, i) => codecs[i] === c);
}
