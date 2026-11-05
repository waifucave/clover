// The wire over the link sidecar (`native/link`, iroh 1.4.1; spike S1 chose a sidecar over a napi binding): one
// process per device, spoken to over its stdin and stdout in length-prefixed frames, a type byte first (`0` JSON
// control, `1` stream bytes with a u64 stream id). The device's seed goes over stdin in the first frame, never in
// arguments, the environment or a file.
//
// Hooks for the other lanes: `spawn` is where lane C's fence wraps the process (it needs UDP and its pipes, nothing
// else), and `binary` is the signed one lane M ships beside the core. Writes resolve once the bytes are in the pipe;
// the sidecar queues them per stream in order (backpressure from QUIC's flow control back to the core is a follow-up).
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import { type Bytes, concat, fromBase64, fromUtf8, own, toHex, u32, utf8 } from "../identity/bytes";
import type { DeviceKey } from "../identity/device-key";
import type { NatMapping } from "./dial-policy";
import { FrameReader, MAX_FRAME } from "./frames";
import {
  ALPN_LINK, ALPN_PAIR, CLOSE_NORMAL, RESET_CONN_LOST,
  type DialOptions, type DialTarget, type PathInfo, type WireClose, type WireConn, type WireEndpoint, type WireStream, WireOffline,
} from "./wire";

const T_JSON = 0;
const T_DATA = 1;

/** The process the wire talks to: what `Bun.spawn` gives, narrowed to what's used. */
export interface SidecarProcess {
  write(bytes: Uint8Array): void;
  readonly stdout: ReadableStream<Uint8Array>;
  kill(): void;
  readonly exited: Promise<number>;
}

export interface SidecarWireOptions {
  binary: string;
  key: DeviceKey;
  /** `default` (n0's relays, with QUIC address discovery), `disabled`, or a relay's URL. */
  relay?: string;
  /** Publish to n0's address lookup (the relay URL only): only for a device without an account (item 81). */
  n0Lookup: boolean;
  /** `ip:port` to bind instead of every interface (tests bind loopback). */
  bind?: string;
  alpns?: readonly string[];
  /** Lane C's fence wraps the spawn here. */
  spawn?(argv: readonly string[]): SidecarProcess;
  /** The sidecar's own diagnostics (never a secret: it never prints the key). */
  onLog?(line: string): void;
}

function defaultSpawn(argv: readonly string[]): SidecarProcess {
  const p = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  return {
    write: (b) => {
      p.stdin.write(b);
      void p.stdin.flush();
    },
    stdout: p.stdout,
    kill: () => p.kill(),
    exited: p.exited,
  };
}

export class SidecarWire implements WireEndpoint {
  readonly publicKey: Bytes;
  readonly relay: string | undefined;
  readonly #proc: SidecarProcess;
  readonly #acceptors = new Map<string, (conn: WireConn) => void>();
  readonly #conns = new Map<number, SidecarConn>();
  readonly #streams = new Map<number, SidecarStream>();
  readonly #dials = new Map<number, { key: string; alpn: string; resolve(c: WireConn): void; reject(e: Error): void }>();
  readonly #reports = new Map<number, (r: { mapping: NatMapping; globalV4?: string; relay?: string; direct: string[] }) => void>();
  #nextReq = 1;
  #nextStream = 2;
  #closed = false;

  private constructor(proc: SidecarProcess, ready: { publicKey: string; relay?: string | null }) {
    this.#proc = proc;
    this.publicKey = own(Uint8Array.from(Buffer.from(ready.publicKey, "hex")));
    this.relay = ready.relay ?? undefined;
  }

  static async start(o: SidecarWireOptions): Promise<SidecarWire> {
    const proc = (o.spawn ?? defaultSpawn)([o.binary]);
    const seed = fromBase64(o.key.seed().reveal());
    if (!seed) throw new ContractError("invalid", "the device key's seed is unreadable");
    send(proc, { op: "init", seed: toHex(seed), alpns: [...(o.alpns ?? [ALPN_LINK, ALPN_PAIR])], relay: o.relay ?? "default", n0Lookup: o.n0Lookup, ...(o.bind ? { bind: o.bind } : {}) });
    seed.fill(0);
    let wire: SidecarWire | undefined;
    const ready = new Promise<{ publicKey: string; relay?: string | null }>((resolve, reject) => {
      void (async () => {
        const reader = new FrameReader(MAX_FRAME + 16);
        try {
          for await (const chunk of proc.stdout) {
            for (const f of reader.push(chunk)) {
              if (wire) wire.#frame(f);
              else if (f[0] === T_JSON) {
                const m = JSON.parse(fromUtf8(f.subarray(1))) as Record<string, unknown>;
                if (m.ev === "ready") resolve(m as { publicKey: string; relay?: string | null });
                else if (m.ev === "error") reject(new ContractError("failed", `the link sidecar didn't start: ${String(m.message)}`));
              }
            }
          }
        } catch {
          // the pipe broke: handled below
        }
        reject(new ContractError("closed", "the link sidecar exited"));
        if (wire) wire.#gone();
      })();
    });
    const r = await ready;
    if (r.publicKey !== toHex(o.key.publicKey)) {
      proc.kill();
      throw new ContractError("failed", "the link sidecar runs under another key");
    }
    wire = new SidecarWire(proc, r);
    return wire;
  }

  async dial(target: DialTarget, opts: DialOptions): Promise<WireConn> {
    if (this.#closed) throw new WireOffline("this endpoint is closed");
    if (opts.signal?.aborted) throw new WireOffline("the dial was cancelled");
    const id = this.#nextReq++;
    const done = new Promise<WireConn>((resolve, reject) => this.#dials.set(id, { key: toHex(target.key), alpn: opts.alpn, resolve, reject }));
    this.#send({
      op: "dial", id, key: toHex(target.key), alpn: opts.alpn, lan: target.lan ?? [], direct: target.direct ?? [],
      relay: target.relay ?? null, directOnly: opts.directOnly === true, timeoutMs: opts.timeoutMs ?? 10_000,
    });
    opts.signal?.addEventListener("abort", () => {
      const d = this.#dials.get(id);
      this.#dials.delete(id);
      d?.reject(new WireOffline("the dial was cancelled"));
    }, { once: true });
    return done;
  }

  onIncoming(alpn: string, fn: (conn: WireConn) => void): Unsubscribe {
    this.#acceptors.set(alpn, fn);
    return () => {
      if (this.#acceptors.get(alpn) === fn) this.#acceptors.delete(alpn);
    };
  }

  /** The keys whose link connections the sidecar takes at all; the transport checks the registry again. */
  allow(keys: readonly Uint8Array[]): void {
    this.#send({ op: "allow", keys: keys.map(toHex) });
  }

  networkChanged(): void {
    this.#send({ op: "networkChanged" });
  }

  /** The two-STUN mapping check (iroh's net report over QUIC address discovery), and this endpoint's addresses. */
  netReport(): Promise<{ mapping: NatMapping; globalV4?: string; relay?: string; direct: string[] }> {
    const id = this.#nextReq++;
    const p = new Promise<{ mapping: NatMapping; globalV4?: string; relay?: string; direct: string[] }>((resolve) => this.#reports.set(id, resolve));
    this.#send({ op: "netReport", id });
    return p;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#send({ op: "shutdown" });
    const exited = await Promise.race([this.#proc.exited.then(() => true), Bun.sleep(4000).then(() => false)]);
    if (!exited) this.#proc.kill();
    this.#gone();
  }

  // ---- for the conns and streams ----

  /** @internal */
  sendJson(m: Record<string, unknown>): void {
    this.#send(m);
  }

  /** @internal */
  sendData(stream: number, chunk: Uint8Array): void {
    if (this.#closed) throw new WireOffline("the link sidecar is gone");
    const head = new Uint8Array(9);
    head[0] = T_DATA;
    new DataView(head.buffer).setBigUint64(1, BigInt(stream), false);
    const body = concat(head, chunk);
    this.#proc.write(concat(u32(body.byteLength), body));
  }

  /** @internal */
  newStream(conn: SidecarConn, priority: number): SidecarStream {
    const id = this.#nextStream;
    this.#nextStream += 2;
    const s = new SidecarStream(this, id, priority);
    this.#streams.set(id, s);
    this.#send({ op: "open", conn: conn.num, stream: id, priority });
    return s;
  }

  /** @internal */
  forget(stream: number): void {
    this.#streams.delete(stream);
  }

  #send(m: Record<string, unknown>): void {
    if (this.#closed) return;
    send(this.#proc, m);
  }

  #frame(f: Uint8Array): void {
    if (f[0] === T_DATA && f.byteLength >= 9) {
      const id = Number(new DataView(f.buffer, f.byteOffset + 1, 8).getBigUint64(0, false));
      this.#streams.get(id)?.receive(f.slice(9));
      return;
    }
    if (f[0] !== T_JSON) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(fromUtf8(f.subarray(1))) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (m.ev) {
      case "dialed": {
        const d = this.#dials.get(m.id as number);
        this.#dials.delete(m.id as number);
        if (!d) {
          this.#send({ op: "close", conn: m.conn, code: CLOSE_NORMAL, reason: "the dial was cancelled" });
          return;
        }
        d.resolve(this.#adopt(m.conn as number, true, d.key, d.alpn, m.path as PathInfo));
        return;
      }
      case "dialFailed": {
        const d = this.#dials.get(m.id as number);
        this.#dials.delete(m.id as number);
        d?.reject(new WireOffline(String(m.error ?? "the peer can't be reached")));
        return;
      }
      case "incoming": {
        const conn = this.#adopt(m.conn as number, false, m.peerKey as string, m.alpn as string, m.path as PathInfo);
        const accept = this.#acceptors.get(conn.alpn);
        if (accept) accept(conn);
        else conn.close(CLOSE_NORMAL, "no one takes this protocol");
        return;
      }
      case "stream": {
        const conn = this.#conns.get(m.conn as number);
        const s = new SidecarStream(this, m.stream as number, 0);
        this.#streams.set(s.num, s);
        conn?.incoming(s);
        return;
      }
      case "fin":
        this.#streams.get(m.stream as number)?.receiveFin();
        return;
      case "reset":
        this.#streams.get(m.stream as number)?.receiveReset(m.code as number);
        return;
      case "path":
        this.#conns.get(m.conn as number)?.pathChanged(m.path as PathInfo);
        return;
      case "closed": {
        const conn = this.#conns.get(m.conn as number);
        this.#conns.delete(m.conn as number);
        conn?.end({ code: m.code as number, reason: String(m.reason ?? ""), local: m.local === true });
        return;
      }
      case "netReport": {
        const r = this.#reports.get(m.id as number);
        this.#reports.delete(m.id as number);
        r?.({
          mapping: (m.mapping as NatMapping) ?? "unknown", direct: (m.direct as string[]) ?? [],
          ...(typeof m.globalV4 === "string" ? { globalV4: m.globalV4 } : {}), ...(typeof m.relay === "string" ? { relay: m.relay } : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  #adopt(num: number, outbound: boolean, peerKey: string, alpn: string, path: PathInfo): SidecarConn {
    const known = this.#conns.get(num);
    if (known) return known;
    const conn = new SidecarConn(this, num, own(Uint8Array.from(Buffer.from(peerKey, "hex"))), alpn, outbound, path);
    this.#conns.set(num, conn);
    return conn;
  }

  #gone(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const d of this.#dials.values()) d.reject(new WireOffline("the link sidecar is gone"));
    this.#dials.clear();
    for (const s of this.#streams.values()) s.receiveReset(RESET_CONN_LOST);
    for (const c of this.#conns.values()) c.end({ code: 5, reason: "the link sidecar is gone", local: true });
    this.#conns.clear();
  }
}

/** Keeps the sidecar's allow list to the registry's paired, unrevoked devices, so a link connection from any other
 *  key is closed before the core sees it (the transport checks again). Returns the unsubscribe. */
export function followRegistry(
  wire: Pick<SidecarWire, "allow">,
  registry: { self(): { id: string }; list(): { id: string; publicKey: string }[]; watch(fn: () => void): Unsubscribe },
): Unsubscribe {
  const sync = () => {
    const self = registry.self().id;
    const keys = registry.list().filter((d) => d.id !== self).map((d) => fromBase64(d.publicKey)).filter((k): k is Bytes => k !== null && k.length === 32);
    wire.allow(keys);
  };
  sync();
  return registry.watch(sync);
}

function send(proc: SidecarProcess, m: Record<string, unknown>): void {
  const body = concat(Uint8Array.of(T_JSON), utf8(JSON.stringify(m)));
  proc.write(concat(u32(body.byteLength), body));
}

class SidecarConn implements WireConn {
  readonly id: string;
  readonly num: number;
  readonly peerKey: Bytes;
  readonly alpn: string;
  readonly outbound: boolean;
  readonly closed: Promise<WireClose>;
  readonly #wire: SidecarWire;
  readonly #paths = new Listeners<PathInfo>();
  readonly #streams = new Listeners<WireStream>();
  readonly #pending: WireStream[] = [];
  #path: PathInfo;
  #resolveClosed!: (c: WireClose) => void;
  #ended = false;

  constructor(wire: SidecarWire, num: number, peerKey: Bytes, alpn: string, outbound: boolean, path: PathInfo) {
    this.#wire = wire;
    this.num = num;
    this.id = `sc${num}`;
    this.peerKey = peerKey;
    this.alpn = alpn;
    this.outbound = outbound;
    this.#path = path ?? { kind: "relay" };
    this.closed = new Promise((r) => (this.#resolveClosed = r));
  }

  path(): PathInfo {
    return { ...this.#path };
  }

  onPath(fn: (p: PathInfo) => void): Unsubscribe {
    return this.#paths.add(fn);
  }

  openStream(priority: number): WireStream {
    if (this.#ended) {
      const s = new SidecarStream(this.#wire, -1, priority);
      s.receiveReset(RESET_CONN_LOST);
      return s;
    }
    return this.#wire.newStream(this, priority);
  }

  onStream(fn: (s: WireStream) => void): Unsubscribe {
    const off = this.#streams.add(fn);
    for (const s of this.#pending.splice(0)) fn(s);
    return off;
  }

  close(code: number, reason: string): void {
    if (this.#ended) return;
    this.#wire.sendJson({ op: "close", conn: this.num, code, reason });
  }

  /** @internal */
  incoming(s: WireStream): void {
    if (this.#streams.size === 0) this.#pending.push(s);
    else this.#streams.emit(s);
  }

  /** @internal */
  pathChanged(p: PathInfo): void {
    this.#path = p;
    this.#paths.emit(p);
  }

  /** @internal */
  end(c: WireClose): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#resolveClosed(c);
  }
}

class SidecarStream implements WireStream {
  readonly priority: number;
  readonly num: number;
  readonly #wire: SidecarWire;
  readonly #data = new Listeners<Uint8Array>();
  readonly #fin = new Listeners<void>();
  readonly #reset = new Listeners<number>();
  readonly #buffered: Uint8Array[] = [];
  #finished = false;
  #gotFin = false;
  #finDelivered = false;
  #resetCode: number | undefined;

  constructor(wire: SidecarWire, num: number, priority: number) {
    this.#wire = wire;
    this.num = num;
    this.priority = priority;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#resetCode !== undefined) throw new WireOffline(this.#resetCode === RESET_CONN_LOST ? "the connection was lost" : "the stream was reset");
    if (this.#finished) throw new Error("the stream is finished");
    this.#wire.sendData(this.num, chunk);
  }

  finish(): void {
    if (this.#finished || this.#resetCode !== undefined) return;
    this.#finished = true;
    this.#wire.sendJson({ op: "finish", stream: this.num });
  }

  reset(code: number): void {
    if (this.#resetCode !== undefined) return;
    this.#resetCode = code;
    this.#buffered.length = 0;
    this.#wire.sendJson({ op: "reset", stream: this.num, code });
    this.#wire.forget(this.num);
  }

  onData(fn: (chunk: Uint8Array) => void): Unsubscribe {
    const off = this.#data.add(fn);
    for (const c of this.#buffered.splice(0)) fn(c);
    this.#maybeFin();
    return off;
  }

  onFin(fn: () => void): Unsubscribe {
    if (this.#finDelivered) queueMicrotask(fn);
    return this.#fin.add(fn);
  }

  onReset(fn: (code: number) => void): Unsubscribe {
    if (this.#resetCode !== undefined) {
      const code = this.#resetCode;
      queueMicrotask(() => fn(code));
    }
    return this.#reset.add(fn);
  }

  /** @internal */
  receive(chunk: Uint8Array): void {
    if (this.#resetCode !== undefined) return;
    if (this.#data.size === 0) this.#buffered.push(chunk);
    else this.#data.emit(chunk);
  }

  /** @internal */
  receiveFin(): void {
    if (this.#gotFin || this.#resetCode !== undefined) return;
    this.#gotFin = true;
    this.#maybeFin();
  }

  /** @internal */
  receiveReset(code: number): void {
    if (this.#resetCode !== undefined) return;
    this.#resetCode = code;
    this.#buffered.length = 0;
    this.#wire.forget(this.num);
    this.#reset.emit(code);
  }

  #maybeFin(): void {
    if (!this.#gotFin || this.#finDelivered || this.#buffered.length > 0 || this.#resetCode !== undefined) return;
    this.#finDelivered = true;
    this.#wire.forget(this.num);
    this.#fin.emit();
  }
}
