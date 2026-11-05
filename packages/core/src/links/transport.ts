// Clover's LinkTransport (spec §8.2 "One persistent link per device pair"; contracts/link-transport.ts): one long-lived
// link per device pair over an authenticated wire (iroh through the link sidecar, or the in-memory wire in tests).
//
// How a link works:
// * A link is one `PeerLink` object per peer that outlives its connections. It may hold several wire connections at
//   once (both sides dialled, or a re-dial after a network change); new requests go on the best one, and every live
//   one is answered on. The best is the one whose hello agreed the highest sequence number, ties going to the one the
//   smaller device id dialled; both sides rank the same way, so they agree which ones to retire, and a retired
//   connection closes once nothing is in flight on it.
// * The dialler's first message is `peer.hello` (protocol version, device, lease epoch, features, a proposed
//   sequence number); the acceptor checks the device is the authenticated key's, answers with the version and the
//   agreed sequence, and only then does either side take requests on that connection.
// * Messages travel on lanes, one stream per priority class per direction (control, tokens, screenshots, files), so
//   a big message never holds up the small ones of a higher class; each LinkStream is a stream of its own (§8.2).
// * Only paired, unrevoked devices get a link: an incoming connection from any other key is closed, and a revocation
//   cuts the device's connections at once (§8.1; the controller's ruling: links refuse unpaired and revoked keys).
// * Calls fail fast: with no live connection a request waits for at most one dial, and none when the last dial
//   failed within `failFastMs`; a request in flight when its connection drops fails `offline` (§9.1).
// * A link re-dials by itself with backoff after a loss, and at once on `networkChanged` (S1: re-dial on every
//   network change and wake, keep whichever connection answers first).
import { type LinkPath, type LinkView, PEER_PROTOCOL_VERSION_RANGE } from "./versions";
import type { Clock, TimerHandle } from "../contracts/clock";
import { ContractError, isContractError, Listeners, type Unsubscribe } from "../contracts/common";
import { deviceIdFor, type DeviceChange, type DeviceRecord } from "../contracts/device-registry";
import { LINK_PRIORITIES, type Link, type LinkPriority, type LinkRequestOptions, type LinkStream, type LinkTransport } from "../contracts/link-transport";
import { decode, encode } from "./codec";
import { FrameReader, frame } from "./frames";
import {
  ALPN_LINK, CLOSE_PROTOCOL, CLOSE_REVOKED, CLOSE_SHUTDOWN, CLOSE_SUPERSEDED, CLOSE_UNPAIRED, type DialTarget,
  type PathInfo, RESET_ABORTED, RESET_CONN_LOST, RESET_NOT_FOUND, WIRE_PRIORITY, type WireConn, type WireEndpoint,
  WireOffline, type WireStream,
} from "./wire";

/** Where a paired peer may be reached; undefined when no address is known. */
export interface PeerDirectory {
  target(device: string): Promise<DialTarget | undefined> | DialTarget | undefined;
}

/** One dial attempt in a plan: when it starts, after the first, and whether it may use the relay. */
export interface DialStep {
  atMs: number;
  directOnly: boolean;
}

/** How a link dials a peer (the dial policy, edit 6 of the S1 report; `dial-policy.ts`). */
export interface DialPlanner {
  plan(peer: string, target: DialTarget): DialStep[] | Promise<DialStep[]>;
}

const ONE_DIAL: DialPlanner = { plan: () => [{ atMs: 0, directOnly: false }] };

export interface LinkTransportOptions {
  /** This device's id. */
  self: string;
  wire: WireEndpoint;
  /** Who is paired, and the revocations to act on. */
  registry: { get(id: string): DeviceRecord | undefined; watch(fn: (c: DeviceChange) => void): Unsubscribe };
  directory: PeerDirectory;
  clock: Clock;
  planner?: DialPlanner;
  /** The lease epoch the hello carries (H-M2); 0 until then. */
  epoch?: () => number;
  features?: readonly string[];
  /** A relay's id for `LinkView.relay`, from its URL (the relay plugin that configured it). */
  relayLabel?: (url: string) => string | undefined;
  dialTimeoutMs?: number;
  failFastMs?: number;
  keepaliveMs?: number;
  idleTimeoutMs?: number;
  helloTimeoutMs?: number;
  retireGraceMs?: number;
  redialBackoffMs?: readonly number[];
}

const DEFAULTS = {
  dialTimeoutMs: 5_000,
  failFastMs: 2_000,
  keepaliveMs: 5_000,
  idleTimeoutMs: 20_000,
  helloTimeoutMs: 5_000,
  retireGraceMs: 5_000,
  redialBackoffMs: [0, 250, 1_000, 2_000, 5_000, 10_000, 30_000] as readonly number[],
};

type ResolvedLinkOptions = Required<Omit<LinkTransportOptions, "relayLabel" | "epoch">> & Pick<LinkTransportOptions, "relayLabel" | "epoch">;

const PRIORITY_OF: Record<number, LinkPriority> = { 3: "control", 2: "tokens", 1: "screenshots", 0: "files" };

type Handler = (params: unknown, from: string) => unknown | Promise<unknown>;

const offline = (peer: string) => new ContractError("offline", `${peer} can't be reached`, { peer });

function errorToWire(err: unknown): { code: string; message: string; detail?: unknown } {
  if (err instanceof ContractError) return err.toJSON();
  return { code: "failed", message: err instanceof Error ? err.message : String(err) };
}

export class CloverLinkTransport implements LinkTransport {
  readonly self: string;
  readonly #o: ResolvedLinkOptions;
  readonly #links = new Map<string, PeerLink>();
  readonly #handlers = new Map<string, Handler>();
  readonly #notify = new Map<string, Listeners<{ params: unknown; from: string }>>();
  readonly #streamHandlers = new Map<string, (stream: LinkStream, meta: unknown, from: string) => void>();
  readonly #watchers = new Listeners<LinkView>();
  readonly #offs: Unsubscribe[] = [];
  #tick: TimerHandle | undefined;
  #closed = false;
  networkChanges = 0;

  constructor(opts: LinkTransportOptions) {
    this.self = opts.self;
    this.#o = {
      planner: ONE_DIAL, features: [], ...DEFAULTS, ...opts,
    } as ResolvedLinkOptions;
    this.#offs.push(opts.wire.onIncoming(ALPN_LINK, (conn) => void this.#accept(conn)));
    this.#offs.push(opts.registry.watch((c) => {
      if (c.type === "revoked") this.#revoked(c.id);
    }));
    this.#schedule();
  }

  get options(): Readonly<LinkTransportOptions> {
    return this.#o;
  }

  async connect(peer: string, opts: { signal?: AbortSignal } = {}): Promise<Link> {
    if (this.#closed) throw new ContractError("closed", "this transport is closed");
    if (opts.signal?.aborted) throw new ContractError("cancelled", "the dial was cancelled");
    if (peer === this.self) throw new ContractError("invalid", "a device has no link to itself");
    const d = this.#o.registry.get(peer);
    if (!d || d.revokedAt !== undefined) throw new ContractError("refused", `${peer} isn't a paired device`, { peer });
    const link = this.#link(peer);
    link.wanted = true;
    await link.ready(opts.signal);
    return link;
  }

  handle(method: string, fn: Handler): Unsubscribe {
    if (method === "peer.hello") throw new ContractError("refused", "the transport answers peer.hello itself");
    this.#handlers.set(method, fn);
    return () => {
      if (this.#handlers.get(method) === fn) this.#handlers.delete(method);
    };
  }

  onNotify(method: string, fn: (params: unknown, from: string) => void): Unsubscribe {
    let l = this.#notify.get(method);
    if (!l) {
      l = new Listeners();
      this.#notify.set(method, l);
    }
    return l.add(({ params, from }) => fn(params, from));
  }

  onStream(label: string, fn: (stream: LinkStream, meta: unknown, from: string) => void): Unsubscribe {
    this.#streamHandlers.set(label, fn);
    return () => {
      if (this.#streamHandlers.get(label) === fn) this.#streamHandlers.delete(label);
    };
  }

  links(): LinkView[] {
    return [...this.#links.values()].map((l) => l.view());
  }

  watch(fn: (view: LinkView) => void): Unsubscribe {
    return this.#watchers.add(fn);
  }

  networkChanged(): void {
    if (this.#closed) return;
    this.networkChanges++;
    this.#o.wire.networkChanged();
    for (const l of this.#links.values()) if (l.wanted && !l.revoked) l.redialNow();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#tick) this.#o.clock.clearTimeout(this.#tick);
    for (const off of this.#offs.splice(0)) off();
    for (const l of this.#links.values()) l.shutdown(CLOSE_SHUTDOWN, "the transport closed");
    await this.#o.wire.close();
  }

  /** Dials a peer now (the handshake's "dial now"), without waiting for the result. */
  dialNow(peer: string): void {
    const d = this.#o.registry.get(peer);
    if (this.#closed || !d || d.revokedAt !== undefined) return;
    const link = this.#link(peer);
    link.wanted = true;
    link.redialNow();
  }

  // ---- internals shared with PeerLink and Session ----

  /** @internal */
  get closedFlag(): boolean {
    return this.#closed;
  }

  /** @internal */
  get opts() {
    return this.#o;
  }

  /** @internal */
  emitView(view: LinkView): void {
    this.#watchers.emit(view);
  }

  /** @internal */
  async serve(method: string, params: unknown, from: string): Promise<unknown> {
    const fn = this.#handlers.get(method);
    if (!fn) throw new ContractError("not_found", `${this.self} serves no \`${method}\``);
    return fn(params, from);
  }

  /** @internal */
  deliverNotify(method: string, params: unknown, from: string): void {
    this.#notify.get(method)?.emit({ params, from });
  }

  /** @internal */
  streamHandler(label: string): ((stream: LinkStream, meta: unknown, from: string) => void) | undefined {
    return this.#streamHandlers.get(label);
  }

  /** @internal */
  link(peer: string): PeerLink {
    return this.#link(peer);
  }

  #link(peer: string): PeerLink {
    let l = this.#links.get(peer);
    if (!l) {
      l = new PeerLink(peer, this);
      this.#links.set(peer, l);
    }
    return l;
  }

  async #accept(conn: WireConn): Promise<void> {
    if (this.#closed) {
      conn.close(CLOSE_SHUTDOWN, "the transport closed");
      return;
    }
    const peer = await deviceIdFor(conn.peerKey);
    const d = this.#o.registry.get(peer);
    if (!d || d.revokedAt !== undefined) {
      conn.close(d ? CLOSE_REVOKED : CLOSE_UNPAIRED, d ? "the device was revoked" : "not a paired device");
      return;
    }
    const link = this.#link(peer);
    link.wanted = true;
    const s = new Session(conn, link, this);
    s.start();
  }

  #revoked(peer: string): void {
    const l = this.#links.get(peer);
    if (!l) return;
    l.revoked = true;
    l.shutdown(CLOSE_REVOKED, "the device was revoked");
  }

  #schedule(): void {
    if (this.#closed) return;
    this.#tick = this.#o.clock.setTimeout(() => {
      for (const l of this.#links.values()) l.tick();
      this.#schedule();
    }, Math.max(250, Math.floor(this.#o.keepaliveMs / 2)));
  }
}

/** A peer's link: the same object across drops and re-dials. */
class PeerLink implements Link {
  readonly peer: string;
  readonly #t: CloverLinkTransport;
  readonly sessions = new Set<Session>();
  #best: Session | undefined;
  #dialing: Promise<Session> | undefined;
  #lastDialFailedAt = Number.NEGATIVE_INFINITY;
  #redialTimer: TimerHandle | undefined;
  #attempt = 0;
  #since: number | undefined;
  #lastView = "";
  wanted = false;
  revoked = false;
  /** The highest connection sequence number seen or proposed with this peer. */
  lastSeq = 0;

  constructor(peer: string, t: CloverLinkTransport) {
    this.peer = peer;
    this.#t = t;
  }

  view(): LinkView {
    const best = this.#best;
    if (!best) return { peer: this.peer, up: false, ...(this.#since === undefined ? {} : { since: this.#since }) };
    const p = best.conn.path();
    const relay = p.kind === "relay" && p.relay !== undefined ? (this.#t.opts.relayLabel?.(p.relay) ?? p.relay) : undefined;
    return {
      peer: this.peer, up: true, path: p.kind as LinkPath,
      ...(relay === undefined ? {} : { relay }),
      ...(p.rttMs === undefined ? {} : { rttMs: p.rttMs }),
      ...(this.#since === undefined ? {} : { since: this.#since }),
    };
  }

  /** Whether a request can go out now. */
  get up(): boolean {
    return this.#best !== undefined;
  }

  /** A ready session, dialling one if needed; `offline` when none comes. */
  async ready(signal?: AbortSignal): Promise<Session> {
    if (this.revoked) throw new ContractError("refused", `${this.peer} was revoked`, { peer: this.peer });
    if (this.#best) return this.#best;
    if (!this.#dialing && this.#t.opts.clock.monotonic() - this.#lastDialFailedAt < this.#t.opts.failFastMs) throw offline(this.peer);
    const dial = this.#dialing ?? this.#dial();
    // Whichever comes first: this side's dial, or the peer's own dial in (a peer that restarted dials its computers).
    return new Promise<Session>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.#bestWaiters.delete(onBest);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onBest = (s: Session) => done(() => resolve(s));
      const onAbort = () => done(() => reject(new ContractError("cancelled", "the dial was cancelled")));
      this.#bestWaiters.add(onBest);
      signal?.addEventListener("abort", onAbort, { once: true });
      dial.then((s) => done(() => resolve(s)), (e: unknown) => done(() => (this.#best ? resolve(this.#best) : reject(e))));
    });
  }

  readonly #bestWaiters = new Set<(s: Session) => void>();

  request<R = unknown>(method: string, params: unknown, opts: LinkRequestOptions = {}): Promise<R> {
    if (opts.signal?.aborted) return Promise.reject(new ContractError("cancelled", "the request was cancelled"));
    let payload: Uint8Array;
    try {
      payload = encode(params);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.ready(opts.signal).then((s) => s.request<R>(method, payload, opts));
  }

  notify(method: string, params: unknown, opts: { priority?: LinkPriority } = {}): void {
    const s = this.#best;
    if (!s) return; // a notification to an unreachable peer is dropped
    s.notify(method, params, opts.priority ?? "control");
  }

  openStream(label: string, priority: LinkPriority, meta?: unknown): LinkStream {
    const s = this.#best;
    if (!s) throw offline(this.peer);
    return s.openStream(label, priority, meta);
  }

  // ---- connection management ----

  /** A session finished its hello: rank it, and retire whichever lost. */
  adopt(s: Session): void {
    if (this.revoked || this.#t.closedFlag) {
      s.close(this.revoked ? CLOSE_REVOKED : CLOSE_SHUTDOWN, "no link");
      return;
    }
    this.sessions.add(s);
    this.lastSeq = Math.max(this.lastSeq, s.seq);
    const wasUp = this.#best !== undefined;
    const best = [...this.sessions].filter((x) => x.isReady && !x.retiring).sort(rank)[0];
    for (const x of this.sessions) if (x !== best && x.isReady && !x.retiring) x.retire();
    this.#best = best;
    this.#attempt = 0;
    if (this.#redialTimer) {
      this.#t.opts.clock.clearTimeout(this.#redialTimer);
      this.#redialTimer = undefined;
    }
    if (!wasUp) this.#since = this.#t.opts.clock.now();
    this.#changed();
    if (best) for (const w of [...this.#bestWaiters]) w(best);
  }

  /** A session ended. */
  dropped(s: Session): void {
    this.sessions.delete(s);
    if (this.#best === s) {
      const next = [...this.sessions].filter((x) => x.isReady && !x.retiring).sort(rank)[0];
      this.#best = next;
      if (!next) this.#since = this.#t.opts.clock.now();
      this.#changed();
      if (!next && this.wanted && !this.revoked && !this.#t.closedFlag) this.#scheduleRedial();
    }
  }

  pathChanged(s: Session): void {
    if (s === this.#best) this.#changed();
  }

  #changed(): void {
    const v = this.view();
    const key = JSON.stringify({ up: v.up, path: v.path, relay: v.relay, rttMs: v.rttMs });
    if (key === this.#lastView) return;
    this.#lastView = key;
    this.#t.emitView(v);
  }

  redialNow(): void {
    if (this.#redialTimer) {
      this.#t.opts.clock.clearTimeout(this.#redialTimer);
      this.#redialTimer = undefined;
    }
    // A connection that has heard nothing for a while is likely stale after a network change: close it first, since
    // iroh dials a peer slowly while a stale connection to it is still open (S1, network changes, point 5).
    for (const s of this.sessions) if (s.silentFor() > this.#t.opts.keepaliveMs) s.close(CLOSE_SUPERSEDED, "stale after a network change");
    // A fresh dial, even with one in flight: that one may be headed for an address the peer has left.
    void this.#dial(true).catch(() => undefined);
  }

  #scheduleRedial(): void {
    if (this.#redialTimer || this.#dialing) return;
    const backoff = this.#t.opts.redialBackoffMs;
    const ms = backoff[Math.min(this.#attempt, backoff.length - 1)] ?? 30_000;
    this.#attempt++;
    this.#redialTimer = this.#t.opts.clock.setTimeout(() => {
      this.#redialTimer = undefined;
      if (this.#best || this.revoked || this.#t.closedFlag) return;
      this.#dial().catch(() => {
        if (!this.#best) this.#scheduleRedial();
      });
    }, ms);
  }

  /** One dial at a time, unless `fresh`: then another joins the one in flight, and the first to answer wins. */
  #dial(fresh = false): Promise<Session> {
    if (this.#dialing && !fresh) return this.#dialing;
    const attempt = this.#runDial();
    const prev = this.#dialing;
    const either: Promise<Session> = prev ? Promise.any([prev, attempt]).catch((e: unknown) => {
      throw e instanceof AggregateError ? (e.errors.at(-1) as Error) : e;
    }) : attempt;
    const p: Promise<Session> = either.then(
      (s) => {
        if (this.#dialing === p) this.#dialing = undefined;
        return s;
      },
      (err: unknown) => {
        if (this.#dialing === p) this.#dialing = undefined;
        this.#lastDialFailedAt = this.#t.opts.clock.monotonic();
        throw isContractError(err) ? err : offline(this.peer);
      },
    );
    this.#dialing = p;
    return p;
  }

  async #runDial(): Promise<Session> {
    const o = this.#t.opts;
    const target = await o.directory.target(this.peer);
    if (!target) throw new ContractError("offline", `no address is known for ${this.peer}`, { peer: this.peer });
    const steps = await o.planner.plan(this.peer, target);
    const conn = await runPlan(o.wire, target, steps, o.clock, o.dialTimeoutMs);
    if ((await deviceIdFor(conn.peerKey)) !== this.peer) {
      conn.close(CLOSE_PROTOCOL, "the wrong device answered");
      throw offline(this.peer);
    }
    const s = new Session(conn, this, this.#t);
    s.start();
    await s.readyPromise;
    return s;
  }

  /** Called on the transport's timer: keep-alives and idle checks. */
  tick(): void {
    for (const s of this.sessions) s.tick();
  }

  shutdown(code: number, reason: string): void {
    if (this.#redialTimer) {
      this.#t.opts.clock.clearTimeout(this.#redialTimer);
      this.#redialTimer = undefined;
    }
    for (const s of [...this.sessions]) s.close(code, reason);
    for (const s of [...pendingSessions(this)]) s.close(code, reason);
  }

  /** @internal Sessions still in their hello, so a shutdown closes them too. */
  readonly starting = new Set<Session>();
}

function pendingSessions(l: PeerLink): Set<Session> {
  return l.starting;
}

/** Best first: the highest agreed sequence, then the one the smaller device id dialled. */
function rank(a: Session, b: Session): number {
  if (a.seq !== b.seq) return b.seq - a.seq;
  return a.dialler < b.dialler ? -1 : a.dialler > b.dialler ? 1 : 0;
}

/** Runs a dial plan: each step starts at its time unless one has already connected; the first connection wins and
 *  any later one is closed. Fails `offline` when every step has failed. */
export async function runPlan(wire: WireEndpoint, target: DialTarget, steps: readonly DialStep[], clock: Clock, timeoutMs: number): Promise<WireConn> {
  if (steps.length === 0) throw new WireOffline("no dial planned");
  return new Promise<WireConn>((resolve, reject) => {
    let won: WireConn | undefined;
    let failed = 0;
    const timers: TimerHandle[] = [];
    const ctl = new AbortController();
    const deadline = clock.setTimeout(() => {
      if (!won) {
        ctl.abort();
        reject(new ContractError("offline", "no path answered in time"));
      }
    }, timeoutMs);
    const start = (step: DialStep) => {
      if (won || ctl.signal.aborted) return;
      wire.dial(target, { alpn: ALPN_LINK, directOnly: step.directOnly, signal: ctl.signal, timeoutMs }).then(
        (conn) => {
          if (won || ctl.signal.aborted) {
            conn.close(CLOSE_SUPERSEDED, "another dial won");
            return;
          }
          won = conn;
          for (const t of timers) clock.clearTimeout(t);
          clock.clearTimeout(deadline);
          resolve(conn);
        },
        () => {
          failed++;
          if (failed === steps.length && !won) {
            clock.clearTimeout(deadline);
            reject(new ContractError("offline", "no path reached the peer"));
          }
        },
      );
    };
    for (const step of steps) {
      if (step.atMs <= 0) start(step);
      else timers.push(clock.setTimeout(() => start(step), step.atMs));
    }
  });
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: TimerHandle };

/** One wire connection's link protocol: the hello, the lanes, requests, notifications and streams. */
class Session {
  readonly conn: WireConn;
  readonly #link: PeerLink;
  readonly #t: CloverLinkTransport;
  readonly #lanes = new Map<number, WireStream>();
  readonly #pending = new Map<number, Pending>();
  readonly #streams = new Set<SessionStream>();
  #nextId = 1;
  #nextStream = 0;
  #ready = false;
  #ended = false;
  #resolveReady!: (s: Session) => void;
  #rejectReady!: (e: Error) => void;
  readonly readyPromise: Promise<Session>;
  #lastIn: number;
  #lastOut: number;
  #helloTimer: TimerHandle | undefined;
  retiring = false;
  seq = 0;
  /** The device that dialled this connection. */
  dialler: string;

  constructor(conn: WireConn, link: PeerLink, t: CloverLinkTransport) {
    this.conn = conn;
    this.#link = link;
    this.#t = t;
    this.dialler = conn.outbound ? t.self : link.peer;
    this.#lastIn = t.opts.clock.monotonic();
    this.#lastOut = this.#lastIn;
    this.readyPromise = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.readyPromise.catch(() => undefined);
  }

  get isReady(): boolean {
    return this.#ready && !this.#ended;
  }

  start(): void {
    const t = this.#t;
    this.#link.starting.add(this);
    this.conn.onStream((ws) => this.#incomingStream(ws));
    this.conn.onPath(() => this.#link.pathChanged(this));
    void this.conn.closed.then((c) => this.#end(c.code === CLOSE_REVOKED ? new ContractError("refused", `${this.#link.peer} was revoked`) : offline(this.#link.peer)));
    this.#helloTimer = t.opts.clock.setTimeout(() => {
      if (!this.#ready) this.close(CLOSE_PROTOCOL, "no hello in time");
    }, t.opts.helloTimeoutMs);
    if (this.conn.outbound) {
      const proposed = this.#link.lastSeq + 1;
      this.#link.lastSeq = proposed;
      const hello = { protocolVersion: PEER_PROTOCOL_VERSION_RANGE.current, device: t.self, epoch: t.opts.epoch?.() ?? 0, features: [...t.opts.features], connSeq: proposed };
      const p = this.#send("control", ["q", 0, "peer.hello", hello]);
      this.#pending.set(0, {
        resolve: (v) => this.#helloAnswered(v),
        reject: (e) => this.#fail(e),
      });
      p.catch((e: unknown) => this.#fail(e instanceof Error ? e : new Error(String(e))));
    }
  }

  #helloAnswered(v: unknown): void {
    const r = v as { protocolVersion?: unknown; device?: unknown; connSeq?: unknown };
    if (r?.device !== this.#link.peer || typeof r.connSeq !== "number" || !PEER_PROTOCOL_VERSION_RANGE.accepts(r.protocolVersion)) {
      this.close(CLOSE_PROTOCOL, "a bad hello answer");
      return;
    }
    this.seq = r.connSeq;
    this.#becomeReady();
  }

  #answerHello(id: number, lane: number, v: unknown): void {
    const h = v as { protocolVersion?: unknown; device?: unknown; connSeq?: unknown; features?: unknown };
    if (this.conn.outbound || this.#ready) {
      this.close(CLOSE_PROTOCOL, "an unexpected hello");
      return;
    }
    if (h?.device !== this.#link.peer || typeof h.connSeq !== "number" || !Number.isSafeInteger(h.connSeq) || h.connSeq < 0) {
      this.close(CLOSE_PROTOCOL, "a bad hello");
      return;
    }
    if (!PEER_PROTOCOL_VERSION_RANGE.accepts(h.protocolVersion)) {
      void this.#reply(lane, id, false, { code: "refused", message: `protocol version ${String(h.protocolVersion)} isn't supported` }).finally(() => this.close(CLOSE_PROTOCOL, "unsupported protocol version"));
      return;
    }
    const agreed = Math.max(h.connSeq, this.#link.lastSeq + 1);
    this.#link.lastSeq = agreed;
    this.seq = agreed;
    const t = this.#t;
    const answer = { protocolVersion: PEER_PROTOCOL_VERSION_RANGE.agree(h.protocolVersion as number), device: t.self, epoch: t.opts.epoch?.() ?? 0, features: [...t.opts.features], connSeq: agreed };
    void this.#reply(lane, id, true, answer).then(() => this.#becomeReady(), (e: unknown) => this.#fail(e instanceof Error ? e : new Error(String(e))));
  }

  #becomeReady(): void {
    if (this.#ended || this.#ready) return;
    this.#ready = true;
    if (this.#helloTimer) this.#t.opts.clock.clearTimeout(this.#helloTimer);
    this.#link.starting.delete(this);
    this.#link.adopt(this);
    this.#resolveReady(this);
  }

  #fail(e: Error): void {
    this.close(CLOSE_PROTOCOL, e.message);
  }

  silentFor(): number {
    return this.#t.opts.clock.monotonic() - this.#lastIn;
  }

  tick(): void {
    if (!this.#ready || this.#ended) return;
    const now = this.#t.opts.clock.monotonic();
    if (now - this.#lastIn > this.#t.opts.idleTimeoutMs) {
      this.close(CLOSE_SUPERSEDED, "nothing heard from the peer");
      return;
    }
    if (now - this.#lastOut >= this.#t.opts.keepaliveMs) void this.#send("control", ["p"]).catch(() => undefined);
    if (this.retiring && this.#pending.size === 0 && this.#streams.size === 0) this.close(CLOSE_SUPERSEDED, "a newer connection took over");
  }

  /** A better session took over: stop starting work here and close once nothing is in flight. */
  retire(): void {
    if (this.retiring) return;
    this.retiring = true;
    const grace = this.#t.opts.retireGraceMs;
    this.#t.opts.clock.setTimeout(() => this.close(CLOSE_SUPERSEDED, "a newer connection took over"), grace);
    if (this.#pending.size === 0 && this.#streams.size === 0) queueMicrotask(() => this.close(CLOSE_SUPERSEDED, "a newer connection took over"));
  }

  close(code: number, reason: string): void {
    if (this.#ended) return;
    this.conn.close(code, reason);
    this.#end(code === CLOSE_REVOKED ? new ContractError("refused", `${this.#link.peer} was revoked`) : offline(this.#link.peer));
  }

  #end(err: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#helloTimer) this.#t.opts.clock.clearTimeout(this.#helloTimer);
    this.#link.starting.delete(this);
    for (const [, p] of this.#pending) {
      if (p.timer) this.#t.opts.clock.clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
    for (const s of [...this.#streams]) s.finishWith(err);
    this.#streams.clear();
    this.#rejectReady(err);
    this.#link.dropped(this);
  }

  // ---- sending ----

  #lane(priority: LinkPriority): WireStream {
    const p = WIRE_PRIORITY[priority];
    let lane = this.#lanes.get(p);
    if (!lane) {
      lane = this.conn.openStream(p);
      this.#lanes.set(p, lane);
      void lane.write(frame(encode(["L"]))).catch(() => undefined);
    }
    return lane;
  }

  async #send(priority: LinkPriority, msg: unknown[]): Promise<void> {
    if (this.#ended) throw offline(this.#link.peer);
    const bytes = frame(encode(msg));
    this.#lastOut = this.#t.opts.clock.monotonic();
    try {
      await this.#lane(priority).write(bytes);
    } catch {
      throw offline(this.#link.peer);
    }
  }

  async #sendRaw(priority: LinkPriority, head: unknown[], payload: Uint8Array): Promise<void> {
    if (this.#ended) throw offline(this.#link.peer);
    // The params were encoded once by the caller; splice them in as the last element of the message array.
    const headBytes = encode(head);
    const msg = spliceLast(headBytes, payload);
    this.#lastOut = this.#t.opts.clock.monotonic();
    try {
      await this.#lane(priority).write(frame(msg));
    } catch {
      throw offline(this.#link.peer);
    }
  }

  async #reply(laneP: number, id: number, ok: boolean, value: unknown): Promise<void> {
    const priority = PRIORITY_OF[laneP] ?? "control";
    if (this.#ended) throw offline(this.#link.peer);
    let bytes: Uint8Array;
    try {
      bytes = frame(encode(["r", id, ok ? 1 : 0, value]));
    } catch (err) {
      bytes = frame(encode(["r", id, 0, errorToWire(err)]));
    }
    this.#lastOut = this.#t.opts.clock.monotonic();
    try {
      await this.#lane(priority).write(bytes);
    } catch {
      throw offline(this.#link.peer);
    }
  }

  /** @internal Anything heard from the peer on this connection. */
  heard(): void {
    this.#lastIn = this.#t.opts.clock.monotonic();
  }

  request<R>(method: string, payload: Uint8Array, opts: LinkRequestOptions): Promise<R> {
    if (this.#ended) return Promise.reject(offline(this.#link.peer));
    const id = this.#nextId++;
    const priority = opts.priority ?? "control";
    return new Promise<R>((resolve, reject) => {
      const clock = this.#t.opts.clock;
      const p: Pending = { resolve: resolve as (v: unknown) => void, reject };
      const settle = () => {
        if (p.timer) clock.clearTimeout(p.timer);
        this.#pending.delete(id);
      };
      p.resolve = (v) => {
        settle();
        resolve(v as R);
      };
      p.reject = (e) => {
        settle();
        reject(e);
      };
      if (opts.timeoutMs !== undefined) p.timer = clock.setTimeout(() => p.reject(new ContractError("timeout", `\`${method}\` to ${this.#link.peer} ran past ${opts.timeoutMs} ms`)), opts.timeoutMs);
      opts.signal?.addEventListener("abort", () => p.reject(new ContractError("cancelled", "the request was cancelled")), { once: true });
      this.#pending.set(id, p);
      this.#sendRaw(priority, ["q", id, method], payload).catch((e: unknown) => p.reject(e instanceof Error ? e : offline(this.#link.peer)));
    });
  }

  notify(method: string, params: unknown, priority: LinkPriority): void {
    if (this.#ended) return;
    let bytes: Uint8Array;
    try {
      bytes = encode(params);
    } catch {
      return;
    }
    void this.#sendRaw(priority, ["n", method], bytes).catch(() => undefined);
  }

  openStream(label: string, priority: LinkPriority, meta: unknown): LinkStream {
    if (this.#ended) throw offline(this.#link.peer);
    const header = encode(["S", label, priority, meta ?? null]);
    const ws = this.conn.openStream(WIRE_PRIORITY[priority]);
    const s = new SessionStream(`${this.conn.id}:${++this.#nextStream}`, label, priority, ws, this, this.#link.peer, true);
    this.#streams.add(s);
    s.writeHeader(header);
    return s;
  }

  streamEnded(s: SessionStream): void {
    this.#streams.delete(s);
  }

  // ---- receiving ----

  #incomingStream(ws: WireStream): void {
    const reader = new FrameReader();
    let kind: "lane" | "stream" | undefined;
    let stream: SessionStream | undefined;
    ws.onData((chunk) => {
      this.#lastIn = this.#t.opts.clock.monotonic();
      let frames: Uint8Array[];
      try {
        frames = reader.push(chunk);
      } catch {
        ws.reset(RESET_ABORTED);
        this.close(CLOSE_PROTOCOL, "a malformed frame");
        return;
      }
      for (const f of frames) {
        if (kind === "stream") {
          stream!.deliver(f);
          continue;
        }
        let msg: unknown;
        try {
          msg = decode(f);
        } catch {
          this.close(CLOSE_PROTOCOL, "a malformed message");
          return;
        }
        if (kind === undefined) {
          if (Array.isArray(msg) && msg[0] === "L") {
            kind = "lane";
            continue;
          }
          if (Array.isArray(msg) && msg[0] === "S" && typeof msg[1] === "string" && typeof msg[2] === "string") {
            kind = "stream";
            stream = this.#acceptStream(ws, msg[1], msg[2] as LinkPriority, msg[3]);
            if (!stream) return;
            continue;
          }
          this.close(CLOSE_PROTOCOL, "a stream of an unknown kind");
          return;
        }
        this.#message(ws.priority, msg);
      }
    });
  }

  #acceptStream(ws: WireStream, label: string, priority: LinkPriority, meta: unknown): SessionStream | undefined {
    if (!(LINK_PRIORITIES as readonly string[]).includes(priority)) {
      ws.reset(RESET_NOT_FOUND);
      return undefined;
    }
    const s = new SessionStream(`${this.conn.id}:in:${++this.#nextStream}`, label, priority, ws, this, this.#link.peer, false);
    this.#streams.add(s);
    // The peer may open a stream before this side has read the hello's answer; hand it over once ready.
    void this.readyPromise.then(
      () => {
        const fn = this.#t.streamHandler(label);
        if (!fn) {
          ws.reset(RESET_NOT_FOUND);
          s.finishWith(new ContractError("not_found", `no \`${label}\` streams here`));
          return;
        }
        try {
          fn(s, meta, this.#link.peer);
        } catch {
          // The handler's own failure; the stream stays as it left it.
        }
      },
      () => undefined,
    );
    return s;
  }

  #message(lane: number, msg: unknown): void {
    if (!Array.isArray(msg)) {
      this.close(CLOSE_PROTOCOL, "a malformed message");
      return;
    }
    const [type] = msg;
    if (type === "p") return;
    if (type === "q") {
      const [, id, method, params] = msg as [string, number, string, unknown];
      if (typeof id !== "number" || typeof method !== "string") {
        this.close(CLOSE_PROTOCOL, "a malformed request");
        return;
      }
      if (method === "peer.hello") {
        this.#answerHello(id, lane, params);
        return;
      }
      void this.readyPromise.then(
        () => this.#serve(lane, id, method, params),
        () => undefined,
      );
      return;
    }
    if (type === "r") {
      const [, id, ok, value] = msg as [string, number, number, unknown];
      const p = this.#pending.get(id);
      if (!p) return;
      if (ok === 1) p.resolve(value);
      else p.reject(ContractError.fromJSON(value));
      return;
    }
    if (type === "n") {
      const [, method, params] = msg as [string, string, unknown];
      if (typeof method !== "string") return;
      void this.readyPromise.then(
        () => this.#t.deliverNotify(method, params, this.#link.peer),
        () => undefined,
      );
      return;
    }
    this.close(CLOSE_PROTOCOL, "an unknown message");
  }

  async #serve(lane: number, id: number, method: string, params: unknown): Promise<void> {
    let ok = true;
    let value: unknown;
    try {
      value = await this.#t.serve(method, params, this.#link.peer);
    } catch (err) {
      ok = false;
      value = errorToWire(err);
    }
    if (this.#ended) return;
    await this.#reply(lane, id, ok, value).catch(() => undefined);
  }
}

/** Puts already-encoded CBOR bytes in as one more element of an encoded array (the array's length grows by one). */
function spliceLast(headArray: Uint8Array, element: Uint8Array): Uint8Array {
  // Small arrays (fewer than 23 elements) store their length in the first byte: 0x80 | n.
  const first = headArray[0]!;
  if (first >> 5 !== 4 || (first & 31) >= 23) throw new ContractError("invalid", "unexpected message head");
  const out = new Uint8Array(headArray.byteLength + element.byteLength);
  out.set(headArray);
  out[0] = 0x80 | ((first & 31) + 1);
  out.set(element, headArray.byteLength);
  return out;
}

/** A LinkStream on a wire stream: a header frame, then one frame per chunk. */
class SessionStream implements LinkStream {
  readonly id: string;
  readonly label: string;
  readonly priority: LinkPriority;
  readonly #ws: WireStream;
  readonly #session: Session;
  readonly #peer: string;
  readonly #data = new Listeners<Uint8Array>();
  readonly #end = new Listeners<Error | undefined>();
  readonly #buffered: Uint8Array[] = [];
  #open = true;
  #ended = false;
  #endError: Error | undefined;
  #writes: Promise<void> = Promise.resolve();

  /** `outgoing`: this side opened it, so it reads the peer's frames itself; an incoming stream's frames come through
   *  the session's reader, which read its header. */
  constructor(id: string, label: string, priority: LinkPriority, ws: WireStream, session: Session, peer: string, outgoing: boolean) {
    this.id = id;
    this.label = label;
    this.priority = priority;
    this.#ws = ws;
    this.#session = session;
    this.#peer = peer;
    if (outgoing) {
      const reader = new FrameReader();
      ws.onData((chunk) => {
        session.heard();
        let frames: Uint8Array[];
        try {
          frames = reader.push(chunk);
        } catch {
          this.abort("a malformed frame");
          return;
        }
        for (const f of frames) this.deliver(f);
      });
    }
    ws.onFin(() => this.peerFinished());
    ws.onReset((code) => this.peerReset(code));
  }

  writeHeader(header: Uint8Array): void {
    this.#writes = this.#ws.write(frame(header)).catch(() => undefined);
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.#open) throw this.#endError ?? new ContractError("closed", "the stream has ended");
    const bytes = frame(chunk);
    const prev = this.#writes;
    const next = prev.then(() => this.#ws.write(bytes));
    this.#writes = next.catch(() => undefined);
    try {
      await next;
    } catch {
      throw this.#endError ?? offline(this.#peer);
    }
  }

  end(): void {
    if (!this.#open) return;
    this.#open = false;
    void this.#writes.then(() => this.#ws.finish());
    this.#localEnd(undefined);
  }

  abort(reason = "aborted"): void {
    if (!this.#open && this.#ended) return;
    this.#open = false;
    this.#ws.reset(RESET_ABORTED);
    this.finishWith(new ContractError("closed", `the stream was aborted: ${reason}`));
  }

  onData(fn: (chunk: Uint8Array) => void): Unsubscribe {
    const off = this.#data.add(fn);
    for (const c of this.#buffered.splice(0)) fn(c);
    return off;
  }

  onEnd(fn: (error?: Error) => void): Unsubscribe {
    if (this.#ended) {
      const err = this.#endError;
      queueMicrotask(() => fn(err));
      return () => {};
    }
    return this.#end.add(fn);
  }

  /** @internal */
  deliver(chunk: Uint8Array): void {
    if (this.#ended && this.#endError) return;
    if (this.#data.size === 0) this.#buffered.push(chunk);
    else this.#data.emit(chunk);
  }

  /** @internal The peer ended its side: the stream is done once both sides have. */
  peerFinished(): void {
    if (this.#open) {
      // The peer is done sending; this side may still write until it ends.
      this.#open = false;
      this.#ws.finish();
    }
    this.#localEnd(undefined);
  }

  /** @internal */
  peerReset(code: number): void {
    this.#open = false;
    this.finishWith(
      code === RESET_NOT_FOUND
        ? new ContractError("not_found", `${this.#peer} takes no \`${this.label}\` streams`)
        : code === RESET_CONN_LOST
          ? offline(this.#peer)
          : new ContractError("closed", "the peer aborted the stream"),
    );
  }

  /** @internal */
  finishWith(err: Error | undefined): void {
    if (this.#ended) return;
    this.#open = false;
    this.#ended = true;
    this.#endError = err;
    this.#session.streamEnded(this);
    this.#end.emit(err);
  }

  #localEnd(err: Error | undefined): void {
    this.finishWith(err);
  }
}

export type { LinkPath };
