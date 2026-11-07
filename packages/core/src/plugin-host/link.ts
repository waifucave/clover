// The link between the daemon and a plugin-host process (spec §5.2; the protocol's `pluginHost.*` channel): requests
// with answers, and notifications, in both directions. A failure crosses as the contract's error
// (`ContractError.toJSON`), never as a stack, so no path or secret rides on it.
//
// `loopbackPeers` joins two ends in one process, copying every message (structured clone, as a pipe would) and
// delivering it on a microtask: the conformance harness runs the real daemon side against the real host side through
// it. The process's own pipe (NDJSON JSON-RPC over the stdio it was started with) is `streamPeer`.
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

/** An end over a line stream (NDJSON JSON-RPC 2.0): the plugin-host process's stdio. `write` takes one line. Values
 *  are JSON: bytes cross as `{ "$bytes": "<base64>" }`, restored on the other side. */
export function streamPeer(lines: AsyncIterable<string>, write: (line: string) => void): RpcPeer {
  const peer = new Peer((m) => write(encodeLine(m)));
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
