// A tool's live picture on the plugin API and on the app's connections (spec revision 19, §3.6, G5).
//
// * `pictures.publish` (a `host` half, inside the tool call it serves): the engine keys the picture to the session of THAT
//   call, read from the core's own record of the call (`ctx.invocation`, `ctx.caller`), and asks the plugin's validated
//   manifest whether that call's own server declares `picture: true` (a second server of the same plugin that doesn't
//   declare it is refused). The frames come over a byte stream whose writer is the publisher's watch: runs of a 4-byte
//   big-endian length and one image. The stream ending or going ends the picture.
// * `pictures.list`, `watch`, `open` (a plugin that holds `picture.read.<kind>`; the router has gated each by the kind
//   the call reaches, and `open` by the kind of the picture it opens): `open` is a byte stream of the same frames, latest
//   wins (a reader that falls behind skips frames).
// * `picture.list`, `picture.open`, `picture.close` (a window's connection) and the `picture.frame` notifications that carry
//   the frames to it, one connection's own, never an area's event.
// Nothing here reads a pixel: a frame is bytes the engine checks the header of (`frameVerdict`) and passes on.
import { PICTURE_FRAME_LENGTH_BYTES, PICTURE_FRAME_MAX_BYTES, PICTURE_FRAME_NOTIFICATION, PICTURE_MAX_FPS, PicturePublishMeta, type DataKind, type PictureFrame } from "@waifucave/moss-protocol";
import { randomBytes } from "node:crypto";
import type { MossConn } from "../ipc/moss";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { FeedReader } from "../contracts/activity-feed";
import { imageSize, type PictureEvent, type ToolCallContext } from "../contracts/live-pictures";
import { listenerArg, stringArg, type ApiCallContext, type ApiHandlers } from "../plugin-host/api/router";
import { ENGINE, type StreamHub } from "../streams/hub";
import { STREAM_CHUNK_MAX } from "@waifucave/moss-plugin-sdk/streams";
import type { EngineLivePictures } from "./live-pictures";

/** What the pictures need to know of a session: its kind and its bot, from the session host. */
export interface PictureSessions {
  get(id: string): { kind: DataKind; bot?: string } | undefined;
}

export interface PicturesApiOptions {
  pictures: EngineLivePictures;
  hub: StreamHub;
  sessions: PictureSessions;
  now(): number;
}

/** The engine's own reading of a plugin's grants: a plugin reads the kinds its OK names (the router has checked). */
const readerOf = (ctx: ApiCallContext): FeedReader => ({ kind: "plugin", capabilities: ctx.record.granted });

/** Cuts a run of bytes into frames (a 4-byte big-endian length, then that many bytes). A frame announced larger than the
 *  most there is, or of no length, is `bad`: the picture ends and nothing is buffered for it. */
export class FrameCutter {
  #buf = new Uint8Array(0);
  /** Gives each whole frame to `frame`; returns `"bad"` when a length is not one a frame has. */
  push(bytes: Uint8Array, frame: (b: Uint8Array) => void): "ok" | "bad" {
    const next = new Uint8Array(this.#buf.length + bytes.length);
    next.set(this.#buf);
    next.set(bytes, this.#buf.length);
    let at = 0;
    for (;;) {
      if (next.length - at < PICTURE_FRAME_LENGTH_BYTES) break;
      const len = new DataView(next.buffer, next.byteOffset + at, PICTURE_FRAME_LENGTH_BYTES).getUint32(0);
      if (len === 0 || len > PICTURE_FRAME_MAX_BYTES) return "bad";
      if (next.length - at - PICTURE_FRAME_LENGTH_BYTES < len) break;
      frame(next.slice(at + PICTURE_FRAME_LENGTH_BYTES, at + PICTURE_FRAME_LENGTH_BYTES + len));
      at += PICTURE_FRAME_LENGTH_BYTES + len;
    }
    this.#buf = next.slice(at);
    return "ok";
  }
}

/** A frame as the stream carries it: its length, then its bytes. */
export function lengthPrefixed(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(PICTURE_FRAME_LENGTH_BYTES + frame.length);
  new DataView(out.buffer).setUint32(0, frame.length);
  out.set(frame, PICTURE_FRAME_LENGTH_BYTES);
  return out;
}

/** Latest wins: `deliver` is given the newest frame when it is free (at most `maxFps` a second); frames that came while it
 *  was busy are dropped but the last. `stop` ends it. */
export function latestWins(deliver: (frame: Uint8Array) => Promise<void> | void, maxFps: number, now: () => number): { push(frame: Uint8Array): void; stop(): void } {
  let pending: Uint8Array | undefined;
  let busy = false;
  let stopped = false;
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gap = 1000 / Math.max(1, Math.min(maxFps, PICTURE_MAX_FPS));
  const run = async (): Promise<void> => {
    if (busy || stopped || pending === undefined) return;
    const wait = last + gap - now();
    if (wait > 0) {
      timer ??= setTimeout(() => {
        timer = undefined;
        void run();
      }, wait);
      return;
    }
    busy = true;
    const frame = pending;
    pending = undefined;
    last = now();
    try {
      await deliver(frame);
    } catch {
      stopped = true;
    } finally {
      busy = false;
    }
    void run();
  };
  return {
    push(frame) {
      if (stopped) return;
      pending = frame;
      void run();
    },
    stop() {
      stopped = true;
      pending = undefined;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** Follows picture `id` for `reader`: its latest frame now, then each new one, latest wins; `onEnd` hears the picture end.
 *  Returns what stops it. */
function follow(o: Pick<PicturesApiOptions, "pictures" | "now">, id: string, reader: FeedReader, maxFps: number, deliver: (frame: Uint8Array) => Promise<void> | void, onEnd: () => void): Unsubscribe {
  const r = o.pictures.open(id, reader);
  const kind = o.pictures.kindOf(id)!;
  const lw = latestWins(deliver, maxFps, o.now);
  const off = o.pictures.watch(kind, { kind: "user" }, (e) => {
    if ("ended" in e && e.ended === id) {
      end();
    }
  });
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    off();
    r.close();
    lw.stop();
    onEnd();
  };
  r.onFrame((b) => lw.push(b));
  const first = r.latest();
  if (first !== undefined) lw.push(first);
  return () => {
    if (over) return;
    over = true;
    off();
    r.close();
    lw.stop();
  };
}

const fpsOf = (opts: unknown): number => {
  const v = typeof opts === "object" && opts !== null ? (opts as { maxFps?: unknown }).maxFps : undefined;
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), PICTURE_MAX_FPS) : 10;
};

/** The tool call a picture is published for, from the core's own record of the call this API call was made inside (never a
 *  word of the plugin's): its session, the session's kind and bot from the session host, the plugin and the tool, and
 *  whether the call's own server declares `picture: true` (its plugin's validated manifest; another server of the same
 *  plugin that doesn't is refused). */
export function toolCallOf(ctx: ApiCallContext, sessions: PictureSessions): ToolCallContext {
  const call = ctx.invocation;
  if (call === undefined || call.server === undefined || ctx.caller.kind !== "session") {
    throw new ContractError("refused", "a picture is published only from inside a tool call a session made, by the tool that serves it");
  }
  const session = sessions.get(ctx.caller.sessionId);
  if (session === undefined) throw new ContractError("refused", "the session of this tool call isn't one the engine knows");
  const server = ctx.record.manifest?.contributes?.mcpServers?.[call.server];
  const declares = server !== undefined && server.type === "host" && server.picture === true;
  return { session: ctx.caller.sessionId, kind: session.kind, ...(session.bot !== undefined ? { bot: session.bot } : {}), pluginId: ctx.pluginId, tool: call.tool ?? "", callId: call.id, declares, open: true };
}

export function picturesApi(o: PicturesApiOptions): ApiHandlers {
  return {
    "pictures.list": (ctx, args) => {
      const kind = args[0] as DataKind;
      const of = typeof args[1] === "object" && args[1] !== null ? (args[1] as { session?: unknown; bot?: unknown }) : {};
      return o.pictures.list(kind, readerOf(ctx), { ...(typeof of.session === "string" ? { session: of.session } : {}), ...(typeof of.bot === "string" ? { bot: of.bot } : {}) });
    },
    "pictures.watch": (ctx, args) => {
      const listener = listenerArg<PictureEvent>(args, 1);
      return o.pictures.watch(args[0] as DataKind, readerOf(ctx), (e) => listener(("ended" in e ? { ended: e.ended } : e) as PictureEvent));
    },
    // The frames to a plugin: a stream the engine writes, whose reader is the caller's watch.
    "pictures.open": (ctx, args) => {
      const id = stringArg(args, 0, "the picture", 64);
      const listener = listenerArg<import("../streams/hub").StreamEvent>(args, 2);
      const fps = fpsOf(args[1]);
      const stream = o.hub.openFromEngine({ pluginId: ctx.pluginId, side: ctx.process, listener }, `picture/${id}`);
      const write = async (frame: Uint8Array) => {
        const bytes = lengthPrefixed(frame);
        for (let at = 0; at < bytes.length; at += STREAM_CHUNK_MAX) await o.hub.write(stream.id, ENGINE, bytes.subarray(at, at + STREAM_CHUNK_MAX));
      };
      let stop: Unsubscribe;
      try {
        stop = follow(o, id, readerOf(ctx), fps, write, () => {
          try {
            o.hub.end(stream.id, ENGINE);
          } catch {
            // already over
          }
        });
      } catch (err) {
        stream.stop();
        throw err;
      }
      return () => {
        stop();
        stream.stop();
      };
    },
    // A tool's host half publishes the picture of what it is doing, inside the tool call it serves.
    "pictures.publish": (ctx, args) => {
      const listener = listenerArg<import("../streams/hub").StreamEvent>(args, 1);
      const call = toolCallOf(ctx, o.sessions);
      const parsed = PicturePublishMeta.safeParse(args[0]);
      if (!parsed.success) throw new ContractError("invalid", "a picture's meta is its format and size only");
      const publisher = o.pictures.publish(call, parsed.data);
      const cutter = new FrameCutter();
      let stream: { id: string; stop: Unsubscribe } | undefined;
      const onEvent = (e: import("../streams/hub").StreamEvent) => {
        if (e.type === "chunk") {
          const verdict = cutter.push(e.data, (frame) => publisher.frame(frame));
          if (verdict === "bad") {
            o.pictures.endWith(publisher.id, "too-large");
            if (stream !== undefined) o.hub.cancel(stream.id, ENGINE, "a frame's length is not one a frame has");
            return;
          }
          if (stream !== undefined) o.hub.ack(stream.id, ENGINE, e.data.length);
        } else if (e.type === "end" || e.type === "aborted") publisher.end();
      };
      try {
        stream = o.hub.openIntoEngine({ pluginId: ctx.pluginId, side: ctx.process, listener }, `picture/${publisher.id}`, onEvent);
      } catch (err) {
        publisher.end();
        throw err;
      }
      const opened = stream;
      return () => {
        opened.stop();
        publisher.end();
      };
    },
  };
}

/** The window's door (`picture.list`, `picture.open`, `picture.close`): the user's own connection, so no capability. */
export function pictureWindowHandlers(o: Pick<PicturesApiOptions, "pictures" | "now">): Record<string, (conn: MossConn, params: unknown) => unknown> {
  const user: FeedReader = { kind: "user" };
  return {
    "picture.list": (_conn, params) => {
      const p = (params ?? {}) as { kind?: DataKind; session?: string; bot?: string };
      if (p.kind !== "sessions" && p.kind !== "bots") throw new ContractError("invalid", "picture.list takes a kind");
      return { pictures: o.pictures.list(p.kind, user, { ...(p.session !== undefined ? { session: p.session } : {}), ...(p.bot !== undefined ? { bot: p.bot } : {}) }) };
    },
    "picture.open": (conn, params) => {
      const p = (params ?? {}) as { id?: string; maxFps?: number };
      if (typeof p.id !== "string") throw new ContractError("invalid", "picture.open takes a picture id");
      const view = o.pictures.view(p.id);
      if (view === undefined) throw new ContractError("not_found", "no such live picture");
      const stream = `pstr_${randomBytes(9).toString("base64url")}`;
      let seq = 0;
      const stop = follow(o, p.id, user, fpsOf(p), (frame) => {
        const size = imageSize(view.format, frame) ?? { width: view.width, height: view.height };
        const wire: PictureFrame = { stream, seq: seq++, format: view.format, width: size.width, height: size.height, data: Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString("base64"), at: o.now() };
        conn.notify(PICTURE_FRAME_NOTIFICATION, wire);
      }, () => conn.follows.delete(`picture:${stream}`));
      conn.follows.set(`picture:${stream}`, stop);
      return { stream };
    },
    "picture.close": (conn, params) => {
      const stream = (params as { stream?: unknown } | undefined)?.stream;
      if (typeof stream !== "string") throw new ContractError("invalid", "picture.close takes a stream");
      const stop = conn.follows.get(`picture:${stream}`);
      conn.follows.delete(`picture:${stream}`);
      stop?.();
      return { ok: true as const };
    },
  };
}
