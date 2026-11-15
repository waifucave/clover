// The link between the daemon and a plugin-host process (spec §5.2; the protocol's `pluginHost.*` channel): requests
// with answers, and notifications, in both directions. A failure crosses as the contract's error
// (`ContractError.toJSON`), never as a stack, so no path or secret rides on it.
//
// `loopbackPeers` joins two ends in one process, copying every message (structured clone, as a pipe would) and
// delivering it on a microtask: the conformance harness runs the real daemon side against the real host side through
// it. The process's own pipe (NDJSON JSON-RPC over the stdio it was started with) is `streamPeer`.
import { writeSync } from "node:fs";
import { ContractError } from "../contracts/common";

export type RpcHandler = (params: any) => unknown;

export interface RpcPeer {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  /** Answers `method`, a request or a notification, from the other end. */
  handle(method: string, fn: RpcHandler): void;
  onClose(fn: () => void): void;
  close(): void;
  readonly closed: boolean;
}

/** The wire form of a failure: the contract's error, or `failed` with the message. */
export function errorToWire(err: unknown): { code: string; message: string; detail?: Readonly<Record<string, unknown>> } {
  if (err instanceof ContractError) return err.toJSON();
  // A method handler's failure (`MethodError`) keeps the contract's code it was made from.
  const data = (err as { data?: { code?: unknown } } | null)?.data;
  if (err instanceof Error && typeof data?.code === "string") return { code: data.code, message: err.message };
  return { code: "failed", message: err instanceof Error ? err.message : String(err) };
}

type Message =
  | { kind: "request"; id: number; method: string; params: unknown }
  | { kind: "notify"; method: string; params: unknown }
  | { kind: "result"; id: number; result: unknown }
  | { kind: "error"; id: number; error: ReturnType<typeof errorToWire> };

/** One end of a link over a message carrier (`send` copies and delivers; `receive` is called with what arrives). */
class Peer implements RpcPeer {
  readonly #send: (m: Message) => void;
  readonly #handlers = new Map<string, RpcHandler>();
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  readonly #onClose: (() => void)[] = [];
  #next = 1;
  #closed = false;

  constructor(send: (m: Message) => void) {
    this.#send = send;
  }

  get closed(): boolean {
    return this.#closed;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new ContractError("closed", "the plugin host's link is closed"));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#send({ kind: "request", id, method, params });
      } catch (err) {
        this.#pending.delete(id);
        reject(err instanceof ContractError ? err : new ContractError("invalid", `the message can't be sent: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.#closed) this.#send({ kind: "notify", method, params });
  }

  handle(method: string, fn: RpcHandler): void {
    this.#handlers.set(method, fn);
  }

  onClose(fn: () => void): void {
    this.#onClose.push(fn);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(new ContractError("closed", "the plugin host's link closed"));
    this.#pending.clear();
    for (const fn of this.#onClose.splice(0)) fn();
  }

  receive(m: Message): void {
    if (this.#closed) return;
    if (m.kind === "result" || m.kind === "error") {
      const p = this.#pending.get(m.id);
      if (p === undefined) return;
      this.#pending.delete(m.id);
      if (m.kind === "result") p.resolve(m.result);
      else p.reject(ContractError.fromJSON(m.error));
      return;
    }
    const fn = this.#handlers.get(m.method);
    if (m.kind === "notify") {
      if (fn !== undefined) void Promise.resolve().then(() => fn(m.params)).catch(() => {});
      return;
    }
    if (fn === undefined) {
      this.#send({ kind: "error", id: m.id, error: { code: "not_found", message: `no method ${m.method}` } });
      return;
    }
    void (async () => {
      try {
        const result = await fn(m.params);
        if (!this.#closed) this.#send({ kind: "result", id: m.id, result });
      } catch (err) {
        if (!this.#closed) this.#send({ kind: "error", id: m.id, error: errorToWire(err) });
      }
    })();
  }
}

/** Two ends joined in one process; every message is copied and delivered on a microtask. */
export function loopbackPeers(): [RpcPeer, RpcPeer] {
  let a: Peer;
  let b: Peer;
  const carry = (to: () => Peer) => (m: Message) => {
    const copy = structuredClone(m);
    queueMicrotask(() => to().receive(copy));
  };
  a = new Peer(carry(() => b));
  b = new Peer(carry(() => a));
  a.onClose(() => b.close());
  b.onClose(() => a.close());
  return [a, b];
}

/** An end over a message port (a worker's `self`, or its `Worker` from the parent): structured clone carries the
 *  values, bytes included. */
export function portPeer(port: { postMessage(m: unknown): void; addEventListener(type: "message", fn: (e: { data: unknown }) => void): void }): RpcPeer {
  const peer = new Peer((m) => port.postMessage(m));
  port.addEventListener("message", (e) => {
    const m = e.data as Message;
    if (typeof m === "object" && m !== null && typeof (m as { kind?: unknown }).kind === "string") peer.receive(m);
  });
  return peer;
}

/** The longest line the daemon reads from a plugin-host process: a 16 MiB request body (`FETCH_LIMITS.bodyBytes`) as
 *  base64, with room for the rest of its message. A longer one ends the link, never buffered further: the daemon
 *  holds no more of what a process sends than this before it checks it. */
export const LINK_LINE_MAX = 24 * 1024 * 1024;

/** A line past the reader's limit: the link ends. */
export class LineTooLong extends Error {
  override readonly name = "LineTooLong";
}

/** The lines of a byte stream (a pipe's), as text. `max` (characters) ends the stream with `LineTooLong` when a line
 *  grows past it before its newline. */
export async function* linesOf(chunks: AsyncIterable<Uint8Array | string>, max = Number.POSITIVE_INFINITY): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  // The line still growing, as the pieces it came in: only each new chunk is searched for its newline, and the pieces
  // are joined once, when it ends (a long line costs its length, never its length times its chunks).
  const parts: string[] = [];
  let size = 0;
  const tooLong = () => new LineTooLong(`a line from the plugin host passed ${max} characters`);
  for await (const chunk of chunks) {
    let text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = text.indexOf("\n")) >= 0) {
      if (size + at > max) throw tooLong();
      parts.push(text.slice(0, at));
      yield parts.length === 1 ? parts[0]! : parts.join("");
      parts.length = 0;
      size = 0;
      text = text.slice(at + 1);
    }
    if (text !== "") {
      parts.push(text);
      size += text.length;
    }
    // What's left has no newline yet: a line still growing.
    if (size > max) throw tooLong();
  }
  if (parts.length > 0) yield parts.join("");
}

/** A link over a descriptor (a socket pair's end, possibly non-blocking): lines read through Bun's file stream, and
 *  writes queued in order, a would-block (EAGAIN) retried rather than lost. Both ends of the plugin host's fd 3 use it. */
export function fdLink(fd: number, maxLine?: number): { lines: AsyncIterable<string>; write(line: string): void } {
  const queue: Buffer[] = [];
  let draining = false;
  const drain = () => {
    if (draining) return;
    draining = true;
    const step = () => {
      while (queue.length > 0) {
        const head = queue[0]!;
        let n: number;
        try {
          n = writeSync(fd, head);
        } catch (err) {
          if ((err as { code?: string }).code === "EAGAIN") return void setTimeout(step, 1);
          queue.length = 0; // the other end is gone; the reader's close ends the link
          break;
        }
        if (n < head.length) queue[0] = head.subarray(n);
        else queue.shift();
      }
      draining = false;
    };
    step();
  };
  return {
    lines: linesOf(Bun.file(fd).stream() as unknown as AsyncIterable<Uint8Array>, maxLine),
    write(line) {
      queue.push(Buffer.from(line));
      drain();
    },
  };
}

/** An end over a line stream (NDJSON JSON-RPC 2.0): the plugin-host process's stdio. `write` takes one line. Values
 *  are JSON: bytes cross as `{ "$bytes": "<base64>" }`, restored on the other side.
 *
 *  `maxSend` (characters, the process's end: `LINK_LINE_MAX`) holds every line it writes to what the daemon's end
 *  reads, measured on the line itself, whatever its method or fields: one past it would end the link for every plugin
 *  of the process. Instead a request past it fails (its caller's call, `invalid`), an answer past it goes as an
 *  `invalid` error, and a notification past it is dropped (`dropped` is told). */
export function streamPeer(lines: AsyncIterable<string>, write: (line: string) => void, o: { maxSend?: number; dropped?: (why: string) => void } = {}): RpcPeer {
  const max = o.maxSend ?? Number.POSITIVE_INFINITY;
  const peer = new Peer((m) => {
    const line = encodeLine(m);
    if (line.length <= max) return void write(line);
    const why = `${m.kind === "request" || m.kind === "notify" ? m.method : "an answer"} was ${line.length} characters on the link, past its ${max}`;
    if (m.kind === "request") throw new ContractError("invalid", why);
    if (m.kind === "notify") return void o.dropped?.(why);
    write(encodeLine({ kind: "error", id: m.id, error: { code: "invalid", message: why } }));
  });
  void (async () => {
    try {
      for await (const line of lines) {
        if (line.trim() === "") continue;
        let m: Message;
        try {
          m = decodeLine(line);
        } catch {
          continue; // a line that isn't ours is dropped, never acted on
        }
        peer.receive(m);
      }
    } catch {
      // A read that fails ends the link as its end does: on Linux, a socket pair's end closed with bytes it never read
      // (a host process ended mid-call) answers the reader ECONNRESET, never an EOF. Left unhandled, it escaped as a
      // rejection nothing awaits.
    } finally {
      peer.close();
    }
  })();
  return peer;
}

function encodeLine(m: Message): string {
  const wire =
    m.kind === "request" ? { jsonrpc: "2.0", id: m.id, method: m.method, params: m.params }
    : m.kind === "notify" ? { jsonrpc: "2.0", method: m.method, params: m.params }
    : m.kind === "result" ? { jsonrpc: "2.0", id: m.id, result: m.result ?? null }
    : { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: m.error.message, data: m.error } };
  return JSON.stringify(wire, (_k, v) => (v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString("base64") } : v));
}

function decodeLine(line: string): Message {
  const w = JSON.parse(line, (_k, v) => (v !== null && typeof v === "object" && typeof v.$bytes === "string" && Object.keys(v).length === 1 ? new Uint8Array(Buffer.from(v.$bytes, "base64")) : v));
  if (typeof w !== "object" || w === null || w.jsonrpc !== "2.0") throw new Error("not JSON-RPC");
  if (typeof w.method === "string") return w.id === undefined ? { kind: "notify", method: w.method, params: w.params } : { kind: "request", id: w.id, method: w.method, params: w.params };
  if ("error" in w) return { kind: "error", id: w.id, error: w.error?.data ?? { code: "failed", message: String(w.error?.message ?? "failed") } };
  return { kind: "result", id: w.id, result: w.result };
}
