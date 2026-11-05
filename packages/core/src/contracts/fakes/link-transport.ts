// FakeLinkNetwork: several devices' transports in one test, joined in memory, so several daemons can talk as they
// would over real links (plan §3 "several daemons in one test joined by the fake link"). Messages are structured-cloned
// and delivered on microtasks; `partition` and `heal` cut and restore pairs. Priorities are recorded, not scheduled:
// each stream and the message channel keep their own order.
import type { LinkPath, LinkView } from "@waifucave/clover-protocol";
import type { Clock } from "../clock";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import type { Link, LinkPriority, LinkRequestOptions, LinkStream, LinkTransport } from "../link-transport";

type Handler = (params: unknown, from: string) => unknown | Promise<unknown>;

interface PairState {
  cut: boolean;
  path: LinkPath;
  rttMs: number;
  since?: number;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class FakeLinkNetwork {
  readonly #clock: Clock | undefined;
  readonly #endpoints = new Map<string, FakeLinkTransport>();
  readonly #pairs = new Map<string, PairState>();
  readonly #isolated = new Set<string>();
  #streamSeq = 0;

  constructor(opts: { clock?: Clock } = {}) {
    this.#clock = opts.clock;
  }

  /** A device's transport; the same one each time for the same id. */
  endpoint(device: string): FakeLinkTransport {
    let t = this.#endpoints.get(device);
    if (!t) {
      t = new FakeLinkTransport(device, this);
      this.#endpoints.set(device, t);
    }
    return t;
  }

  /** Cuts `a` from `b`, or from every device when `b` is left out. Requests in flight fail `offline`. */
  partition(a: string, b?: string): void {
    if (b === undefined) this.#isolated.add(a);
    else this.#pair(a, b).cut = true;
    this.#refresh();
  }

  /** Restores what `partition` cut; links re-dial by themselves. */
  heal(a: string, b?: string): void {
    if (b === undefined) this.#isolated.delete(a);
    else this.#pair(a, b).cut = false;
    this.#refresh();
  }

  setPath(a: string, b: string, path: LinkPath, rttMs = 1): void {
    const p = this.#pair(a, b);
    p.path = path;
    p.rttMs = rttMs;
    this.#refresh();
  }

  /** @internal */
  reachable(a: string, b: string): boolean {
    const ea = this.#endpoints.get(a);
    const eb = this.#endpoints.get(b);
    if (!ea || !eb || ea.closed || eb.closed) return false;
    if (this.#isolated.has(a) || this.#isolated.has(b)) return false;
    return !this.#pair(a, b).cut;
  }

  /** @internal */
  pairView(a: string, b: string): Omit<LinkView, "peer"> {
    const p = this.#pair(a, b);
    const up = this.reachable(a, b);
    return { up, ...(up ? { path: p.path, rttMs: p.rttMs } : {}), ...(p.since === undefined ? {} : { since: p.since }) };
  }

  /** @internal */
  peer(device: string): FakeLinkTransport | undefined {
    return this.#endpoints.get(device);
  }

  /** @internal */
  now(): number {
    return this.#clock?.now() ?? Date.now();
  }

  /** @internal */
  clock(): Clock | undefined {
    return this.#clock;
  }

  /** @internal */
  nextStreamId(): string {
    return `st_${++this.#streamSeq}`;
  }

  /** @internal */
  refresh(): void {
    this.#refresh();
  }

  #pair(a: string, b: string): PairState {
    const k = pairKey(a, b);
    let p = this.#pairs.get(k);
    if (!p) {
      p = { cut: false, path: "lan", rttMs: 1 };
      this.#pairs.set(k, p);
    }
    return p;
  }

  #refresh(): void {
    for (const t of this.#endpoints.values()) t.refresh();
  }
}

interface Pending {
  reject: (err: Error) => void;
}

export class FakeLinkTransport implements LinkTransport {
  readonly self: string;
  readonly #net: FakeLinkNetwork;
  readonly #links = new Map<string, FakeLink>();
  readonly #handlers = new Map<string, Handler>();
  readonly #notify = new Map<string, Listeners<{ params: unknown; from: string }>>();
  readonly #streamHandlers = new Map<string, (stream: LinkStream, meta: unknown, from: string) => void>();
  readonly #watchers = new Listeners<LinkView>();
  #closed = false;
  /** How often the OS reported a network change or wake. */
  networkChanges = 0;

  constructor(self: string, net: FakeLinkNetwork) {
    this.self = self;
    this.#net = net;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async connect(peer: string, opts: { signal?: AbortSignal } = {}): Promise<Link> {
    if (this.#closed) throw new ContractError("closed", "this transport is closed");
    if (opts.signal?.aborted) throw new ContractError("cancelled", "the dial was cancelled");
    if (peer === this.self) throw new ContractError("invalid", "a device has no link to itself");
    if (!this.#net.reachable(this.self, peer)) throw new ContractError("offline", `${peer} can't be reached`, { peer });
    const link = this.linkTo(peer);
    this.#net.peer(peer)!.linkTo(this.self);
    this.#net.refresh();
    return link;
  }

  handle(method: string, fn: Handler): Unsubscribe {
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
    this.networkChanges++;
    this.#net.refresh();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#net.refresh();
  }

  /** @internal The one link object for a peer. */
  linkTo(peer: string): FakeLink {
    let l = this.#links.get(peer);
    if (!l) {
      l = new FakeLink(this.self, peer, this.#net);
      this.#links.set(peer, l);
    }
    return l;
  }

  /** @internal */
  refresh(): void {
    for (const l of this.#links.values()) {
      const before = l.lastUp;
      const view = l.view();
      if (before !== view.up) {
        l.lastUp = view.up;
        if (!view.up) l.dropped();
        this.#watchers.emit(view);
      }
    }
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
  acceptStream(stream: FakeLinkStream, meta: unknown, from: string): boolean {
    const fn = this.#streamHandlers.get(stream.label);
    if (!fn) return false;
    fn(stream, meta, from);
    return true;
  }
}

class FakeLink implements Link {
  readonly peer: string;
  readonly #self: string;
  readonly #net: FakeLinkNetwork;
  readonly #pending = new Set<Pending>();
  readonly streams = new Set<FakeLinkStream>();
  lastUp = false;
  /** The priority each request and notification asked for, in order (the fake records, it doesn't schedule). */
  readonly priorities: LinkPriority[] = [];

  constructor(self: string, peer: string, net: FakeLinkNetwork) {
    this.#self = self;
    this.peer = peer;
    this.#net = net;
  }

  view(): LinkView {
    return { peer: this.peer, ...this.#net.pairView(this.#self, this.peer) };
  }

  request<R = unknown>(method: string, params: unknown, opts: LinkRequestOptions = {}): Promise<R> {
    this.priorities.push(opts.priority ?? "control");
    if (!this.#net.reachable(this.#self, this.peer)) return Promise.reject(new ContractError("offline", `${this.peer} can't be reached`, { peer: this.peer }));
    if (opts.signal?.aborted) return Promise.reject(new ContractError("cancelled", "the request was cancelled"));
    const payload = structuredClone(params);
    return new Promise<R>((resolve, reject) => {
      const clock = this.#net.clock();
      let timer: ReturnType<Clock["setTimeout"]> | undefined;
      const p: Pending = {
        reject: (err) => {
          if (!this.#pending.delete(p)) return;
          if (timer && clock) clock.clearTimeout(timer);
          reject(err);
        },
      };
      this.#pending.add(p);
      if (opts.timeoutMs !== undefined && clock) {
        timer = clock.setTimeout(() => p.reject(new ContractError("timeout", `\`${method}\` to ${this.peer} ran past ${opts.timeoutMs} ms`)), opts.timeoutMs);
      }
      opts.signal?.addEventListener("abort", () => p.reject(new ContractError("cancelled", "the request was cancelled")), { once: true });
      queueMicrotask(() => {
        const target = this.#net.peer(this.peer);
        if (!target || !this.#net.reachable(this.#self, this.peer)) {
          p.reject(new ContractError("offline", `${this.peer} can't be reached`, { peer: this.peer }));
          return;
        }
        Promise.resolve()
          .then(() => target.serve(method, payload, this.#self))
          .then(
            (result) => {
              const copy = structuredClone(result);
              queueMicrotask(() => {
                if (!this.#pending.delete(p)) return;
                if (timer && clock) clock.clearTimeout(timer);
                if (!this.#net.reachable(this.#self, this.peer)) reject(new ContractError("offline", `${this.peer} can't be reached`, { peer: this.peer }));
                else resolve(copy as R);
              });
            },
            (err: unknown) => {
              const wire = err instanceof ContractError ? err.toJSON() : { code: "failed", message: err instanceof Error ? err.message : String(err) };
              queueMicrotask(() => p.reject(ContractError.fromJSON(wire)));
            },
          );
      });
    });
  }

  notify(method: string, params: unknown, opts: { priority?: LinkPriority } = {}): void {
    this.priorities.push(opts.priority ?? "control");
    if (!this.#net.reachable(this.#self, this.peer)) return; // a notification to an unreachable peer is dropped
    const payload = structuredClone(params);
    queueMicrotask(() => {
      if (this.#net.reachable(this.#self, this.peer)) this.#net.peer(this.peer)?.deliverNotify(method, payload, this.#self);
    });
  }

  openStream(label: string, priority: LinkPriority, meta?: unknown): LinkStream {
    if (!this.#net.reachable(this.#self, this.peer)) throw new ContractError("offline", `${this.peer} can't be reached`, { peer: this.peer });
    const id = this.#net.nextStreamId();
    const mine = new FakeLinkStream(id, label, priority);
    const theirs = new FakeLinkStream(id, label, priority);
    mine.other = theirs;
    theirs.other = mine;
    this.streams.add(mine);
    const peerLink = this.#net.peer(this.peer)!.linkTo(this.#self);
    peerLink.streams.add(theirs);
    const copy = structuredClone(meta);
    queueMicrotask(() => {
      const target = this.#net.peer(this.peer);
      if (!target?.acceptStream(theirs, copy, this.#self)) mine.finish(new ContractError("not_found", `${this.peer} takes no \`${label}\` streams`));
    });
    return mine;
  }

  /** @internal The path went down: requests in flight and open streams fail `offline`. */
  dropped(): void {
    const err = new ContractError("offline", `${this.peer} can't be reached`, { peer: this.peer });
    for (const p of [...this.#pending]) p.reject(err);
    for (const s of [...this.streams]) s.finish(err);
    this.streams.clear();
  }
}

class FakeLinkStream implements LinkStream {
  readonly id: string;
  readonly label: string;
  readonly priority: LinkPriority;
  other?: FakeLinkStream;
  readonly #data = new Listeners<Uint8Array>();
  readonly #end = new Listeners<Error | undefined>();
  readonly #buffered: Uint8Array[] = [];
  #open = true;
  #ended = false;
  #endError: Error | undefined;

  constructor(id: string, label: string, priority: LinkPriority) {
    this.id = id;
    this.label = label;
    this.priority = priority;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.#open) throw this.#endError ?? new ContractError("closed", "the stream has ended");
    const copy = chunk.slice();
    const other = this.other;
    queueMicrotask(() => other?.receive(copy));
  }

  /** Closes the stream for both sides, after the data already written. */
  end(): void {
    if (!this.#open) return;
    this.#open = false;
    const other = this.other;
    queueMicrotask(() => other?.finish(undefined));
    this.finish(undefined);
  }

  abort(reason = "aborted"): void {
    if (!this.#open) return;
    const err = new ContractError("closed", `the stream was aborted: ${reason}`);
    this.#open = false;
    const other = this.other;
    queueMicrotask(() => other?.finish(err));
    this.finish(err);
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
  receive(chunk: Uint8Array): void {
    if (this.#ended) return;
    if (this.#data.size === 0) this.#buffered.push(chunk);
    else this.#data.emit(chunk);
  }

  /** @internal Ends this side, with the error that cut it, if any. */
  finish(err: Error | undefined): void {
    if (this.#ended) return;
    this.#open = false;
    this.#ended = true;
    this.#endError = err;
    this.#end.emit(err);
  }
}
