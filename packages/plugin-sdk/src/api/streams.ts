// Streams (spec §5.4 "Streams"): the bounds, and the SDK's own `open`, `accept` and `points.stream` for both halves of
// a plugin. The daemon keeps the streams (`packages/core/src/streams/`): credit-based, in order, one writer and one
// reader per stream. Every endpoint is a watch on the wire, so either side going ends the stream, and a half makes the
// Web streams a plugin sees from the watch's events and a few calls (`streams.write`, `end`, `cancel`, `ack`).
//
// Both halves share this code: the host runtime (a watch over `pluginHost.api`) and a component (a watch over the layer
// connection) each give it a `StreamsTransport`. Types only besides the bounds, so a plugin-host process loads it
// without the rest of the SDK (`@waifucave/moss-plugin-sdk/streams`).
import type { StreamMeta, StreamOpenEvent, StreamOpenOptions, StreamReadEvent, StreamsAcceptHandle } from "./plugin-api";

/** A piece of a stream, at most (raw bytes): a component's piece crosses its connection as base64 in one watch value
 *  (`LAYER_WATCH_VALUE_MAX_BYTES`, 256 KiB) and as one call's arguments (`LAYER_CALL_MAX_BYTES`, 64 KiB). The SDK's
 *  writable cuts bigger writes into pieces; a call of `streams.write` with a bigger one is refused. */
export const STREAM_CHUNK_MAX = 32 * 1024;
/** What the daemon holds for a stream the reader hasn't been sent yet: a `write` waits while it would pass this. */
export const STREAM_BUFFER_MAX = 256 * 1024;
/** What the daemon has sent a reader and the reader hasn't acknowledged, at most (a piece may start under it). Eight
 *  streams of a plugin at once keep a component's connection well under the 4 MiB the app lets a reader fall behind. */
export const STREAM_WINDOW_MAX = 192 * 1024;
/** Streams open at once, per plugin (a points stream counts for its caller and for its contributor). */
export const STREAMS_OPEN_PER_PLUGIN = 8;
/** Names a plugin accepts at once (all its halves together). */
export const STREAM_ACCEPTORS_PER_PLUGIN = 16;
/** A stream's `meta`, serialized, at most. */
export const STREAM_META_MAX_BYTES = 4096;
/** A stream's name. */
export const STREAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;
/** A handler's stream through `points.stream`: its whole time, at most (and by default). */
export const STREAM_POINT_TIMEOUT_MAX_MS = 600_000;
/** How much a reader has consumed before it tells the daemon (it tells it at once when it has read everything it was
 *  sent), so a component isn't one call per piece. */
export const STREAM_ACK_BATCH = 48 * 1024;

/** What a half gives the SDK to reach the daemon: a call, and a watch (the listener in `args[at]`; its `opened` settles
 *  once the daemon opened it or refused it, `ended` with why when the daemon ends it, `stop` ends it from here). */
export interface StreamsTransport {
  call(path: string, args: unknown[]): Promise<unknown>;
  watch(path: string, args: unknown[], at: number): { stop(): void; opened: Promise<void>; ended: Promise<string> };
}

const reasonText = (r: unknown, fallback: string): string => {
  const text = r instanceof Error ? r.message : typeof r === "string" ? r : r === undefined ? "" : String(r);
  return (text === "" ? fallback : text).slice(0, 500);
};

/** `streams.open`: the writable end, once an acceptor took the stream. */
export function openStream(t: StreamsTransport, name: string, options?: StreamOpenOptions, onEvent?: (event: StreamOpenEvent) => void): Promise<WritableStream<Uint8Array>> {
  const wire = options?.meta !== undefined ? { meta: options.meta } : {};
  return writableWatch(t, "streams.open", [name, wire, undefined], 2, options?.signal, onEvent);
}

/** `pictures.publish`: the writable end of a live picture's frames (each a 4-byte big-endian length and one image), once
 *  the engine took the picture. Its watch is the picture's: the stream ending ends the picture. */
export function publishPicture(t: StreamsTransport, meta: unknown, options?: { signal?: AbortSignal }, onEvent?: (event: StreamOpenEvent) => void): Promise<WritableStream<Uint8Array>> {
  return writableWatch(t, "pictures.publish", [meta, undefined], 1, options?.signal, onEvent);
}

/** A stream's writable end made from a watch at `path`: `args[at]` is where the listener goes. */
function writableWatch(t: StreamsTransport, path: string, args: unknown[], at: number, signal: AbortSignal | undefined, onEvent?: (event: StreamOpenEvent) => void): Promise<WritableStream<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let id: string | undefined;
    let over: Error | undefined;
    let finished = false;
    let controller: WritableStreamDefaultController | undefined;
    let watch: ReturnType<StreamsTransport["watch"]> | undefined;
    const release = () => signal?.removeEventListener("abort", onAbort);
    const fail = (why: string) => {
      if (over !== undefined || finished) return;
      over = new Error(why);
      release();
      if (id === undefined) reject(over);
      else controller?.error(over);
      watch?.stop();
    };
    const onAbort = () => {
      if (over !== undefined || finished) return;
      const why = reasonText(signal?.reason, "aborted");
      // Cancelled first, then the watch's end: the other way round the daemon would hear the writer go.
      if (id !== undefined) void t.call("streams.cancel", [id, why]).catch(() => undefined);
      fail(why);
    };
    const writable = () => new WritableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      async write(chunk) {
        if (over !== undefined) throw over;
        if (!(chunk instanceof Uint8Array)) throw new TypeError("a stream takes bytes (Uint8Array pieces)");
        for (let at = 0; at < chunk.length; at += STREAM_CHUNK_MAX) {
          if (over !== undefined) throw over;
          await t.call("streams.write", [id, chunk.subarray(at, at + STREAM_CHUNK_MAX)]).catch((err: unknown) => {
            throw over ?? err;
          });
        }
      },
      async close() {
        if (over !== undefined) throw over;
        finished = true;
        release();
        // The end first, then the watch's: the other way round the daemon would hear the writer go, not finish.
        try {
          await t.call("streams.end", [id]);
        } finally {
          watch?.stop();
        }
      },
      async abort(reason) {
        const why = reasonText(reason, "aborted by the writer");
        if (over === undefined) over = new Error(why);
        release();
        await t.call("streams.cancel", [id, why]).catch(() => undefined);
        watch?.stop();
      },
    });
    const listener = (raw: unknown) => {
      const e = raw as StreamOpenEvent;
      if (e.type === "open" && id === undefined && typeof e.id === "string") {
        id = e.id;
        resolve(writable());
      } else if (e.type === "aborted") fail(reasonText(e.reason, "the stream was aborted"));
      try {
        onEvent?.(e);
      } catch {
        // the plugin's own listener
      }
    };
    if (signal?.aborted) return reject(new Error(reasonText(signal.reason, "aborted")));
    signal?.addEventListener("abort", onAbort);
    watch = t.watch(path, args.map((a, i) => (i === at ? listener : a)), at);
    watch.opened.catch((err: unknown) => {
      if (over !== undefined || finished) return;
      over = err instanceof Error ? err : new Error(String(err));
      release();
      if (id === undefined) reject(over);
      else controller?.error(over);
    });
    // After the open settled: a watch refused ends too, and the refusal is the reason, not that.
    void watch.opened.then(() => watch!.ended.then((why) => fail(`the stream's watch ended: ${why}`)), () => undefined);
  });
}

/** The readable end of one stream: pieces arrive as events and wait in a queue the reader's `read` takes from, each
 *  acknowledged to the daemon as it is read; the queue never holds more than the window. */
class Incoming {
  readonly stream: ReadableStream<Uint8Array>;
  readonly #queue: Uint8Array[] = [];
  #ended = false;
  #done = false;
  #pending = 0;
  #wake: (() => void) | undefined;
  #controller!: ReadableStreamDefaultController<Uint8Array>;

  constructor(readonly t: StreamsTransport, readonly id: string, readonly finish: () => void) {
    // A high-water mark of 0: `pull` runs only while a read waits, so a piece is acknowledged when it is read.
    this.stream = new ReadableStream<Uint8Array>({
      start: (c) => void (this.#controller = c),
      pull: async (c) => {
        for (;;) {
          if (this.#done) return;
          const piece = this.#queue.shift();
          if (piece !== undefined) {
            c.enqueue(piece);
            this.#read(piece.length);
            return;
          }
          if (this.#ended) {
            this.#done = true;
            c.close();
            this.finish();
            return;
          }
          await new Promise<void>((resolve) => (this.#wake = resolve));
          this.#wake = undefined;
        }
      },
      cancel: async (reason) => {
        if (this.#done) return;
        this.#done = true;
        this.#queue.length = 0;
        // Cancelled first, then the watch's end (the daemon would hear the reader go).
        await this.t.call("streams.cancel", [this.id, reasonText(reason, "cancelled by the reader")]).catch(() => undefined);
        this.finish();
      },
    }, new CountQueuingStrategy({ highWaterMark: 0 }));
  }

  push(data: Uint8Array): void {
    if (this.#done || this.#ended) return;
    this.#queue.push(data);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  /** The daemon aborted it, or the watch ended: the stream errors with why. */
  abort(why: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#queue.length = 0;
    this.#controller.error(new Error(why));
    this.#wake?.();
    this.finish();
  }

  /** The reader cancelled from here (an abort signal): the daemon is told, the stream errors with why. */
  cancelNow(why: string): void {
    if (this.#done) return;
    void this.t.call("streams.cancel", [this.id, why]).catch(() => undefined);
    this.abort(why);
  }

  #read(n: number): void {
    this.#pending += n;
    if (this.#pending >= STREAM_ACK_BATCH || this.#queue.length === 0) {
      const bytes = this.#pending;
      this.#pending = 0;
      if (!this.#ended) void this.t.call("streams.ack", [this.id, bytes]).catch(() => undefined);
    }
  }
}

/** `streams.accept`: `onStream` is given each stream opened to `name`. */
export function acceptStreams(t: StreamsTransport, name: string, onStream: (stream: ReadableStream<Uint8Array>, meta: StreamMeta) => void): StreamsAcceptHandle {
  const open = new Map<string, Incoming>();
  let stopped = false;
  const listener = (raw: unknown) => {
    const e = raw as StreamReadEvent;
    if (e.type === "opened") {
      if (typeof e.id !== "string" || open.has(e.id)) return;
      const incoming = new Incoming(t, e.id, () => void open.delete(e.id));
      open.set(e.id, incoming);
      try {
        onStream(incoming.stream, e.meta ?? {});
      } catch {
        // the plugin's own callback
      }
      return;
    }
    const s = open.get(e.id);
    if (s === undefined) return;
    if (e.type === "chunk") s.push(e.data);
    else if (e.type === "end") s.end();
    else if (e.type === "aborted") s.abort(reasonText(e.reason, "the stream was aborted"));
  };
  const watch = t.watch("streams.accept", [name, listener], 1);
  // A refusal rejects `opened` for whoever awaits it; one nobody awaits is an unhandled rejection, which a plugin's log
  // names by the call (the watch's own promise is handled here, so that line comes once).
  const opened = watch.opened.then(() => undefined);
  watch.opened.catch(() => undefined);
  const closeAll = (why: string) => {
    for (const s of [...open.values()]) s.abort(why);
  };
  void watch.opened.then(() => watch.ended.then((why) => {
    stopped = true;
    closeAll(`the acceptor's watch ended: ${why}`);
  }), () => undefined);
  return Object.assign(() => {
    if (stopped) return;
    stopped = true;
    watch.stop();
    closeAll("this half stopped accepting");
  }, { opened });
}

/** `points.stream`: the readable end of the stream a point handler answers with. */
export function pointStream(
  t: StreamsTransport,
  point: string,
  entry: unknown,
  field: string,
  args: unknown,
  options?: { method?: string; timeoutMs?: number; signal?: AbortSignal },
  onEvent?: (event: StreamReadEvent) => void,
): Promise<ReadableStream<Uint8Array>> {
  const wire = { ...(options?.method !== undefined ? { method: options.method } : {}), ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) };
  return readableWatch(t, "points.stream", [point, entry, field, args ?? null, wire, undefined], 5, options?.signal, onEvent);
}

/** `pictures.open`: the readable end of a live picture's frames (each a 4-byte big-endian length and one image), latest
 *  frames only: a reader that falls behind skips frames, never queues them. */
export function openPicture(t: StreamsTransport, picture: string, options?: { maxFps?: number; signal?: AbortSignal }, onEvent?: (event: StreamReadEvent) => void): Promise<ReadableStream<Uint8Array>> {
  const wire = options?.maxFps !== undefined ? { maxFps: options.maxFps } : {};
  return readableWatch(t, "pictures.open", [picture, wire, undefined], 2, options?.signal, onEvent);
}

/** A stream's readable end made from a watch at `path`: `args[at]` is where the listener goes. */
function readableWatch(t: StreamsTransport, path: string, args: unknown[], at: number, signal: AbortSignal | undefined, onEvent?: (event: StreamReadEvent) => void): Promise<ReadableStream<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let incoming: Incoming | undefined;
    let over = false;
    let watch: ReturnType<StreamsTransport["watch"]> | undefined;
    const release = () => signal?.removeEventListener("abort", onAbort);
    const finish = () => {
      over = true;
      release();
      watch?.stop();
    };
    const onAbort = () => {
      if (over) return;
      const why = reasonText(signal?.reason, "aborted");
      if (incoming !== undefined) incoming.cancelNow(why);
      else {
        finish();
        reject(new Error(why));
      }
    };
    const listener = (raw: unknown) => {
      const e = raw as StreamReadEvent;
      if (e.type === "opened" && incoming === undefined && typeof e.id === "string") {
        incoming = new Incoming(t, e.id, finish);
        resolve(incoming.stream);
      } else if (incoming === undefined) {
        if (e.type === "aborted") {
          finish();
          reject(new Error(reasonText(e.reason, "the stream was aborted")));
        }
      } else if (e.type === "chunk") incoming.push(e.data);
      else if (e.type === "end") {
        // Everything is in the queue: the watch has nothing more to say.
        incoming.end();
        over = true;
        release();
        watch?.stop();
      } else if (e.type === "aborted") incoming.abort(reasonText(e.reason, "the stream was aborted"));
      try {
        onEvent?.(e);
      } catch {
        // the plugin's own listener
      }
    };
    if (signal?.aborted) return reject(new Error(reasonText(signal.reason, "aborted")));
    signal?.addEventListener("abort", onAbort);
    watch = t.watch(path, args.map((a, i) => (i === at ? listener : a)), at);
    watch.opened.catch((err: unknown) => {
      if (over) return;
      over = true;
      release();
      if (incoming === undefined) reject(err);
      else incoming.abort(reasonText(err, "the stream's watch failed"));
    });
    void watch.opened.then(() => watch!.ended.then((why) => {
      if (over) return;
      over = true;
      release();
      if (incoming === undefined) reject(new Error(`the stream's watch ended: ${why}`));
      else incoming.abort(`the stream's watch ended: ${why}`);
    }), () => undefined);
  });
}
