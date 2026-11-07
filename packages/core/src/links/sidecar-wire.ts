// The wire over the link sidecar (`native/link`, iroh 1.4.1; spike S1 chose a sidecar over a napi binding): one
// process per device, spoken to over its stdin and stdout in length-prefixed frames, a type byte first (`0` JSON
// control, `1` stream bytes with a u64 stream id, `2` credit: a u64 stream id and a u32 byte count). The device's seed
// goes over stdin in the first frame, never in arguments, the environment or a file.
//
// Backpressure (S6.2 of H-M1's review): each stream has a window (`STREAM_WINDOW`) each way across the pipe.
// * A write resolves once its bytes are within the window: at most that much of a stream is sent to the sidecar and
//   not yet taken by QUIC, which the sidecar credits back (`2`) as QUIC takes it. So `await stream.write(chunk)` waits
//   while the peer's flow control, or a slow network, holds QUIC's send side.
// * The sidecar reads a stream from QUIC only while the core has credit for it: the window, then what the core
//   credits back as its listeners take the bytes. A listener may return a promise; the next chunk, and the credit,
//   wait for it, so a slow reader slows the sender instead of growing a buffer here.
//
// The sidecar restarts (§8.3, S6.1): if it exits, the same wire starts it again with backoff (0.5 s doubling to 30 s,
// from the first again after a healthy minute), with the same `init` (the seed over stdin again, the last allow list,
// the current n0 lookup). Its connections, streams and dials end offline, so the transport re-dials; dials made while
// it restarts wait for it (within their timeout); `onRestart` tells the daemon to read the net report again.
//
// Hooks for the other lanes: `spawn` is where lane C's fence wraps the process (it needs UDP and its pipes, nothing
// else; `spawnSidecar` is the plain spawn to wrap), and `binary` is the signed one lane M ships beside the core.
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import { type Bytes, concat, fromBase64, fromUtf8, own, toHex, utf8 } from "../identity/bytes";
import type { DeviceKey } from "../identity/device-key";
import type { NatMapping } from "./dial-policy";
import { FrameReader, MAX_FRAME } from "./frames";
import { bundledLinkBinary } from "./sidecar-binary";
import {
  ALPN_LINK, ALPN_PAIR, CLOSE_LOST, CLOSE_NORMAL, RESET_CONN_LOST, STREAM_WINDOW,
  type DialOptions, type DialTarget, type PathInfo, type WireClose, type WireConn, type WireEndpoint, type WireStream, WireOffline,
} from "./wire";

const T_JSON = 0;
const T_DATA = 1;
const T_CREDIT = 2;

/** What one stream may hold in flight across the pipe each way: written and not yet taken by QUIC, or read from QUIC
 *  and not yet taken by the core's reader. */
export { STREAM_WINDOW } from "./wire";
/** The smallest window a stream may be given; the sidecar holds the same floor. */
export const MIN_STREAM_WINDOW = 16 * 1024;
/** An incoming stream's window until its reader says otherwise (`setWindow`, once the transport read its header): a
 *  live stream's, so a live stream's first bytes don't run ahead before its header is read. A stream's reader that
 *  wants more widens it (the transport does for every stream it reads, by its priority). */
export const INCOMING_STREAM_WINDOW = 64 * 1024;
const clampWindow = (n: number): number => Math.max(MIN_STREAM_WINDOW, Math.min(STREAM_WINDOW, Math.floor(n)));
/** Writes go over in pieces of at most this, so credit comes back while a big write is still going. */
const PIECE = 256 * 1024;
/** The restart backoff (§8.3): doubling from half a second, at most 30 s. */
const RESTART_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 16000, 30000];
/** A sidecar that ran this long before it exited restarts from the first step again. */
const HEALTHY_MS = 60_000;

/** The process the wire talks to: what `Bun.spawn` gives, narrowed to what's used. */
export interface SidecarProcess {
  write(bytes: Uint8Array): void;
  readonly stdout: ReadableStream<Uint8Array>;
  kill(): void;
  readonly exited: Promise<number>;
  readonly pid?: number;
}

export interface SidecarWireOptions {
  /** The sidecar to run: by default the one shipped beside the daemon (`bundledLinkBinary`), never one from the PATH. */
  binary?: string;
  key: DeviceKey;
  /** `default` (n0's relays, with QUIC address discovery), `disabled`, or a relay's URL. */
  relay?: string;
  /** Publish to n0's address lookup (the relay URL only): only for a device without an account (item 81).
   *  `setN0Lookup` changes it while running. */
  n0Lookup: boolean;
  /** `ip:port` to bind instead of every interface (tests bind loopback). */
  bind?: string;
  /** The allow and revoked lists to start with (`allowListsOf(registry)`), so a paired computer that dials in at once
   *  isn't turned away as unpaired before `followRegistry`'s first `allow`. */
  allow?: { keys: readonly Uint8Array[]; revoked: readonly Uint8Array[] };
  alpns?: readonly string[];
  /** The congestion controller (§8.3): `bbr`, the default (quinn's BBR, its window sized to 1.25 times each path's
   *  bandwidth-delay product), or `cubic` (noq's own), for live gate 1 to compare. */
  congestion?: "bbr" | "cubic";
  /** Lane C's fence wraps the spawn here. */
  spawn?(argv: readonly string[]): SidecarProcess;
  /** The sidecar's own diagnostics, and the wire's restarts (never a secret: the key is never printed). */
  onLog?(line: string): void;
  /** For tests: the restart backoff, in ms. */
  restartBackoffMs?: readonly number[];
}

type NetReport = { mapping: NatMapping; globalV4?: string; relay?: string; direct: string[] };

/** What each side holds for the other (`SidecarWire.stats`): the bounds S6.2 keeps, and each path's congestion state. */
export interface SidecarStats {
  core: { streams: number; queuedWrites: number; unackedWrites: number; unconsumed: number };
  sidecar: {
    congestion: string; window: number; streams: number; queuedWrites: number; unconsumed: number; outBytes: number;
    quic: Record<string, number>;
    conns: { conn: number; paths: Record<string, unknown>[] }[];
  };
}

/** The sidecar's environment: only what the OS needs to give it a network (Winsock wants `SystemRoot`), never the
 *  daemon's own (its tokens, its paths). */
export function sidecarEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const keep = process.platform === "win32" ? ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"] : [];
  const out: Record<string, string> = {};
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k]!;
  out.RUST_LOG = env.CLOVER_LINK_LOG ?? "warn";
  return out;
}

/** Writes to a process's stdin and never throws or leaves a rejection unhandled: a pipe to a process that just died
 *  throws, or its write or its flush rejects (on Windows the write itself answers EPIPE later), and the exit is handled
 *  where stdout ends. */
export function pipeWriter(stdin: { write(b: Uint8Array): number | Promise<number>; flush(): number | Promise<number> }): (b: Uint8Array) => void {
  const quiet = (r: unknown) => {
    if (r instanceof Promise) r.catch(() => undefined);
  };
  return (b) => {
    try {
      quiet(stdin.write(b));
      quiet(stdin.flush());
    } catch {
      // gone
    }
  };
}

/** The plain spawn: the process with pipes and `sidecarEnv`. Lane C's fence wraps this. */
export function spawnSidecar(argv: readonly string[], onLog?: (line: string) => void): SidecarProcess {
  const p = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: onLog ? "pipe" : "ignore", env: sidecarEnv() });
  if (onLog && p.stderr) {
    // Its diagnostics, a line at a time (never a secret: it never prints the key).
    void (async () => {
      let rest = "";
      const decoder = new TextDecoder();
      try {
        for await (const chunk of p.stderr as ReadableStream<Uint8Array>) {
          rest += decoder.decode(chunk, { stream: true });
          const lines = rest.split("\n");
          rest = lines.pop() ?? "";
          for (const line of lines) if (line.trim()) onLog(line.slice(0, 2000));
        }
      } catch {
        // the pipe closed
      }
    })();
  }
  return {
    write: pipeWriter(p.stdin),
    stdout: p.stdout,
    kill: () => p.kill(),
    exited: p.exited,
    pid: p.pid,
  };
}

type Waiter = { resolve(): void; reject(e: Error): void };

export class SidecarWire implements WireEndpoint {
  readonly publicKey: Bytes;
  readonly #o: SidecarWireOptions;
  readonly #acceptors = new Map<string, (conn: WireConn) => void>();
  readonly #conns = new Map<number, SidecarConn>();
  readonly #streams = new Map<number, SidecarStream>();
  #streamWindows = false;
  readonly #dials = new Map<number, { key: string; alpn: string; resolve(c: WireConn): void; reject(e: Error): void }>();
  readonly #asks = new Map<number, { resolve(m: Record<string, unknown>): void; reject(e: Error): void }>();
  readonly #restarted = new Listeners<void>();
  /** Waiting for the sidecar to be up again (dials and reports made while it restarts). */
  readonly #waiters = new Set<Waiter>();
  #proc: SidecarProcess | undefined;
  /** Which process the conns and streams belong to: an object of an older one never reaches a newer one. */
  #gen = 0;
  #up = false;
  #upSince = 0;
  #relay: string | undefined;
  #n0Lookup: boolean;
  #allow: { keys: string[]; revoked: string[] } = { keys: [], revoked: [] };
  #attempt = 0;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #nextReq = 1;
  #nextStream = 2;
  #closed = false;

  private constructor(o: SidecarWireOptions) {
    this.#o = o;
    this.publicKey = own(Uint8Array.from(o.key.publicKey));
    this.#n0Lookup = o.n0Lookup;
    if (o.allow) this.#allow = { keys: o.allow.keys.map(toHex), revoked: o.allow.revoked.map(toHex) };
  }

  static async start(o: SidecarWireOptions): Promise<SidecarWire> {
    const wire = new SidecarWire(o);
    try {
      await wire.#launch();
    } catch (e) {
      // The first start fails loudly: the daemon can't run its links without it.
      wire.#closed = true;
      throw e;
    }
    return wire;
  }

  /** The relay this endpoint's last start reported. */
  get relay(): string | undefined {
    return this.#relay;
  }

  async dial(target: DialTarget, opts: DialOptions): Promise<WireConn> {
    if (this.#closed) throw new WireOffline("this endpoint is closed");
    if (opts.signal?.aborted) throw new WireOffline("the dial was cancelled");
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    // A sidecar that is restarting is waited for, within the dial's own time (and again, should it go once more).
    while (!this.#up) await this.#whenUp(deadline - Date.now(), opts.signal);
    const id = this.#nextReq++;
    const done = new Promise<WireConn>((resolve, reject) => this.#dials.set(id, { key: toHex(target.key), alpn: opts.alpn, resolve, reject }));
    this.#send({
      op: "dial", id, key: toHex(target.key), alpn: opts.alpn, lan: target.lan ?? [], direct: target.direct ?? [],
      relay: target.relay ?? null, directOnly: opts.directOnly === true, timeoutMs: Math.max(1, deadline - Date.now()),
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

  /** The keys whose link connections the sidecar lets through, and the revoked ones it closes as revoked. Until the
   *  first call, it lets none through; a restart starts with the last lists. */
  allow(keys: readonly Uint8Array[], revoked: readonly Uint8Array[] = []): void {
    this.#allow = { keys: keys.map(toHex), revoked: revoked.map(toHex) };
    if (this.#up) this.#send({ op: "allow", ...this.#allow });
  }

  /** Whether to publish to n0's address lookup (item 81: only a device without an account): the sidecar switches it
   *  while running, and a restart keeps it (m10 of H-M1's review). */
  setN0Lookup(on: boolean): void {
    if (this.#n0Lookup === on) return;
    this.#n0Lookup = on;
    if (this.#up) this.#send({ op: "n0Lookup", on });
  }

  get n0Lookup(): boolean {
    return this.#n0Lookup;
  }

  networkChanged(): void {
    if (this.#up) this.#send({ op: "networkChanged" });
  }

  /** The sidecar was started again after it exited (its port and addresses may have changed). */
  onRestart(fn: () => void): Unsubscribe {
    return this.#restarted.add(fn);
  }

  /** The two-STUN mapping check (iroh's net report over QUIC address discovery), and this endpoint's addresses. */
  async netReport(): Promise<NetReport> {
    const m = await this.#ask("netReport");
    return {
      mapping: (m.mapping as NatMapping) ?? "unknown", direct: (m.direct as string[]) ?? [],
      ...(typeof m.globalV4 === "string" ? { globalV4: m.globalV4 } : {}), ...(typeof m.relay === "string" ? { relay: m.relay } : {}),
    };
  }

  /** The net report once it lists a direct address: iroh learns its own just after it binds. Gives up after `ms`. */
  async settledReport(ms = 2000): Promise<NetReport> {
    const end = Date.now() + ms;
    for (;;) {
      const r = await this.netReport();
      if (r.direct.length > 0 || Date.now() >= end) return r;
      await Bun.sleep(25);
    }
  }

  /** What each side holds for the other, and each path's congestion state (diagnostics; the backpressure tests). */
  async stats(): Promise<SidecarStats> {
    const core = { streams: this.#streams.size, queuedWrites: 0, unackedWrites: 0, unconsumed: 0 };
    for (const s of this.#streams.values()) {
      core.queuedWrites += s.queuedBytes;
      core.unackedWrites += s.unackedBytes;
      core.unconsumed += s.unconsumedBytes;
    }
    const { ev: _ev, id: _id, ...sidecar } = await this.#ask("stats");
    return { core, sidecar: sidecar as SidecarStats["sidecar"] };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    for (const w of [...this.#waiters]) w.reject(new WireOffline("this endpoint is closed"));
    this.#waiters.clear();
    const proc = this.#proc;
    if (proc) {
      send(proc, { op: "shutdown" });
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(4000).then(() => false)]);
      if (!exited) proc.kill();
    }
    this.#up = false;
    this.#proc = undefined;
    this.#lost("the link sidecar is gone", true);
  }

  // ---- for the conns and streams ----

  /** @internal Which process objects made now belong to. */
  /** Whether this sidecar keeps a window per stream (its `ready` says so). */
  get streamWindows(): boolean {
    return this.#streamWindows;
  }

  get gen(): number {
    return this.#gen;
  }

  /** @internal */
  sendJson(m: Record<string, unknown>, gen: number): void {
    if (gen === this.#gen) this.#send(m);
  }

  /** @internal Stream bytes to the sidecar; false when the process they were for is gone. */
  sendData(stream: number, chunk: Uint8Array, gen: number): boolean {
    // Keyed on the process, not on `#up`: a stream may start in the same read as the process's `ready`.
    const proc = this.#proc;
    if (this.#closed || !proc || gen !== this.#gen) return false;
    const head = new Uint8Array(13);
    const v = new DataView(head.buffer);
    v.setUint32(0, 9 + chunk.byteLength, false);
    head[4] = T_DATA;
    v.setBigUint64(5, BigInt(stream), false);
    proc.write(concat(head, chunk));
    return true;
  }

  /** @internal The core's reader took `n` more bytes of a stream. */
  sendCredit(stream: number, n: number, gen: number): void {
    const proc = this.#proc;
    if (this.#closed || !proc || gen !== this.#gen) return;
    const f = new Uint8Array(17);
    const v = new DataView(f.buffer);
    v.setUint32(0, 13, false);
    f[4] = T_CREDIT;
    v.setBigUint64(5, BigInt(stream), false);
    v.setUint32(13, n, false);
    proc.write(f);
  }

  /** @internal */
  newStream(conn: SidecarConn, priority: number, window = STREAM_WINDOW): SidecarStream {
    const id = this.#nextStream;
    this.#nextStream += 2;
    const w = this.#streamWindows ? clampWindow(window) : STREAM_WINDOW;
    const s = new SidecarStream(this, id, priority, conn, conn.gen, w);
    this.#streams.set(id, s);
    conn.streams.add(s);
    this.sendJson({ op: "open", conn: conn.num, stream: id, priority, ...(w < STREAM_WINDOW ? { window: w } : {}) }, conn.gen);
    return s;
  }

  /** @internal */
  forget(stream: number): void {
    this.#streams.delete(stream);
  }

  // ---- the process ----

  /** Starts a sidecar process and waits for its `ready` under this device's key. */
  async #launch(): Promise<void> {
    const o = this.#o;
    const gen = ++this.#gen;
    const binary = o.binary ?? bundledLinkBinary();
    const proc = o.spawn ? o.spawn([binary]) : spawnSidecar([binary], o.onLog);
    this.#proc = proc;
    const ready = new Promise<{ publicKey: string; relay?: string | null }>((resolve, reject) => {
      void (async () => {
        const reader = new FrameReader(MAX_FRAME + 16);
        let started = false;
        try {
          for await (const chunk of proc.stdout) {
            for (const f of reader.push(chunk)) {
              if (started) {
                if (gen === this.#gen) this.#frame(f);
              } else if (f[0] === T_JSON) {
                const m = JSON.parse(fromUtf8(f.subarray(1))) as Record<string, unknown>;
                if (m.ev === "ready") {
                  started = true;
                  // A sidecar from before per-stream windows doesn't say it has them: then every stream keeps the
                  // wire's window, and no `window` op is sent (it would answer each with "unknown op").
                  this.#streamWindows = m.streamWindows === true;
                  resolve(m as { publicKey: string; relay?: string | null });
                } else if (m.ev === "error") reject(new ContractError("failed", `the link sidecar didn't start: ${String(m.message)}`));
              }
            }
          }
        } catch {
          // the pipe broke: handled below
        }
        reject(new ContractError("closed", "the link sidecar exited"));
        this.#exited(gen);
      })();
    });
    const seed = fromBase64(o.key.seed().reveal());
    if (!seed) {
      proc.kill();
      throw new ContractError("invalid", "the device key's seed is unreadable");
    }
    const sent = { allow: this.#allow, n0Lookup: this.#n0Lookup };
    send(proc, {
      op: "init", seed: toHex(seed), alpns: [...(o.alpns ?? [ALPN_LINK, ALPN_PAIR])], relay: o.relay ?? "default",
      n0Lookup: sent.n0Lookup, window: STREAM_WINDOW, incomingWindow: INCOMING_STREAM_WINDOW, ...(o.congestion ? { congestion: o.congestion } : {}),
      ...(o.bind ? { bind: o.bind } : {}), allow: sent.allow.keys, revoked: sent.allow.revoked,
    });
    seed.fill(0);
    let r: { publicKey: string; relay?: string | null };
    try {
      r = await ready;
    } catch (e) {
      proc.kill();
      throw e;
    }
    if (r.publicKey !== toHex(o.key.publicKey)) {
      proc.kill();
      throw new ContractError("failed", "the link sidecar runs under another key");
    }
    if (this.#closed || gen !== this.#gen) {
      proc.kill();
      throw new WireOffline("this endpoint is closed");
    }
    this.#relay = r.relay ?? undefined;
    this.#up = true;
    this.#upSince = Date.now();
    // What changed while it started.
    if (this.#allow !== sent.allow) this.#send({ op: "allow", ...this.#allow });
    if (this.#n0Lookup !== sent.n0Lookup) this.#send({ op: "n0Lookup", on: this.#n0Lookup });
    for (const w of [...this.#waiters]) w.resolve();
    this.#waiters.clear();
  }

  /** A process's stdout ended: it exited, or was killed. */
  #exited(gen: number): void {
    if (gen !== this.#gen) return;
    const wasUp = this.#up;
    this.#up = false;
    this.#proc = undefined;
    if (this.#closed) return;
    // Only a sidecar that was running restarts; the first start's failure is `start`'s to report.
    if (!wasUp && this.#upSince === 0) return;
    this.#lost("the link sidecar exited", false);
    if (wasUp && Date.now() - this.#upSince >= HEALTHY_MS) this.#attempt = 0;
    this.#scheduleRestart();
  }

  #scheduleRestart(): void {
    if (this.#closed || this.#restartTimer) return;
    const backoff = this.#o.restartBackoffMs ?? RESTART_BACKOFF_MS;
    const ms = backoff[Math.min(this.#attempt, backoff.length - 1)] ?? 30_000;
    this.#attempt++;
    this.#o.onLog?.(`the link sidecar exited; starting it again in ${ms} ms`);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      void this.#restart();
    }, ms);
  }

  async #restart(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#launch();
    } catch (e) {
      if (this.#closed) return;
      this.#o.onLog?.(`the link sidecar didn't start again: ${e instanceof Error ? e.message : String(e)}`);
      this.#up = false;
      this.#proc = undefined;
      this.#scheduleRestart();
      return;
    }
    this.#o.onLog?.("the link sidecar started again");
    this.#restarted.emit();
  }

  #whenUp(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.#up) return Promise.resolve();
    if (this.#closed) return Promise.reject(new WireOffline("this endpoint is closed"));
    return new Promise<void>((resolve, reject) => {
      const done = (fn: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#waiters.delete(w);
        fn();
      };
      const w: Waiter = { resolve: () => done(resolve), reject: (e) => done(() => reject(e)) };
      const onAbort = () => w.reject(new WireOffline("the dial was cancelled"));
      const timer = setTimeout(() => w.reject(new WireOffline("the link sidecar is restarting")), Math.max(0, ms));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.add(w);
    });
  }

  /** A request answered by id (`netReport`, `stats`), waiting for a restarting sidecar first. */
  async #ask(op: string): Promise<Record<string, unknown>> {
    if (this.#closed) throw new WireOffline("this endpoint is closed");
    const deadline = Date.now() + 10_000;
    while (!this.#up) await this.#whenUp(deadline - Date.now());
    const id = this.#nextReq++;
    const p = new Promise<Record<string, unknown>>((resolve, reject) => this.#asks.set(id, { resolve, reject }));
    this.#send({ op, id });
    return p;
  }

  /** Everything of the process that went: dials, requests, streams and connections, offline. */
  #lost(reason: string, local: boolean): void {
    for (const d of this.#dials.values()) d.reject(new WireOffline(reason));
    this.#dials.clear();
    for (const a of this.#asks.values()) a.reject(new WireOffline(reason));
    this.#asks.clear();
    for (const s of [...this.#streams.values()]) s.receiveReset(RESET_CONN_LOST);
    this.#streams.clear();
    for (const c of [...this.#conns.values()]) c.end({ code: CLOSE_LOST, reason, local });
    this.#conns.clear();
  }

  #send(m: Record<string, unknown>): void {
    if (this.#closed || !this.#proc) return;
    send(this.#proc, m);
  }

  #frame(f: Uint8Array): void {
    if (f[0] === T_DATA && f.byteLength >= 9) {
      const id = Number(new DataView(f.buffer, f.byteOffset + 1, 8).getBigUint64(0, false));
      // The reader gives each frame its own buffer, so the data can be handed on without a copy.
      this.#streams.get(id)?.receive(f.subarray(9));
      return;
    }
    if (f[0] === T_CREDIT && f.byteLength >= 13) {
      const v = new DataView(f.buffer, f.byteOffset + 1, 12);
      this.#streams.get(Number(v.getBigUint64(0, false)))?.acked(v.getUint32(8, false));
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
        if (!conn) {
          // A connection the core has let go (a cancelled dial's): its streams aren't taken.
          this.#send({ op: "reset", stream: m.stream, code: RESET_CONN_LOST });
          return;
        }
        const s = new SidecarStream(this, m.stream as number, 0, conn, conn.gen, this.#streamWindows ? INCOMING_STREAM_WINDOW : STREAM_WINDOW);
        this.#streams.set(s.num, s);
        conn.streams.add(s);
        conn.incoming(s);
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
      case "netReport":
      case "stats": {
        const a = this.#asks.get(m.id as number);
        this.#asks.delete(m.id as number);
        a?.resolve(m);
        return;
      }
      case "error":
        this.#o.onLog?.(`the link sidecar: ${String(m.message ?? "an error")}`.slice(0, 2000));
        return;
      default:
        return;
    }
  }

  #adopt(num: number, outbound: boolean, peerKey: string, alpn: string, path: PathInfo): SidecarConn {
    const known = this.#conns.get(num);
    if (known) return known;
    const conn = new SidecarConn(this, num, own(Uint8Array.from(Buffer.from(peerKey, "hex"))), alpn, outbound, path, this.#gen);
    this.#conns.set(num, conn);
    return conn;
  }
}

/** Keeps the sidecar's allow list to the registry's paired, unrevoked devices, so a link connection from any other
 *  key is closed before the core sees it (the transport checks again), and a revoked device's is closed as revoked, so
 *  it learns it and stops re-dialling. Returns the unsubscribe. */
export function followRegistry(wire: Pick<SidecarWire, "allow">, registry: AllowSource & { watch(fn: () => void): Unsubscribe }): Unsubscribe {
  const sync = () => {
    const l = allowListsOf(registry);
    wire.allow(l.keys, l.revoked);
  };
  sync();
  return registry.watch(sync);
}

type AllowSource = { self(): { id: string }; all(): { id: string; publicKey: string; revokedAt?: number }[] };

/** The registry's paired, unrevoked devices' keys, and its revoked ones'. */
export function allowListsOf(registry: AllowSource): { keys: Bytes[]; revoked: Bytes[] } {
  const self = registry.self().id;
  const key = (d: { publicKey: string }) => fromBase64(d.publicKey);
  const ok = (k: Bytes | null): k is Bytes => k !== null && k.length === 32;
  const devices = registry.all().filter((d) => d.id !== self);
  return { keys: devices.filter((d) => d.revokedAt === undefined).map(key).filter(ok), revoked: devices.filter((d) => d.revokedAt !== undefined).map(key).filter(ok) };
}

function send(proc: SidecarProcess, m: Record<string, unknown>): void {
  const body = utf8(JSON.stringify(m));
  const f = new Uint8Array(5 + body.byteLength);
  new DataView(f.buffer).setUint32(0, 1 + body.byteLength, false);
  f[4] = T_JSON;
  f.set(body, 5);
  proc.write(f);
}

class SidecarConn implements WireConn {
  readonly id: string;
  readonly num: number;
  readonly peerKey: Bytes;
  readonly alpn: string;
  readonly outbound: boolean;
  readonly closed: Promise<WireClose>;
  readonly gen: number;
  /** Its streams, which end with it. */
  readonly streams = new Set<SidecarStream>();
  readonly #wire: SidecarWire;
  readonly #paths = new Listeners<PathInfo>();
  readonly #streamListeners = new Listeners<WireStream>();
  readonly #pending: WireStream[] = [];
  #path: PathInfo;
  #resolveClosed!: (c: WireClose) => void;
  #ended = false;

  constructor(wire: SidecarWire, num: number, peerKey: Bytes, alpn: string, outbound: boolean, path: PathInfo, gen: number) {
    this.#wire = wire;
    this.num = num;
    this.gen = gen;
    this.id = `sc${gen}.${num}`;
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

  openStream(priority: number, opts: { window?: number } = {}): WireStream {
    if (this.#ended || this.gen !== this.#wire.gen) {
      const s = new SidecarStream(this.#wire, -1, priority, undefined, this.gen);
      s.receiveReset(RESET_CONN_LOST);
      return s;
    }
    return this.#wire.newStream(this, priority, opts.window);
  }

  onStream(fn: (s: WireStream) => void): Unsubscribe {
    const off = this.#streamListeners.add(fn);
    for (const s of this.#pending.splice(0)) fn(s);
    return off;
  }

  close(code: number, reason: string): void {
    if (this.#ended) return;
    this.#wire.sendJson({ op: "close", conn: this.num, code, reason }, this.gen);
  }

  /** @internal */
  incoming(s: WireStream): void {
    if (this.#streamListeners.size === 0) this.#pending.push(s);
    else this.#streamListeners.emit(s);
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
    for (const s of [...this.streams]) s.receiveReset(RESET_CONN_LOST);
    this.streams.clear();
    this.#resolveClosed(c);
  }
}

/** A write's piece waiting for the window; the last piece of each write settles it. */
type Piece = { bytes: Uint8Array; resolve?: () => void; reject?: (e: Error) => void };

class SidecarStream implements WireStream {
  readonly priority: number;
  readonly num: number;
  readonly #wire: SidecarWire;
  readonly #conn: SidecarConn | undefined;
  readonly #gen: number;
  readonly #data = new Set<(chunk: Uint8Array) => void | Promise<void>>();
  readonly #fin = new Listeners<void>();
  readonly #reset = new Listeners<number>();
  /** Bytes from the peer not yet handed to a listener: before the first, or while one's promise is pending. */
  #buffered: Uint8Array[] = [];
  #bufferedHead = 0;
  /** A listener's promise is pending: the next chunk, and its credit, wait for it. */
  #paused = false;
  /** Bytes received and not yet taken by a listener, and those taken that the sidecar hasn't been credited yet. */
  #unconsumed = 0;
  #owed = 0;
  /** Writes waiting for the window, in order. */
  #queue: Piece[] = [];
  #queueHead = 0;
  #queuedBytes = 0;
  /** Bytes sent to the sidecar that QUIC hasn't taken yet. */
  #unacked = 0;
  #finished = false;
  #finSent = false;
  #gotFin = false;
  #finDelivered = false;
  #resetCode: number | undefined;
  #forgotten = false;
  /** This stream's window each way: the wire's, or a live stream's (`setWindow`, or the opener's `window`). */
  #window: number;

  constructor(wire: SidecarWire, num: number, priority: number, conn: SidecarConn | undefined, gen: number, window = STREAM_WINDOW) {
    this.#wire = wire;
    this.num = num;
    this.priority = priority;
    this.#conn = conn;
    this.#gen = gen;
    this.#window = window;
  }

  get window(): number {
    return this.#window;
  }

  setWindow(bytes: number): void {
    // A sidecar without per-stream windows keeps the wire's for every stream.
    if (!this.#wire.streamWindows) return;
    const w = clampWindow(bytes);
    if (w === this.#window || this.#resetCode !== undefined) return;
    this.#window = w;
    // The sidecar gives the difference as credit, or takes back what is beyond the window, so no more than the window
    // is read ahead of this core.
    this.#wire.sendJson({ op: "window", stream: this.num, window: w }, this.#gen);
    // Credit owed that a narrower window's cadence would have sent already goes now.
    if (this.#owed >= this.#window / 4) {
      this.#wire.sendCredit(this.num, this.#owed, this.#gen);
      this.#owed = 0;
    }
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  get unackedBytes(): number {
    return this.#unacked;
  }

  get unconsumedBytes(): number {
    return this.#unconsumed;
  }

  write(chunk: Uint8Array): Promise<void> {
    if (this.#resetCode !== undefined) return Promise.reject(new WireOffline(this.#resetCode === RESET_CONN_LOST ? "the connection was lost" : "the stream was reset"));
    if (this.#finished) return Promise.reject(new Error("the stream is finished"));
    if (chunk.byteLength === 0) return Promise.resolve();
    // Pieces no bigger than the window, so a live stream's one piece never overshoots it.
    const piece = Math.min(PIECE, this.#window);
    return new Promise<void>((resolve, reject) => {
      for (let at = 0; at < chunk.byteLength; at += piece) {
        const bytes = chunk.subarray(at, Math.min(at + piece, chunk.byteLength));
        this.#queue.push(at + piece >= chunk.byteLength ? { bytes, resolve, reject } : { bytes });
        this.#queuedBytes += bytes.byteLength;
      }
      this.#pump();
    });
  }

  finish(): void {
    if (this.#finished || this.#resetCode !== undefined) return;
    this.#finished = true;
    this.#pump();
  }

  reset(code: number): void {
    if (this.#resetCode !== undefined) return;
    this.#resetCode = code;
    this.#dropAll(new WireOffline("the stream was reset"));
    this.#wire.sendJson({ op: "reset", stream: this.num, code }, this.#gen);
    this.#maybeForget();
  }

  onData(fn: (chunk: Uint8Array) => void | Promise<void>): Unsubscribe {
    this.#data.add(fn);
    this.#drain();
    return () => {
      this.#data.delete(fn);
    };
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

  /** @internal The sidecar's QUIC took `n` more of this stream's bytes. */
  acked(n: number): void {
    this.#unacked = Math.max(0, this.#unacked - n);
    this.#pump();
  }

  /** @internal */
  receive(chunk: Uint8Array): void {
    if (this.#resetCode !== undefined) return;
    this.#buffered.push(chunk);
    this.#unconsumed += chunk.byteLength;
    this.#drain();
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
    this.#dropAll(new WireOffline(code === RESET_CONN_LOST ? "the connection was lost" : "the stream was reset"));
    this.#maybeForget();
    this.#reset.emit(code);
  }

  /** Sends queued pieces while the window has room; a piece bigger than what's left waits until nothing is unacked.
   *  The finish goes once every write before it has. */
  #pump(): void {
    while (this.#queueHead < this.#queue.length && this.#resetCode === undefined) {
      const p = this.#queue[this.#queueHead]!;
      if (this.#unacked > 0 && this.#unacked + p.bytes.byteLength > this.#window) break;
      this.#queue[this.#queueHead++] = undefined as unknown as Piece;
      this.#queuedBytes -= p.bytes.byteLength;
      if (!this.#wire.sendData(this.num, p.bytes, this.#gen)) {
        // The process it was for is gone; the reset that comes with that fails the rest.
        p.reject?.(new WireOffline("the link sidecar is gone"));
        continue;
      }
      this.#unacked += p.bytes.byteLength;
      p.resolve?.();
    }
    if (this.#queueHead === this.#queue.length) {
      this.#queue = [];
      this.#queueHead = 0;
    } else if (this.#queueHead > 1024) {
      this.#queue = this.#queue.slice(this.#queueHead);
      this.#queueHead = 0;
    }
    if (this.#finished && !this.#finSent && this.#queueHead === this.#queue.length && this.#resetCode === undefined) {
      this.#finSent = true;
      this.#wire.sendJson({ op: "finish", stream: this.num }, this.#gen);
      this.#maybeForget();
    }
  }

  /** Hands buffered chunks to the listeners in order, one at a time while a listener's promise is pending. */
  #drain(): void {
    while (!this.#paused && this.#data.size > 0 && this.#bufferedHead < this.#buffered.length && this.#resetCode === undefined) {
      const c = this.#buffered[this.#bufferedHead]!;
      this.#buffered[this.#bufferedHead++] = undefined as unknown as Uint8Array;
      let waits: PromiseLike<unknown>[] | undefined;
      for (const fn of [...this.#data]) {
        try {
          const r = fn(c);
          if (r && typeof (r as PromiseLike<unknown>).then === "function") (waits ??= []).push(r);
        } catch {
          // A listener's own failure is its own; the stream keeps going.
        }
      }
      if (waits) {
        this.#paused = true;
        void Promise.allSettled(waits).then(() => {
          this.#paused = false;
          this.#consumed(c.byteLength);
          this.#drain();
        });
        return;
      }
      this.#consumed(c.byteLength);
    }
    if (this.#bufferedHead === this.#buffered.length) {
      this.#buffered = [];
      this.#bufferedHead = 0;
    }
    this.#maybeFin();
  }

  /** A listener took `n` bytes: credit the sidecar, in batches of a quarter window, so it always has most of one. */
  #consumed(n: number): void {
    if (this.#resetCode !== undefined) return;
    this.#unconsumed = Math.max(0, this.#unconsumed - n);
    if (this.#gotFin) return;
    this.#owed += n;
    if (this.#owed >= this.#window / 4) {
      this.#wire.sendCredit(this.num, this.#owed, this.#gen);
      this.#owed = 0;
    }
  }

  #maybeFin(): void {
    if (!this.#gotFin || this.#finDelivered || this.#paused || this.#bufferedHead < this.#buffered.length || this.#resetCode !== undefined) return;
    this.#finDelivered = true;
    this.#maybeForget();
    this.#fin.emit();
  }

  #dropAll(err: Error): void {
    this.#buffered = [];
    this.#bufferedHead = 0;
    this.#unconsumed = 0;
    for (let i = this.#queueHead; i < this.#queue.length; i++) this.#queue[i]!.reject?.(err);
    this.#queue = [];
    this.#queueHead = 0;
    this.#queuedBytes = 0;
    this.#unacked = 0;
  }

  /** The wire stops routing to a stream once both directions are done: the peer's FIN delivered and this side's
   *  finish sent, or a reset. Until then it may still write after the peer finished, or still read after it did. */
  #maybeForget(): void {
    if (this.#forgotten) return;
    if (this.#resetCode === undefined && !(this.#finDelivered && this.#finSent)) return;
    this.#forgotten = true;
    this.#conn?.streams.delete(this);
    this.#wire.forget(this.num);
  }
}
