// An in-memory wire: device keys joined in one process, for tests and for several daemons in one test (plan §3). It
// keeps the wire's promises (authenticated peer keys, independent ordered streams, a lost connection resetting every
// stream) without sockets. `partition` and `heal` cut and restore pairs; `setPath` says how a pair is reached, and a
// direct-only dial fails where the pair is reachable only through a relay, so the dial policy can be tested.
import { Listeners, type Unsubscribe } from "../contracts/common";
import { type Bytes, own, toHex } from "../identity/bytes";
import {
  CLOSE_LOST, CLOSE_SHUTDOWN, type DialOptions, type DialTarget, type PathInfo, RESET_CONN_LOST, type WireClose,
  type WireConn, type WireEndpoint, WireOffline, type WireStream,
} from "./wire";

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

interface PairState {
  cut: boolean;
  path: PathInfo;
}

export class MemoryNetwork {
  readonly #endpoints = new Map<string, MemoryEndpoint>();
  readonly #pairs = new Map<string, PairState>();
  readonly #isolated = new Set<string>();
  readonly #conns = new Set<MemoryConn>();
  #connSeq = 0;
  /** Dials that reached a peer, by `dialler>peer` hex prefixes, for tests. */
  readonly dials: { from: string; to: string; alpn: string; directOnly: boolean }[] = [];

  endpoint(publicKey: Uint8Array): MemoryEndpoint {
    const hex = toHex(publicKey);
    let e = this.#endpoints.get(hex);
    if (!e || e.isClosed) {
      e = new MemoryEndpoint(own(publicKey), this);
      this.#endpoints.set(hex, e);
    }
    return e;
  }

  /** Cuts `a` from `b`, or from everyone. Live connections between them are lost. */
  partition(a: Uint8Array, b?: Uint8Array): void {
    if (b === undefined) this.#isolated.add(toHex(a));
    else this.#pair(toHex(a), toHex(b)).cut = true;
    this.#dropUnreachable();
  }

  heal(a: Uint8Array, b?: Uint8Array): void {
    if (b === undefined) this.#isolated.delete(toHex(a));
    else this.#pair(toHex(a), toHex(b)).cut = false;
  }

  setPath(a: Uint8Array, b: Uint8Array, path: PathInfo): void {
    this.#pair(toHex(a), toHex(b)).path = { ...path };
    for (const c of this.#conns) {
      if ((c.localHex === toHex(a) && c.peerHex === toHex(b)) || (c.localHex === toHex(b) && c.peerHex === toHex(a))) c.pathChanged({ ...path });
    }
  }

  /** @internal */
  reachable(a: string, b: string): boolean {
    const ea = this.#endpoints.get(a);
    const eb = this.#endpoints.get(b);
    if (!ea || !eb || ea.isClosed || eb.isClosed) return false;
    if (this.#isolated.has(a) || this.#isolated.has(b)) return false;
    return !this.#pair(a, b).cut;
  }

  /** @internal */
  pathOf(a: string, b: string): PathInfo {
    return { ...this.#pair(a, b).path };
  }

  /** @internal */
  peerEndpoint(hex: string): MemoryEndpoint | undefined {
    return this.#endpoints.get(hex);
  }

  /** @internal */
  nextConnId(): string {
    return `mc_${++this.#connSeq}`;
  }

  /** @internal */
  track(c: MemoryConn): void {
    this.#conns.add(c);
    void c.closed.then(() => this.#conns.delete(c));
  }

  /** @internal Closes every connection whose ends can no longer reach each other. */
  dropUnreachable(): void {
    this.#dropUnreachable();
  }

  #dropUnreachable(): void {
    for (const c of [...this.#conns]) {
      if (c.outbound && !this.reachable(c.localHex, c.peerHex)) c.lost();
    }
  }

  #pair(a: string, b: string): PairState {
    const k = pairKey(a, b);
    let p = this.#pairs.get(k);
    if (!p) {
      p = { cut: false, path: { kind: "lan", rttMs: 1 } };
      this.#pairs.set(k, p);
    }
    return p;
  }
}

export class MemoryEndpoint implements WireEndpoint {
  readonly publicKey: Bytes;
  readonly hex: string;
  readonly #net: MemoryNetwork;
  readonly #incoming = new Map<string, (conn: WireConn) => void>();
  readonly #conns = new Set<MemoryConn>();
  #closed = false;
  networkChanges = 0;

  constructor(publicKey: Bytes, net: MemoryNetwork) {
    this.publicKey = publicKey;
    this.hex = toHex(publicKey);
    this.#net = net;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  async dial(target: DialTarget, opts: DialOptions): Promise<WireConn> {
    if (this.#closed) throw new WireOffline("this endpoint is closed");
    if (opts.signal?.aborted) throw new WireOffline("the dial was cancelled");
    await Promise.resolve();
    const peerHex = toHex(target.key);
    if (peerHex === this.hex) throw new WireOffline("a device has no link to itself");
    if (!this.#net.reachable(this.hex, peerHex)) throw new WireOffline("the peer can't be reached");
    const path = this.#net.pathOf(this.hex, peerHex);
    if (path.kind === "relay" && (opts.directOnly || target.relay === undefined)) throw new WireOffline("only a relay reaches the peer");
    const peer = this.#net.peerEndpoint(peerHex)!;
    const accept = peer.acceptor(opts.alpn);
    if (!accept) throw new WireOffline(`the peer takes no ${opts.alpn} connections`);
    this.#net.dials.push({ from: this.hex.slice(0, 8), to: peerHex.slice(0, 8), alpn: opts.alpn, directOnly: opts.directOnly === true });
    const id = this.#net.nextConnId();
    const mine = new MemoryConn(id, this, peer, opts.alpn, true, path, this.#net);
    const theirs = new MemoryConn(id, peer, this, opts.alpn, false, path, this.#net);
    mine.other = theirs;
    theirs.other = mine;
    this.#conns.add(mine);
    peer.adopt(theirs);
    this.#net.track(mine);
    this.#net.track(theirs);
    queueMicrotask(() => accept(theirs));
    return mine;
  }

  onIncoming(alpn: string, fn: (conn: WireConn) => void): Unsubscribe {
    this.#incoming.set(alpn, fn);
    return () => {
      if (this.#incoming.get(alpn) === fn) this.#incoming.delete(alpn);
    };
  }

  networkChanged(): void {
    this.networkChanges++;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const c of [...this.#conns]) c.close(CLOSE_SHUTDOWN, "the endpoint closed");
    this.#net.dropUnreachable();
  }

  /** @internal */
  acceptor(alpn: string): ((conn: WireConn) => void) | undefined {
    return this.#closed ? undefined : this.#incoming.get(alpn);
  }

  /** @internal */
  adopt(c: MemoryConn): void {
    this.#conns.add(c);
    void c.closed.then(() => this.#conns.delete(c));
  }
}

class MemoryConn implements WireConn {
  readonly id: string;
  readonly peerKey: Bytes;
  readonly alpn: string;
  readonly outbound: boolean;
  readonly closed: Promise<WireClose>;
  other?: MemoryConn;
  readonly #local: MemoryEndpoint;
  readonly #streams = new Set<MemoryStream>();
  readonly #onStream = new Listeners<WireStream>();
  readonly #pending: MemoryStream[] = [];
  readonly #onPath = new Listeners<PathInfo>();
  #path: PathInfo;
  #resolveClosed!: (c: WireClose) => void;
  #isClosed = false;

  constructor(id: string, local: MemoryEndpoint, peer: MemoryEndpoint, alpn: string, outbound: boolean, path: PathInfo, _net: MemoryNetwork) {
    this.id = id;
    this.#local = local;
    this.peerKey = peer.publicKey;
    this.alpn = alpn;
    this.outbound = outbound;
    this.#path = path;
    this.closed = new Promise((resolve) => (this.#resolveClosed = resolve));
  }

  get localHex(): string {
    return this.#local.hex;
  }

  get peerHex(): string {
    return toHex(this.peerKey);
  }

  path(): PathInfo {
    return { ...this.#path };
  }

  onPath(fn: (path: PathInfo) => void): Unsubscribe {
    return this.#onPath.add(fn);
  }

  openStream(priority: number): WireStream {
    const mine = new MemoryStream(priority);
    if (this.#isClosed || !this.other) {
      mine.lose();
      return mine;
    }
    const theirs = new MemoryStream(priority);
    mine.other = theirs;
    theirs.other = mine;
    this.#streams.add(mine);
    const other = this.other;
    queueMicrotask(() => other.incoming(theirs));
    return mine;
  }

  onStream(fn: (stream: WireStream) => void): Unsubscribe {
    const off = this.#onStream.add(fn);
    for (const s of this.#pending.splice(0)) fn(s);
    return off;
  }

  close(code: number, reason: string): void {
    if (this.#isClosed) return;
    this.end({ code, reason, local: true });
    const other = this.other;
    queueMicrotask(() => other?.end({ code, reason, local: false }));
  }

  /** @internal The path between the two was cut. */
  lost(): void {
    this.end({ code: CLOSE_LOST, reason: "the connection was lost", local: false });
    this.other?.end({ code: CLOSE_LOST, reason: "the connection was lost", local: false });
  }

  /** @internal */
  incoming(s: MemoryStream): void {
    if (this.#isClosed) {
      s.lose();
      return;
    }
    this.#streams.add(s);
    if (this.#onStream.size === 0) this.#pending.push(s);
    else this.#onStream.emit(s);
  }

  /** @internal */
  pathChanged(path: PathInfo): void {
    this.#path = path;
    this.#onPath.emit({ ...path });
  }

  /** @internal */
  end(c: WireClose): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    for (const s of this.#streams) s.lose();
    this.#streams.clear();
    for (const s of this.#pending.splice(0)) s.lose();
    this.#resolveClosed(c);
  }
}

class MemoryStream implements WireStream {
  readonly priority: number;
  other?: MemoryStream;
  readonly #data = new Listeners<Uint8Array>();
  readonly #fin = new Listeners<void>();
  readonly #reset = new Listeners<number>();
  readonly #buffered: Uint8Array[] = [];
  #finished = false;
  #gotFin = false;
  #resetCode: number | undefined;

  constructor(priority: number) {
    this.priority = priority;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#resetCode !== undefined) throw new WireOffline(this.#resetCode === RESET_CONN_LOST ? "the connection was lost" : "the stream was reset");
    if (this.#finished) throw new Error("the stream is finished");
    const copy = chunk.slice();
    const other = this.other;
    queueMicrotask(() => other?.receive(copy));
  }

  finish(): void {
    if (this.#finished || this.#resetCode !== undefined) return;
    this.#finished = true;
    const other = this.other;
    queueMicrotask(() => other?.receiveFin());
  }

  reset(code: number): void {
    if (this.#resetCode !== undefined) return;
    this.#resetCode = code;
    this.#buffered.length = 0;
    const other = this.other;
    queueMicrotask(() => other?.receiveReset(code));
  }

  onData(fn: (chunk: Uint8Array) => void): Unsubscribe {
    const off = this.#data.add(fn);
    for (const c of this.#buffered.splice(0)) fn(c);
    this.#maybeDeliverFin();
    return off;
  }

  onFin(fn: () => void): Unsubscribe {
    if (this.#finDelivered) queueMicrotask(fn);
    return this.#fin.add(fn);
  }

  #finDelivered = false;

  #maybeDeliverFin(): void {
    if (!this.#gotFin || this.#finDelivered || this.#buffered.length > 0 || this.#resetCode !== undefined) return;
    this.#finDelivered = true;
    this.#fin.emit();
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
    if (this.#resetCode !== undefined || this.#gotFin) return;
    this.#gotFin = true;
    this.#maybeDeliverFin();
  }

  /** @internal */
  receiveReset(code: number): void {
    if (this.#resetCode !== undefined) return;
    this.#resetCode = code;
    this.#buffered.length = 0;
    this.#reset.emit(code);
  }

  /** @internal The connection under it went away. */
  lose(): void {
    this.receiveReset(RESET_CONN_LOST);
  }
}
