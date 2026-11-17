// Streams (spec §5.4 "Streams"): byte streams between a plugin's own two halves, and from a point handler to its caller,
// kept in the daemon so both ends see one stream.
//
// * A stream has one writer (its producer) and one reader (its consumer). Credit-based flow: the hub holds at most
//   STREAM_BUFFER_MAX bytes the reader hasn't been sent (a `write` resolves only when its bytes fit: that is the
//   back-pressure), sends pieces while the bytes the reader has been sent and not acknowledged stay under
//   STREAM_WINDOW_MAX, and the reader's `ack` says what it consumed. Pieces go in the order they were written.
// * Every endpoint is a watch: the opener's (`streams.open`), the acceptor's (`streams.accept`), a points stream's
//   caller. The watch ending (a frame gone, a host process exited, the app quit) ends the stream and the other end is
//   told once, with why; so is the plugin stopping, either end's cancel, and the daemon closing. A normal end is the
//   writer's `end`: the reader hears `end` after every piece, and what it acknowledges after that is nothing.
// * Who may do what is the endpoint's: only the writer's half writes or ends, only the reader's half acknowledges, either
//   cancels. A stream connects one plugin's own two halves (a host half and a component), or a points stream's caller
//   to the handler's host half (`openPoint`).
// * One log line per stream opened and per stream ended (its bytes and why); never one per piece.
import type { HostProcess } from "@waifucave/moss-protocol";
import { STREAM_ACCEPTORS_PER_PLUGIN, STREAM_BUFFER_MAX, STREAM_CHUNK_MAX, STREAM_META_MAX_BYTES, STREAM_NAME, STREAMS_OPEN_PER_PLUGIN, STREAM_WINDOW_MAX, type StreamMeta } from "@waifucave/moss-plugin-sdk";
import { randomUUID } from "node:crypto";
import { ContractError, type Unsubscribe } from "../contracts/common";

/** Where an endpoint is: a component ("ui"), a host half in a process the core started, or any host half of the plugin
 *  ("host": a points stream's writer is the contributor's handler, in whichever process it runs). */
export type StreamSide = HostProcess | "ui" | "host";

/** What an endpoint's listener hears: the reader, `opened`, `chunk`, `end` and `aborted`; the writer, `open` and
 *  `aborted`. */
export type StreamEvent =
  | { type: "open"; id: string }
  | { type: "opened"; id: string; meta: StreamMeta }
  | { type: "chunk"; id: string; data: Uint8Array }
  | { type: "end"; id: string }
  | { type: "aborted"; id: string; reason: string };

interface Endpoint {
  pluginId: string;
  side: StreamSide;
  listener?: (event: StreamEvent) => void;
}

interface Acceptor extends Endpoint {
  name: string;
  seq: number;
  listener: (event: StreamEvent) => void;
}

interface Stream {
  id: string;
  name: string;
  producer: Endpoint;
  consumer: Endpoint;
  buffer: Uint8Array[];
  buffered: number;
  inFlight: number;
  /** Bytes the writer has given the hub, and the reader has been sent. */
  written: number;
  sent: number;
  producerEnded: boolean;
  /** A points stream: it counts toward its reader's (the caller's) cap only. */
  point?: true;
  /** A stream into the engine (a tool's live picture): it counts toward its writer's cap only. */
  intoEngine?: true;
  writer?: { bytes: Uint8Array; resolve(): void; reject(err: unknown): void };
  openedAt: number;
  pumping: boolean;
  again: boolean;
}

export interface StreamHubOptions {
  log?(line: string): void;
  now?(): number;
}

/** The engine's own end of a stream (a live picture): it writes and acknowledges as this. */
export const ENGINE = { pluginId: "@engine", side: "moss" } as const;

const sideText = (s: StreamSide): string => (s === "ui" ? "a component" : s === "host" ? "its host half" : `its host half, process ${s}`);
const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

/** An endpoint's half as the caller says it: a call from a host half matches a "host" endpoint of any process. */
function same(e: Endpoint, who: { pluginId: string; side: HostProcess | "ui" }): boolean {
  return e.pluginId === who.pluginId && (e.side === "host" ? who.side !== "ui" : e.side === who.side);
}

export class StreamHub {
  readonly #o: StreamHubOptions;
  readonly #streams = new Map<string, Stream>();
  readonly #acceptors = new Map<string, Acceptor[]>();
  /** Why recently ended streams ended, for a write or end that comes after. */
  readonly #recent = new Map<string, string>();
  #seq = 0;

  constructor(o: StreamHubOptions = {}) {
    this.#o = o;
  }

  /** Registers this half as an acceptor of `name` for its plugin; `listener` hears each stream opened to it. The returned
   *  function stops accepting and aborts the streams it is reading. */
  accept(who: { pluginId: string; side: HostProcess | "ui" }, name: string, listener: (event: StreamEvent) => void): Unsubscribe {
    checkName(name);
    const mine = this.#acceptors.get(who.pluginId) ?? [];
    if (mine.length >= STREAM_ACCEPTORS_PER_PLUGIN) throw new ContractError("refused", `${who.pluginId} accepts ${STREAM_ACCEPTORS_PER_PLUGIN} streams, the most a plugin's halves may; stop one first`);
    const acceptor: Acceptor = { pluginId: who.pluginId, side: who.side, name, seq: ++this.#seq, listener };
    mine.push(acceptor);
    this.#acceptors.set(who.pluginId, mine);
    return () => {
      const list = this.#acceptors.get(who.pluginId);
      if (list !== undefined) {
        const at = list.indexOf(acceptor);
        if (at >= 0) list.splice(at, 1);
        if (list.length === 0) this.#acceptors.delete(who.pluginId);
      }
      for (const s of [...this.#streams.values()]) if (s.consumer === acceptor) this.#abort(s, "the reader went: it stopped accepting, or its watch ended", s.consumer);
    };
  }

  /** The writer's half opens `name` to one of its plugin's acceptors on the other side: the newest one registered (a
   *  reloaded frame's acceptor replaces the old one's). Refused with why when none. `listener` hears `open` and `aborted`.
   *  The returned function is the watch ending: it aborts the stream unless the writer had ended it. */
  open(who: { pluginId: string; side: HostProcess | "ui" }, name: string, meta: unknown, listener: (event: StreamEvent) => void): Unsubscribe {
    checkName(name);
    const metaOk = checkMeta(meta);
    const other = (a: Acceptor) => (who.side === "ui" ? a.side !== "ui" : a.side === "ui");
    const acceptor = (this.#acceptors.get(who.pluginId) ?? []).filter((a) => a.name === name && other(a)).sort((a, b) => b.seq - a.seq)[0];
    if (acceptor === undefined) {
      throw new ContractError("not_found", `${who.pluginId} has no ${who.side === "ui" ? "host half" : "component"} accepting a stream named "${name}" (the other half calls streams.accept("${name}", …) first)`);
    }
    const producer: Endpoint = { pluginId: who.pluginId, side: who.side, listener };
    const s = this.#create(name, producer, acceptor, metaOk);
    this.#tell(producer, { type: "open", id: s.id });
    return () => {
      if (!this.#streams.has(s.id) || s.producerEnded) return;
      this.#abort(s, "the writer went: its half's watch ended (a frame gone, its host process exited, or the app quit)", producer);
    };
  }

  /** A points stream (`points.stream`): the caller's watch is the reader; the writer is the contributor's handler, which
   *  writes through `streams.write` from any of its host halves. `onAbort` hears why the stream ended without the writer's
   *  `end` (the reader went or cancelled, the plugin stopped), so the handler's call can be cancelled. The returned
   *  function is the caller's watch ending. */
  openPoint(reader: { pluginId: string; side: HostProcess | "ui"; listener: (event: StreamEvent) => void }, writer: { pluginId: string; onAbort(reason: string): void }, name: string): { id: string; stop: Unsubscribe } {
    const consumer: Endpoint = { pluginId: reader.pluginId, side: reader.side, listener: reader.listener };
    const producer: Endpoint = { pluginId: writer.pluginId, side: "host", listener: (e) => void (e.type === "aborted" && writer.onAbort(e.reason)) };
    // It counts toward the caller's cap only: a caller can't fill a contributor's.
    const s = this.#create(name, producer, consumer, {}, true);
    return { id: s.id, stop: () => void this.#abort(s, "the reader went: its watch ended", consumer) };
  }

  /** A live picture's frames to a reader (`pictures.open`): the engine writes (through `write`, as `ENGINE`) and the
   *  caller's watch is the reader. Counts toward the caller's cap only. */
  openFromEngine(reader: { pluginId: string; side: HostProcess | "ui"; listener: (event: StreamEvent) => void }, name: string): { id: string; stop: Unsubscribe } {
    const consumer: Endpoint = { pluginId: reader.pluginId, side: reader.side, listener: reader.listener };
    const producer: Endpoint = { pluginId: ENGINE.pluginId, side: ENGINE.side };
    const s = this.#create(name, producer, consumer, {}, true);
    return { id: s.id, stop: () => void this.#abort(s, "the reader went: its watch ended", consumer) };
  }

  /** A live picture's frames from a publisher (`pictures.publish`): the caller's watch is the writer (its listener hears
   *  `open` and `aborted`), and the engine reads (`onEvent` hears `chunk`, `end`, `aborted`; it acknowledges with `ack`, as
   *  `ENGINE`). Counts toward the writer's cap only. The returned function is the writer's watch ending. */
  openIntoEngine(writer: { pluginId: string; side: HostProcess | "ui"; listener: (event: StreamEvent) => void }, name: string, onEvent: (event: StreamEvent) => void): { id: string; stop: Unsubscribe } {
    const producer: Endpoint = { pluginId: writer.pluginId, side: writer.side, listener: writer.listener };
    const consumer: Endpoint = { pluginId: ENGINE.pluginId, side: ENGINE.side, listener: onEvent };
    const s = this.#create(name, producer, consumer, {}, false, true);
    this.#tell(producer, { type: "open", id: s.id });
    return {
      id: s.id,
      stop: () => {
        if (!this.#streams.has(s.id) || s.producerEnded) return;
        this.#abort(s, "the writer went: its watch ended", producer);
      },
    };
  }

  /** The handler of a points stream finished without ending its stream, or failed: the stream is cancelled with why. */
  producerFinished(id: string, failure?: string): void {
    const s = this.#streams.get(id);
    if (s === undefined || s.producerEnded) return;
    this.#abort(s, failure ?? "the handler finished without ending its stream", s.producer);
  }

  /** Whether `id` is open (tests). */
  has(id: string): boolean {
    return this.#streams.has(id);
  }

  /** The writer gives a piece. Resolves once the hub has room for it (the back-pressure); rejects `cancelled` with why when
   *  the stream is over. One write at a time; a piece is at most STREAM_CHUNK_MAX. The hub keeps the array. */
  write(id: string, who: { pluginId: string; side: HostProcess | "ui" }, bytes: unknown): Promise<void> {
    const s = this.#owned(id, who, "producer", "writes");
    if (!(bytes instanceof Uint8Array)) throw new ContractError("invalid", "streams.write takes bytes (a Uint8Array)");
    if (bytes.length > STREAM_CHUNK_MAX) throw new ContractError("invalid", `a piece of a stream is at most ${STREAM_CHUNK_MAX} bytes (the SDK's writable cuts a bigger write); got ${bytes.length}`);
    if (s.producerEnded) throw new ContractError("refused", "the stream was ended; it takes no more");
    if (s.writer !== undefined) throw new ContractError("refused", "one write at a time: await the last one (a stream's writable does)");
    if (bytes.length === 0) return Promise.resolve();
    if (s.buffered + bytes.length <= STREAM_BUFFER_MAX) {
      this.#push(s, bytes);
      this.#pump(s);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      s.writer = { bytes, resolve, reject };
    });
  }

  /** The writer ends the stream: the reader hears `end` after the last piece. */
  end(id: string, who: { pluginId: string; side: HostProcess | "ui" }): void {
    const s = this.#owned(id, who, "producer", "ends");
    if (s.writer !== undefined) throw new ContractError("refused", "await the last write before ending the stream");
    s.producerEnded = true;
    this.#pump(s);
  }

  /** Either end cancels: the other is told `reason`. A stream already over is a no-op. */
  cancel(id: string, who: { pluginId: string; side: HostProcess | "ui" }, reason?: string): void {
    const s = this.#streams.get(id);
    if (s === undefined) return;
    const asProducer = same(s.producer, who);
    const asConsumer = same(s.consumer, who);
    if (!asProducer && !asConsumer) throw new ContractError("not_found", `no stream ${id} of ${who.pluginId}'s`);
    const by = asConsumer ? "reader" : "writer";
    const plain = reason === undefined ? "" : plainReason(reason);
    const why = `the ${by} cancelled${plain !== "" ? `: ${plain}` : ""}`;
    this.#abort(s, why, asConsumer ? s.consumer : s.producer);
  }

  /** The reader says it consumed `bytes` of what it was sent: more goes. An ack for a stream already over is a no-op. */
  ack(id: string, who: { pluginId: string; side: HostProcess | "ui" }, bytes: unknown): void {
    const s = this.#streams.get(id);
    if (s === undefined) return;
    if (!same(s.consumer, who)) throw new ContractError("refused", `only the reading end of stream ${id} acknowledges`);
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) throw new ContractError("invalid", "streams.ack takes a whole number of bytes above 0");
    s.inFlight = Math.max(0, s.inFlight - bytes);
    this.#pump(s);
  }

  /** A plugin stopped (turned off, removed, crashed): its streams end, from every side, or only from the halves `side`
   *  names (its host process's, when only that went). The other end is told. */
  endPlugin(pluginId: string, why: string, side?: (s: StreamSide) => boolean): void {
    const hit = (e: Endpoint) => e.pluginId === pluginId && (side === undefined || side(e.side));
    const mine = this.#acceptors.get(pluginId);
    if (mine !== undefined) {
      const keep = mine.filter((a) => !(side === undefined || side(a.side)));
      if (keep.length === 0) this.#acceptors.delete(pluginId);
      else this.#acceptors.set(pluginId, keep);
    }
    for (const s of [...this.#streams.values()]) {
      const lost = [...(hit(s.producer) ? ["writer"] : []), ...(hit(s.consumer) ? ["reader"] : [])];
      if (lost.length === 0) continue;
      this.#abort(s, `the ${lost.join(" and ")} went: ${why}`);
    }
  }

  /** The daemon closes: every stream ends. */
  close(): void {
    for (const s of [...this.#streams.values()]) this.#abort(s, "MOSS's plugins closed");
    this.#acceptors.clear();
  }

  /** Streams open, for tests and status. */
  get size(): number {
    return this.#streams.size;
  }

  /** Acceptors registered, for tests and status. */
  get acceptors(): number {
    return [...this.#acceptors.values()].reduce((n, l) => n + l.length, 0);
  }

  #create(name: string, producer: Endpoint, consumer: Endpoint, meta: StreamMeta, point = false, intoEngine = false): Stream {
    for (const pluginId of point ? [consumer.pluginId] : intoEngine ? [producer.pluginId] : [...new Set([producer.pluginId, consumer.pluginId])]) {
      let open = 0;
      for (const s of this.#streams.values()) if (chargedTo(s, pluginId)) open++;
      if (open >= STREAMS_OPEN_PER_PLUGIN) throw new ContractError("refused", `${pluginId} has ${STREAMS_OPEN_PER_PLUGIN} streams open, the most a plugin may; end one first`);
    }
    const s: Stream = {
      id: `strm_${randomUUID()}`, name, producer, consumer, buffer: [], buffered: 0, inFlight: 0, written: 0, sent: 0, producerEnded: false,
      openedAt: this.#now(), pumping: false, again: false, ...(point ? { point: true } : {}), ...(intoEngine ? { intoEngine: true } : {}),
    };
    this.#streams.set(s.id, s);
    this.#o.log?.(`streams: ${name} (${s.id.slice(5, 13)}) opened, ${producer.pluginId} (${sideText(producer.side)}) writing to ${consumer.pluginId} (${sideText(consumer.side)})`);
    this.#tell(consumer, { type: "opened", id: s.id, meta });
    return s;
  }

  /** The stream, when `who` is its `role`'s half; the stream's end, as a write after it hears, when it is over. */
  #owned(id: string, who: { pluginId: string; side: HostProcess | "ui" }, role: "producer" | "consumer", verb: string): Stream {
    const s = this.#streams.get(id);
    if (s === undefined) {
      const why = this.#recent.get(id);
      throw new ContractError(why === undefined ? "not_found" : "cancelled", why === undefined ? `no stream ${id} (it ended, or never was)` : `stream ${id} ended: ${why}`);
    }
    if (!same(s[role], who)) throw new ContractError("refused", `only the ${role === "producer" ? "writing" : "reading"} end of stream ${id} ${verb}`);
    return s;
  }

  #push(s: Stream, bytes: Uint8Array): void {
    s.buffer.push(bytes);
    s.buffered += bytes.length;
    s.written += bytes.length;
  }

  /** Sends the reader what the window allows, lets a waiting write in, and ends the stream once the writer ended it and
   *  every piece went. Not re-entered: a listener that acknowledges inside its own delivery is run after. */
  #pump(s: Stream): void {
    if (s.pumping) {
      s.again = true;
      return;
    }
    s.pumping = true;
    try {
      do {
        s.again = false;
        for (;;) {
          if (!this.#streams.has(s.id)) return;
          const head = s.buffer[0];
          if (head === undefined) break;
          if (s.inFlight > 0 && s.inFlight + head.length > STREAM_WINDOW_MAX) break;
          s.buffer.shift();
          s.buffered -= head.length;
          s.inFlight += head.length;
          s.sent += head.length;
          this.#tell(s.consumer, { type: "chunk", id: s.id, data: head });
        }
        if (!this.#streams.has(s.id)) return;
        const w = s.writer;
        if (w !== undefined && s.buffered + w.bytes.length <= STREAM_BUFFER_MAX) {
          s.writer = undefined;
          this.#push(s, w.bytes);
          w.resolve();
          s.again = true;
        }
      } while (s.again);
      if (s.producerEnded && s.buffer.length === 0 && this.#streams.has(s.id)) this.#finish(s);
    } finally {
      s.pumping = false;
    }
  }

  /** The writer ended it and the reader was sent everything: the reader hears `end`. */
  #finish(s: Stream): void {
    this.#streams.delete(s.id);
    this.#remember(s.id, "it ended");
    this.#o.log?.(`streams: ${s.name} (${s.id.slice(5, 13)}) ended by its writer (done): ${s.written} bytes in ${seconds(this.#now() - s.openedAt)}`);
    this.#tell(s.consumer, { type: "end", id: s.id });
  }

  /** The stream ends without the writer's say: the writer's pending write fails, and each end but `except` (the one that
   *  caused it, which knows) is told `reason`. */
  #abort(s: Stream, reason: string, except?: Endpoint): void {
    reason = plainReason(reason) || "ended";
    if (!this.#streams.delete(s.id)) return;
    this.#remember(s.id, reason);
    this.#o.log?.(`streams: ${s.name} (${s.id.slice(5, 13)}) ended (${reason}): ${s.written} bytes written, ${s.sent} sent, in ${seconds(this.#now() - s.openedAt)}`);
    const w = s.writer;
    s.writer = undefined;
    s.buffer.length = 0;
    w?.reject(new ContractError("cancelled", `the stream ended: ${reason}`));
    for (const e of [s.producer, s.consumer]) if (e !== except) this.#tell(e, { type: "aborted", id: s.id, reason });
  }

  #tell(e: Endpoint, event: StreamEvent): void {
    try {
      e.listener?.(event);
    } catch {
      // an end's listener is its own
    }
  }

  #remember(id: string, why: string): void {
    this.#recent.set(id, why);
    if (this.#recent.size > 256) this.#recent.delete(this.#recent.keys().next().value!);
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }
}

export function checkName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !STREAM_NAME.test(name)) throw new ContractError("invalid", "a stream's name is 1 to 128 characters: a letter or digit, then letters, digits and . _ / : -");
}

/** A stream's meta: plain JSON, at most STREAM_META_MAX_BYTES serialized. */
export function checkMeta(meta: unknown): StreamMeta {
  if (meta === undefined || meta === null) return {};
  if (typeof meta !== "object" || Array.isArray(meta)) throw new ContractError("invalid", "a stream's meta is an object of plain data");
  let text: string;
  try {
    text = JSON.stringify(meta);
  } catch {
    throw new ContractError("invalid", "a stream's meta is plain JSON data");
  }
  if (new TextEncoder().encode(text).length > STREAM_META_MAX_BYTES) throw new ContractError("invalid", `a stream's meta is at most ${STREAM_META_MAX_BYTES} bytes`);
  return JSON.parse(text) as StreamMeta;
}

/** The plugins a stream counts against: a points stream its caller (the reader) only; a plugin's own, its plugin. */
function chargedTo(s: { producer: { pluginId: string }; consumer: { pluginId: string }; point?: true; intoEngine?: true }, pluginId: string): boolean {
  if (s.intoEngine === true) return s.producer.pluginId === pluginId;
  return s.point === true ? s.consumer.pluginId === pluginId : s.producer.pluginId === pluginId || s.consumer.pluginId === pluginId;
}

/** A close or cancel reason as it may reach the log: control characters (C0, DEL, C1), line and paragraph separators and
 *  bidi overrides (U+202A to U+202E, U+2066 to U+2069) each run to one space, trimmed, at most 500 characters. */
export function plainReason(reason: string): string {
  // eslint-disable-next-line no-control-regex
  return reason.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").trim().slice(0, 500);
}
