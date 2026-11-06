// The main computer, kept (spec §6.4 "The main computer", "The main holds a lease", "Fencing the old main", "While the
// main is offline", "When the main returns", "Sleep"; §3.1 "Hand over and quit"). One per daemon, over this device's
// lease (lease.ts), the main choice (main-choice.ts) and its links.
//
// * **The holder renews** every third of the TTL, and retries quickly while the handshake can't be reached. Past its
//   deadline it acts on only while no other computer could take over, or while it has a live link to each one that
//   could (`mayOutlast`); a renew refused because the record lapsed meanwhile takes the lease again if it is free.
// * **The others read** the record when it is due to run out, and take over when it lapsed, in this order:
//   1. the main takes it at once;
//   2. a computer linked to the main asks the main to take it (`link.lease.take`), and waits a moment;
//   3. a computer takes it only after failing to reach the last holder over every link, relays included; a holder
//      that answers is alive but cut off from the handshake, so taking over would split the main;
//   4. the computer the user is using goes first; the rest wait a few seconds (`takeoverDelayMs`), so when the user is
//      on a phone, on the web page or away, the first computer to take it wins.
// * **When the main returns** while another computer holds the lease, that computer asks the main whether it can take
//   the lease (it reaches the handshake), then hands the bots back between turns (lane D's `BotService.handBack`, the
//   `handBack` hook: no new turn starts, the running one ends, the lease goes), and tells the main to take it.
// * **The user's choice** (`chooseSelf`): this computer becomes the main; a holder that can be reached hands back
//   between turns, one that can't loses the lease to a takeover with a new epoch.
// * **Hand over** (`handOver`: Hand over and quit, a laptop's sleep): the lease goes at once to a computer that is on,
//   the main first, which is told to take it; with none, the bots stay here until this one is back.
// * **A wake** (`wake`): nothing is acted on until a renew succeeds, and every link re-dials.
// * **The fencing token:** a peer's hello that names a newer epoch makes this device read the record again.
import type { Clock, TimerHandle } from "../contracts/clock";
import { ContractError, isContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type { DeviceRecord } from "../contracts/device-registry";
import type { LinkTransport } from "../contracts/link-transport";
import type { LeaseState } from "../contracts/lease";
import { MainLease } from "./lease";
import type { MainChoice } from "./main-choice";

/** The link's own messages for the lease (they never leave the link; not protocol methods). */
export const LEASE_LINK = {
  /** request → `{ready}`: can the receiver take the lease now (it reaches the handshake)? */
  ready: "link.lease.ready",
  /** notify: take the lease now if it's free (a hand-over, a hand-back, or a nudge to the main). */
  take: "link.lease.take",
  /** request `{at?}` → `{ok}`, from the main: hand the bots back between turns. `at` carries the sender's claim to be
   *  the main the user just chose, so the ask doesn't race the claim. */
  handBack: "link.lease.handBack",
  /** notify `{at}`: the sender is the main the user chose, since `at`. */
  main: "link.lease.main",
} as const;

export interface LeaseCoordinatorOptions {
  self: string;
  lease: MainLease;
  choice: MainChoice;
  registry: { list(): DeviceRecord[]; get(id: string): DeviceRecord | undefined };
  transport: Pick<LinkTransport, "connect" | "links" | "watch" | "handle" | "onNotify" | "networkChanged">;
  clock: Clock;
  /** Whether the user is using this computer now (the app's last input; lane E). */
  userActive?(): boolean;
  /** Lane D's `BotService.handBack`: no new turn, the running one ends, then it releases the lease. Without it the
   *  lease is released at once. */
  handBack?(): Promise<void>;
  renewEveryMs?: number;
  /** How often a computer that doesn't hold the lease reads it when nothing is due sooner. */
  readEveryMs?: number;
  /** How long the others wait before taking over, when the user isn't using them. */
  takeoverDelayMs?: number;
  /** How long a nudged main gets to take the lease before the others go on. */
  nudgeWaitMs?: number;
  /** How long to try reaching the last holder over its link before taking over. */
  reachTimeoutMs?: number;
  /** How soon to try again after the handshake didn't answer. */
  retryMs?: number;
  log?(line: string): void;
}

export class LeaseCoordinator {
  readonly lease: MainLease;
  readonly choice: MainChoice;
  readonly #o: LeaseCoordinatorOptions;
  readonly #offs: Unsubscribe[] = [];
  readonly #events = new Listeners<LeaseState>();
  #timer: TimerHandle | undefined;
  #running = false;
  #again = false;
  #closed = false;
  #lastRenew = Number.NEGATIVE_INFINITY;
  #lastRead = Number.NEGATIVE_INFINITY;
  /** A nudge to take it now (from a peer or a hand-over): skip the waits. */
  #takeNow = false;
  #handingBack: Promise<void> | undefined;
  #handBackHook: (() => Promise<void>) | undefined;
  #handBackTriedAt = Number.NEGATIVE_INFINITY;
  /** After a hand-over (a quit or a sleep): don't take the lease back until a wake, or until no one took it. */
  #yieldedAt: number | undefined;
  /** The holder and epoch the main last asked to hand back, so it asks once each. */
  #askedBack = "";

  constructor(o: LeaseCoordinatorOptions) {
    this.#o = o;
    this.lease = o.lease;
    this.choice = o.choice;
    this.#handBackHook = o.handBack;
    const t = o.transport;
    this.#offs.push(this.lease.watch((s) => {
      this.#events.emit(s);
      this.#kick();
    }));
    this.#offs.push(this.choice.watch(() => {
      this.lease.recheck();
      this.#kick();
    }));
    this.#offs.push(t.watch((v) => {
      this.lease.recheck();
      if (v.up) this.#announceTo(v.peer);
      this.#kick();
    }));
    this.#offs.push(t.handle(LEASE_LINK.ready, async (_p, from) => {
      if (!this.#isComputer(from)) throw new ContractError("refused", "only a paired computer asks");
      await this.lease.refresh().catch(() => undefined);
      // A computer that just handed its bots over (it's quitting or about to sleep) doesn't take them back.
      return { ready: this.lease.reachable && this.#yieldedAt === undefined };
    }));
    this.#offs.push(t.onNotify(LEASE_LINK.take, (_p, from) => {
      if (!this.#isComputer(from)) return;
      this.#log(`${from} asks this computer to take the lease`);
      this.#takeNow = true;
      this.#kick();
    }));
    this.#offs.push(t.handle(LEASE_LINK.handBack, (p, from) => {
      const at = (p as { at?: unknown } | undefined)?.at;
      if (typeof at === "number" && this.#isComputer(from)) this.choice.acceptClaim(from, at);
      if (!this.#isComputer(from) || from !== this.choice.current()) throw new ContractError("refused", "only the main computer asks for the bots back");
      if (!this.lease.holds()) return { ok: false };
      void this.#handBackTo(from);
      return { ok: true };
    }));
    this.#offs.push(t.onNotify(LEASE_LINK.main, (p, from) => {
      const at = (p as { at?: unknown } | undefined)?.at;
      if (typeof at === "number") this.choice.acceptClaim(from, at);
    }));
  }

  /** Lane D's hand-back (`BotService.handBack`), once the bot service exists. */
  setHandBack(fn: (() => Promise<void>) | undefined): void {
    this.#handBackHook = fn;
  }

  /** Starts the loop; reads the record first. */
  start(): void {
    this.#kick();
  }

  state(): LeaseState {
    return this.lease.state();
  }

  watch(fn: (s: LeaseState) => void): Unsubscribe {
    return this.#events.add(fn);
  }

  /** `mayOutlast` for the lease: past its deadline the holder acts on only while no other computer could take over,
   *  or while it has a live link to each one that could (§6.4). A computer that can't be reached might be on. */
  mayOutlast(): boolean {
    const up = new Set(this.#o.transport.links().filter((l) => l.up).map((l) => l.peer));
    return this.#otherComputers().every((d) => up.has(d.id));
  }

  /** The OS reported a wake (or the core noticed one): act on nothing until a renew, and re-dial everything. */
  wake(): void {
    this.#yieldedAt = undefined;
    this.lease.wake();
    this.#o.transport.networkChanged();
    this.#lastRenew = Number.NEGATIVE_INFINITY;
    this.#lastRead = Number.NEGATIVE_INFINITY;
    this.#kick();
  }

  /** A peer's hello named this epoch: if it's newer than any seen, read the record again. */
  peerEpoch(epoch: number): void {
    if (epoch > this.lease.highestEpoch()) {
      this.#lastRead = Number.NEGATIVE_INFINITY;
      this.#kick();
    }
  }

  /** The user made this computer the main one (`main.set` here). */
  async chooseSelf(): Promise<LeaseState> {
    const rec = this.choice.chooseSelf(this.#o.clock.now());
    for (const l of this.#o.transport.links()) if (l.up) this.#announceTo(l.peer, rec.at);
    await this.lease.refresh().catch(() => undefined);
    const k = this.lease.known();
    const live = k.holderRaw !== null && k.expiresAt !== null && this.#o.clock.now() < k.expiresAt;
    if (live && k.holder !== this.#o.self) {
      const holder = k.holder;
      if (holder && this.#linkUp(holder)) {
        // Between turns: the holder hands back and tells this computer to take it.
        try {
          const link = await this.#o.transport.connect(holder);
          const r = await link.request<{ ok?: boolean }>(LEASE_LINK.handBack, { at: rec.at }, { timeoutMs: 10_000 });
          if (r?.ok) return this.lease.state();
        } catch {
          // Not reached after all: the user's choice takes it.
        }
      }
      return this.lease.takeOver();
    }
    if (!live || k.holder !== this.#o.self) {
      try {
        // With no handshake to ask, the user's own choice is the takeover (lease.ts).
        return await this.lease.acquire(this.lease.hasScope() ? {} : { byUser: true });
      } catch (err) {
        if (!isContractError(err, "not_main")) throw err;
        return this.lease.takeOver();
      }
    }
    return this.lease.state();
  }

  /** Hand over and quit, or a laptop main about to sleep: the lease goes at once to a computer that is on (the main
   *  first), which is told to take it. With none on, this computer keeps it and the bots stay here. */
  async handOver(): Promise<{ to: string | null }> {
    if (!this.lease.holds()) return { to: null };
    const up = new Set(this.#o.transport.links().filter((l) => l.up).map((l) => l.peer));
    const others = this.#otherComputers().filter((d) => up.has(d.id)).map((d) => d.id).sort();
    if (others.length === 0) return { to: null };
    const main = this.choice.current();
    const to = main !== null && others.includes(main) ? main : others[0]!;
    this.#yieldedAt = this.#o.clock.monotonic();
    this.lease.setHandingOver(true);
    try {
      await this.lease.release();
    } finally {
      this.lease.setHandingOver(false);
    }
    this.#notify(to, LEASE_LINK.take);
    this.#log(`handed the lease over to ${to}`);
    return { to };
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) this.#o.clock.clearTimeout(this.#timer);
    for (const off of this.#offs.splice(0)) off();
    this.lease.close();
  }

  // ---- the loop ----

  #kick(delay = 0): void {
    if (this.#closed) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    if (this.#timer) this.#o.clock.clearTimeout(this.#timer);
    this.#timer = this.#o.clock.setTimeout(() => void this.#run(), delay);
  }

  async #run(): Promise<void> {
    if (this.#closed || this.#running) return;
    this.#running = true;
    let next: number;
    try {
      next = await this.#step();
    } catch (err) {
      this.#log(`the lease's step failed: ${err instanceof Error ? err.message : String(err)}`);
      next = this.#retryMs;
    } finally {
      this.#running = false;
    }
    if (this.#closed) return;
    if (this.#again) {
      this.#again = false;
      next = 0;
    }
    if (this.#timer) this.#o.clock.clearTimeout(this.#timer);
    this.#timer = this.#o.clock.setTimeout(() => void this.#run(), Math.max(0, next));
  }

  get #renewEvery(): number {
    return this.#o.renewEveryMs ?? Math.floor(this.lease.ttlMs / 3);
  }

  get #retryMs(): number {
    return this.#o.retryMs ?? 2_000;
  }

  /** One pass; how long until the next. */
  async #step(): Promise<number> {
    const mono = this.#o.clock.monotonic();
    const lease = this.lease;
    if (this.#closed) return this.#renewEvery;

    // With no handshake to ask: a lone computer is the main by itself, the user's own takeover (lease.ts).
    if (!this.#hasScope()) {
      if (!lease.holds() && this.#otherComputers().length === 0) await lease.acquire({ byUser: true }).catch(() => undefined);
      return this.#o.readEveryMs ?? 15_000;
    }

    if (lease.holds()) {
      if (mono - this.#lastRenew >= this.#renewEvery || !lease.canAct()) {
        try {
          await lease.renew();
          this.#lastRenew = mono;
        } catch (err) {
          if (isContractError(err, "offline")) return this.#retryMs;
          if (isContractError(err, "not_main")) {
            // Refused: another computer holds it, or it lapsed while this one acted on through an exception.
            const k = lease.known();
            const free = k.holderRaw === null || k.expiresAt === null || this.#o.clock.now() >= k.expiresAt;
            if (free) await lease.acquire().then(() => (this.#lastRenew = mono)).catch(() => undefined);
          } else throw err;
        }
      }
      if (lease.holds()) {
        await this.#maybeHandBack();
        return this.#renewEvery;
      }
    }

    // Not the holder.
    if (mono - this.#lastRead >= (this.#o.readEveryMs ?? 15_000) || this.#takeNow || this.#due()) {
      try {
        await lease.refresh();
        this.#lastRead = mono;
      } catch {
        return this.#retryMs;
      }
    }
    const k = lease.known();
    const now = this.#o.clock.now();
    const live = k.holderRaw !== null && k.expiresAt !== null && now < k.expiresAt;
    if (live) {
      this.#takeNow = false;
      if (this.choice.isSelf() && k.holder !== null && k.holder !== this.#o.self) await this.#askBack(k.holder, k.epoch);
      // Read again as it's due to run out.
      return Math.min(this.#o.readEveryMs ?? 15_000, Math.max(250, k.expiresAt! - now + 250));
    }
    await this.#considerTakeover(k.holder);
    return lease.holds() ? this.#renewEvery : (this.#o.readEveryMs ?? 15_000);
  }

  /** Whether the known record is due to run out now. */
  #due(): boolean {
    const k = this.lease.known();
    return k.expiresAt !== null && this.#o.clock.now() >= k.expiresAt;
  }

  async #considerTakeover(lastHolder: string | null): Promise<void> {
    const lease = this.lease;
    const takeNow = this.#takeNow;
    this.#takeNow = false;
    if (this.#yieldedAt !== undefined) {
      // Handed over: the bots went to another computer. Only if none took them in two leases' time does this one.
      if (this.#o.clock.monotonic() - this.#yieldedAt < 2 * lease.ttlMs) return;
      this.#yieldedAt = undefined;
    }
    if (this.choice.isSelf() || takeNow) {
      await lease.acquire().catch(() => undefined);
      return;
    }
    const main = this.choice.current();
    if (main !== null && main !== this.#o.self && this.#linkUp(main)) {
      this.#notify(main, LEASE_LINK.take);
      if (await this.#waitTaken(this.#o.nudgeWaitMs ?? 2_000)) return;
    }
    if (lastHolder !== null && lastHolder !== this.#o.self && (await this.#reachable(lastHolder))) {
      this.#log(`the lease lapsed but ${lastHolder} answers over its link: not taking over`);
      return;
    }
    if (!(this.#o.userActive?.() ?? false)) {
      if (await this.#waitTaken(this.#o.takeoverDelayMs ?? 3_000)) return;
    }
    try {
      await lease.acquire();
      this.#log(`took the lease over (epoch ${lease.state().epoch})`);
    } catch {
      // Another computer took it first, or the handshake didn't answer.
    }
  }

  /** Waits up to `ms`, reading the record at the end; true when someone holds it by then. */
  async #waitTaken(ms: number): Promise<boolean> {
    await new Promise<void>((resolve) => this.#o.clock.setTimeout(resolve, ms));
    if (this.#closed) return true;
    try {
      await this.lease.refresh();
    } catch {
      return false;
    }
    const k = this.lease.known();
    return k.holderRaw !== null && k.expiresAt !== null && this.#o.clock.now() < k.expiresAt;
  }

  /** The holder isn't the main and the main is back: hand the bots back between turns, if the main can take them. */
  async #maybeHandBack(): Promise<void> {
    const main = this.choice.current();
    if (main === null || main === this.#o.self || !this.#linkUp(main) || this.#handingBack) return;
    if (this.#o.clock.monotonic() - this.#handBackTriedAt < 30_000) return;
    void this.#handBackTo(main);
  }

  #handBackTo(main: string): Promise<void> {
    if (this.#handingBack) return this.#handingBack;
    this.#handBackTriedAt = this.#o.clock.monotonic();
    this.#handingBack = (async () => {
      try {
        const link = await this.#o.transport.connect(main);
        const r = await link.request<{ ready?: boolean }>(LEASE_LINK.ready, {}, { timeoutMs: 10_000 });
        if (!r?.ready) return;
        this.lease.setHandingOver(true);
        if (this.#handBackHook) await this.#handBackHook();
        else await this.lease.release();
        this.lease.setHandingOver(false);
        if (!this.lease.holds()) {
          this.#notify(main, LEASE_LINK.take);
          this.#log(`handed the bots back to ${main}`);
        }
      } catch (err) {
        this.lease.setHandingOver(false);
        this.#log(`handing the bots back to ${main} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.#handingBack = undefined;
        this.#kick();
      }
    })();
    return this.#handingBack;
  }

  /** This computer is the main and another holds the lease: ask it, once per holder and epoch, to hand back. */
  async #askBack(holder: string, epoch: number): Promise<void> {
    const key = `${holder}@${epoch}`;
    if (this.#askedBack === key || !this.#linkUp(holder)) return;
    this.#askedBack = key;
    try {
      const link = await this.#o.transport.connect(holder);
      await link.request(LEASE_LINK.handBack, {}, { timeoutMs: 10_000 });
    } catch {
      // It hands back by itself when it sees this computer's link (`#maybeHandBack`).
    }
  }

  // ---- helpers ----

  #hasScope(): boolean {
    return this.lease.hasScope();
  }

  #isComputer(id: string): boolean {
    const d = this.#o.registry.get(id);
    return d !== undefined && d.runsCore && d.revokedAt === undefined && id !== this.#o.self;
  }

  #otherComputers(): DeviceRecord[] {
    return this.#o.registry.list().filter((d) => d.runsCore && d.revokedAt === undefined && d.id !== this.#o.self);
  }

  #linkUp(peer: string): boolean {
    return this.#o.transport.links().some((l) => l.peer === peer && l.up);
  }

  /** Whether `peer` answers over its link within the reach timeout: every path the link has, relays included. */
  async #reachable(peer: string): Promise<boolean> {
    if (this.#linkUp(peer)) return true;
    const abort = new AbortController();
    const timer = this.#o.clock.setTimeout(() => abort.abort(), this.#o.reachTimeoutMs ?? 3_000);
    try {
      await this.#o.transport.connect(peer, { signal: abort.signal });
      return true;
    } catch {
      return false;
    } finally {
      this.#o.clock.clearTimeout(timer);
    }
  }

  #notify(peer: string, method: string, params: unknown = {}): void {
    void this.#o.transport.connect(peer).then((l) => l.notify(method, params)).catch(() => undefined);
  }

  /** Tells a peer this computer is the main the user chose, when it is. */
  #announceTo(peer: string, at?: number): void {
    const r = this.choice.record();
    if (!r || r.via !== "user" || r.device !== this.#o.self || !this.#isComputer(peer)) return;
    this.#notify(peer, LEASE_LINK.main, { at: at ?? r.at });
  }

  #log(line: string): void {
    this.#o.log?.(`[lease] ${line}`);
  }
}
