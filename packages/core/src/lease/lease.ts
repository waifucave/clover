// The main computer's lease on this device (spec §6.4 "The main holds a lease", "Fencing the old main"; the contract in
// contracts/lease.ts, whose conformance suite this passes). It is the device's view of the one lease record the
// handshake keeps for its scope (scope.ts): the account's, or the group's for account-less devices (decision 85).
//
// What it decides by itself:
// * **Whether this device may act** (`canAct`), from its own sleep-counting monotonic clock only: the moment it sent
//   its last acquire or renew that the service granted, plus the TTL, minus the margin for clock error. Never from
//   shared or wall time. After a wake, nothing until a renew succeeds.
// * **The spec's exceptions to fencing** (`mayOutlast`): past its deadline, a holder that can't renew keeps acting
//   only while no other computer could take over, or while it has had a live link to each one that could since
//   before the deadline passed (a link that came back later may be to a computer that took over meanwhile). The
//   coordinator answers that from the links (coordinator.ts).
// * **A newer epoch from a peer** (its hello, or the announcement each computer sends its links of every new epoch it
//   learns, coordinator.ts) is a claim that another computer may hold a later lease in the same scope. Before its
//   deadline the holder acts on (its lease is the service's word) and only reads the record; past its deadline, acting
//   through the exception, an open claim stops it (H-M2's checks 3 to 6, L3 to L8). Newer means newer than the newest
//   the service has shown this device; a peer's word never raises that. A service answer to a request sent after a
//   claim, showing an older epoch, proves the claim false: that peer's claims are ignored for one TTL (check 6, L8).
// * **The fencing token is (scope, epoch)** (H-M2's review): epochs count within one lease record (the account's, a
//   group's, or this computer's own), so a sign-in or a merge starts a new count. `fence()` is what an act is stamped
//   with; `isStale(epoch, scope)` tells a receiver to refuse an act from an earlier lease: an older epoch in the
//   current scope, or a scope this device has left. A scope it hasn't reached yet is never judged stale (PROTOCOL.md:
//   "peers refuse acts with an epoch older than the newest they have seen").
//
// What it leaves to the coordinator: when to renew, when to read, when to take over, and choosing the main.
//
// With no scope at all (no account and no account-less pair, so no handshake to ask), only the user's own takeover
// acquires (`byUser`), a lease held here alone; the daemon gives a lone computer that.
import type { LeaseView } from "@waifucave/clover-protocol";
import type { Clock, TimerHandle } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type { Lease, LeaseState } from "../contracts/lease";
import type { LeaseScope, ScopeLease } from "./scope";

/** The lease's numbers: a 30 s lease renewed every 10 s, acted on until 5 s before it ends. */
export const LEASE_TTL_MS = 30_000;
export const LEASE_MARGIN_MS = 5_000;

export interface MainLeaseOptions {
  /** This device's id. */
  self: string;
  /** Where the lease is held now; undefined while this device has no account and no group. */
  scope(): LeaseScope | undefined;
  /** Shared time (views) and timers. */
  clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  /** A monotonic clock that counts sleep (boot-clock.ts); the clock's own `monotonic` by default. */
  monotonic?: () => number;
  ttlMs?: number;
  marginMs?: number;
  /** The TTL the request names, in seconds: the TTL's, within the service's 10–300. Tests with a memory service set
   *  a shorter one. */
  ttlSec?: number;
  /** The computer the user chose as main, or the one chosen for them (main-choice.ts). */
  main?: () => string | null;
  /** Past the deadline (on the monotonic clock), whether this holder may still act: no other computer could take
   *  over, or it has had a live link to each one that could since before `deadline`. */
  mayOutlast?: (deadline: number) => boolean;
}

export class MainLease implements Lease {
  readonly self: string;
  readonly ttlMs: number;
  readonly marginMs: number;
  readonly #o: MainLeaseOptions;
  readonly #mono: () => number;
  readonly #listeners = new Listeners<LeaseState>();
  /** The last record the service gave, by any answer or push. */
  #known: ScopeLease = { holder: null, holderRaw: null, epoch: 0, expiresAt: null };
  /** The newest epoch seen, per scope id; and the scopes in the order this device was in them. */
  readonly #highest = new Map<string, number>();
  readonly #scopes: string[] = [];
  #reachable = true;
  /** On the monotonic clock: when this device stops acting on its lease, unless an exception holds. */
  #deadline: number | null = null;
  #woke = false;
  /** Open claims of a newer epoch in this scope, per peer (the newest each named, and when, monotonic). */
  readonly #claims = new Map<string, { epoch: number; at: number }>();
  /** Peers whose claims the service proved false, ignored until (monotonic). */
  readonly #distrust = new Map<string, number>();
  /** The last device the record named as holder (a hand-over's or hand-back's sender, after it released). */
  #lastHolder: string | null = null;
  #handingOver = false;
  /** Releases so far, so a renew in flight across one is not taken as holding. */
  #releases = 0;
  /** A lease held with no handshake (`byUser`, no scope). */
  #local: { epoch: number } | null = null;
  #lastEmitted = "";
  #lapseTimer: TimerHandle | undefined;
  #deadlineTimer: TimerHandle | undefined;

  constructor(o: MainLeaseOptions) {
    this.#o = o;
    this.self = o.self;
    this.ttlMs = o.ttlMs ?? LEASE_TTL_MS;
    this.marginMs = o.marginMs ?? LEASE_MARGIN_MS;
    this.#mono = o.monotonic ?? (() => (o.clock as Clock).monotonic());
  }

  // ---- the contract ----

  state(): LeaseState {
    const main = this.#o.main?.() ?? null;
    if (this.#local) {
      return { main, holder: this.self, epoch: this.#local.epoch, expiresAt: null, refresher: this.self, state: this.#handingOver ? "handing-over" : "held" };
    }
    const k = this.#known;
    const live = k.holderRaw !== null && k.expiresAt !== null && this.#o.clock.now() < k.expiresAt;
    const mine = live && k.holder === this.self;
    let state: LeaseView["state"] = live ? "held" : "lapsed";
    if (!this.#reachable && !mine) state = "unreachable";
    if (this.#handingOver && mine) state = "handing-over";
    return {
      main,
      holder: live ? k.holder : null,
      epoch: k.epoch,
      expiresAt: live ? k.expiresAt : null,
      refresher: live ? k.holder : null,
      state,
    };
  }

  canAct(): boolean {
    if (this.#local) return true;
    if (this.#woke || this.#deadline === null || this.#known.holder !== this.self) return false;
    if (this.#mono() < this.#deadline) return true;
    // Past the deadline, acting only through the exception: a peer's open claim of a later lease stops it.
    if (this.#claimedAbove()) return false;
    return this.#o.mayOutlast?.(this.#deadline) ?? false;
  }

  async acquire(opts: { byUser?: boolean } = {}): Promise<LeaseState> {
    const scope = this.#o.scope();
    if (!scope) {
      if (!opts.byUser) throw new ContractError("refused", "with no account and no account-less pair there is no handshake: taking over is the user's own action");
      this.#local = { epoch: (this.#local?.epoch ?? this.#known.epoch) + (this.#local ? 0 : 1) };
      this.#raise(this.#local.epoch);
      this.#changed();
      return this.state();
    }
    return this.#op(scope, "acquire");
  }

  async renew(): Promise<LeaseState> {
    if (this.#local) return this.state();
    const scope = this.#o.scope();
    if (!scope) throw new ContractError("not_main", "this device doesn't hold the lease");
    return this.#op(scope, "renew");
  }

  /** The user chose this computer (§6.4 `main.set`, PROTOCOL.md `takeover`): it takes the lease whoever holds it,
   *  with a new epoch, so the old holder's acts are refused from then on. */
  async takeOver(): Promise<LeaseState> {
    const scope = this.#o.scope();
    if (!scope) return this.acquire({ byUser: true });
    return this.#op(scope, "takeover");
  }

  async release(): Promise<void> {
    this.#releases++;
    this.#deadline = null;
    if (this.#local) {
      this.#local = null;
      this.#known = { ...this.#known, epoch: Math.max(this.#known.epoch, this.highestEpoch()) };
      this.#changed();
      return;
    }
    const scope = this.#o.scope();
    const k = this.#known;
    if (scope && k.holder === this.self) {
      try {
        this.#observe(await scope.op("release", k.epoch, this.#ttlSec()));
        this.#reachable = true;
      } catch (err) {
        // Refused (someone else holds it now) or unanswered: this device has stopped acting either way, and an
        // unanswered release lapses by itself within the TTL.
        if (err instanceof ContractError && err.code === "conflict") this.#observeConflict(err);
        else if (err instanceof ContractError && err.code === "offline") this.#reachable = false;
      }
    }
    this.#changed();
  }

  wake(): void {
    this.#woke = true;
    this.#changed();
  }

  /** `from` claims `epoch` in `scope` (its hello, or an announcement): newer than the newest the service has shown
   *  this device in this scope, another computer may hold a later lease. Held as an open claim until the service
   *  answers: past its deadline it stops this device acting. An epoch of another scope is never compared, and a peer
   *  whose claim the service lately proved false is ignored. Returns whether the claim is taken (newer, and trusted):
   *  the caller reads the record and passes it on. */
  peerEpoch(epoch: number, scope?: string, from = "a peer"): boolean {
    if (this.#local || (scope !== undefined && scope !== this.scopeId())) return false;
    if (epoch <= this.highestEpoch()) return false;
    const until = this.#distrust.get(from);
    if (until !== undefined) {
      if (this.#mono() < until) return false;
      this.#distrust.delete(from);
    }
    const prev = this.#claims.get(from);
    this.#claims.set(from, { epoch: Math.max(prev?.epoch ?? 0, epoch), at: this.#mono() });
    this.#changed();
    return true;
  }

  /** Whether `from`'s claims are being ignored now. */
  distrusts(from: string): boolean {
    const until = this.#distrust.get(from);
    return until !== undefined && this.#mono() < until;
  }

  #claimedAbove(): boolean {
    const highest = this.highestEpoch();
    for (const c of this.#claims.values()) if (c.epoch > highest) return true;
    return false;
  }

  /** The service answered a request sent at `sent` with `epoch`: a claim it covers is settled, and one made before the
   *  request yet above what it shows was false (epochs only rise at the service), so that peer is ignored a TTL. */
  #settleClaims(epoch: number, sent: number): void {
    for (const [from, c] of this.#claims) {
      if (c.epoch <= epoch) this.#claims.delete(from);
      else if (c.at < sent) {
        this.#claims.delete(from);
        this.#distrust.set(from, this.#mono() + this.ttlMs);
      }
    }
  }

  /** The last device the record named as holder, even once it released. */
  lastHolder(): string | null {
    return this.#lastHolder;
  }

  /** How many group members the service lists that this device can't name (scope.ts). */
  unknownMembers(): number {
    return this.#o.scope()?.unknownMembers?.() ?? 0;
  }

  /** Whether this device (or `device`) may start a new tenure of the lease: in a group, only a member that votes. */
  votes(now: number, device?: string): boolean {
    return this.#o.scope()?.votes?.(now, device) ?? true;
  }

  watch(fn: (state: LeaseState) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  // ---- beyond the contract, for the coordinator ----

  /** The record as the service last gave it. */
  known(): ScopeLease {
    return { ...this.#known };
  }

  /** Whether there is a handshake to ask (an account, or an account-less group). */
  hasScope(): boolean {
    return this.#o.scope() !== undefined;
  }

  /** Whether the last request reached the service. */
  get reachable(): boolean {
    return this.#reachable;
  }

  /** The newest epoch this device has seen: the fencing token's high-water mark. */
  highestEpoch(): number {
    return this.#highest.get(this.scopeId()) ?? 0;
  }

  /** The lease record this device is on now: the scope's id, or `local` for a lone computer's own lease. */
  scopeId(): string {
    return this.#o.scope()?.id ?? "local";
  }

  /** What an act of this computer's is stamped with. */
  fence(): { scope: string; epoch: number } {
    return { scope: this.scopeId(), epoch: this.state().epoch };
  }

  /** Whether an act stamped with `epoch` (and `scope`) comes from an earlier lease than one this device has seen, and
   *  is refused. Without `scope`, the current one. */
  isStale(epoch: number, scope?: string): boolean {
    const now = this.scopeId();
    if (scope === undefined || scope === now) return epoch < (this.#highest.get(now) ?? 0);
    // A scope this device has left is an earlier lease; one it hasn't reached yet isn't judged here.
    return this.#scopes.includes(scope);
  }

  #raise(epoch: number): void {
    const id = this.scopeId();
    if (!this.#scopes.includes(id)) this.#scopes.push(id);
    this.#highest.set(id, Math.max(this.#highest.get(id) ?? 0, epoch));
  }

  /** Whether this device holds the lease by the last record (whether or not it may act on it now). */
  holds(): boolean {
    return this.#local !== null || this.#known.holder === this.self;
  }

  /** Reads the record from the service. */
  async refresh(): Promise<LeaseState> {
    if (this.#local) return this.state();
    const scope = this.#o.scope();
    if (!scope) return this.state();
    try {
      const sent = this.#mono();
      const r = await scope.read();
      this.#observe(r);
      if (r.epoch >= this.#known.epoch) this.#settleClaims(r.epoch, sent);
      this.#reachable = true;
    } catch (err) {
      if (err instanceof ContractError && err.code === "offline") this.#reachable = false;
      this.#changed();
      throw err;
    }
    this.#changed();
    return this.state();
  }

  /** A record the service pushed (the scope's socket, or a peer's word over the link with the service's own record). */
  observe(record: ScopeLease): void {
    this.#observe(record);
    this.#changed();
  }

  /** The service could (true) or couldn't (false) be reached, as some other request found. */
  setReachable(reachable: boolean): void {
    if (this.#reachable === reachable) return;
    this.#reachable = reachable;
    this.#changed();
  }

  /** While a hand-over or hand-back runs here, the view says `handing-over`. */
  setHandingOver(on: boolean): void {
    this.#handingOver = on;
    this.#changed();
  }

  /** The scope changed (a sign-in, a sign-out, a group merge): what was known about the old one no longer holds. */
  scopeChanged(): void {
    // The new scope counts from its own record; the old one is now a scope this device has left.
    const id = this.scopeId();
    if (!this.#scopes.includes(id)) this.#scopes.push(id);
    else this.#scopes.push(...this.#scopes.splice(this.#scopes.indexOf(id), 1));
    this.#deadline = null;
    this.#known = { holder: null, holderRaw: null, epoch: 0, expiresAt: null };
    this.#lastHolder = null;
    this.#claims.clear();
    this.#local = null;
    this.#changed();
  }

  /** Something `canAct` reads from outside changed (the links, for `mayOutlast`): tells watchers if it moved. */
  recheck(): void {
    this.#changed();
  }

  close(): void {
    if (this.#lapseTimer) this.#o.clock.clearTimeout(this.#lapseTimer);
    if (this.#deadlineTimer) this.#o.clock.clearTimeout(this.#deadlineTimer);
  }

  // ---- inside ----

  #ttlSec(): number {
    return this.#o.ttlSec ?? Math.min(300, Math.max(10, Math.round(this.ttlMs / 1000)));
  }

  async #op(scope: LeaseScope, op: "acquire" | "renew" | "takeover"): Promise<LeaseState> {
    const sent = this.#mono();
    const releases = this.#releases;
    let record: ScopeLease;
    try {
      record = await scope.op(op, this.#known.epoch, this.#ttlSec());
    } catch (err) {
      if (err instanceof ContractError && err.code === "conflict") {
        this.#reachable = true;
        this.#observeConflict(err);
        this.#settleClaims(this.#known.epoch, sent);
        this.#changed();
        const holder = this.#known.holder ?? "another device";
        throw new ContractError("not_main", op === "renew" ? "this device doesn't hold the lease" : `${holder} holds the lease until ${this.#known.expiresAt}`);
      }
      if (err instanceof ContractError && err.code === "offline") {
        this.#reachable = false;
        this.#changed();
      }
      throw err;
    }
    this.#reachable = true;
    if (this.#releases !== releases) {
      // A renew answered after this device released (a hand-over racing the renew loop): the service took the
      // release after the renew, or refused the renew, so the record is free; the renew's answer must not make this
      // device the holder again.
      if (op === "renew") return this.state();
      // An acquire (or takeover) answered after a release: the service gave this device the lease after it let go,
      // so it gives it back rather than hold it unasked.
      if (record.holder === this.self) {
        this.#observe(record);
        await this.release();
        return this.state();
      }
    }
    this.#observe(record);
    this.#settleClaims(record.epoch, sent);
    if (record.holder === this.self) {
      this.#deadline = sent + this.ttlMs - this.marginMs;
      this.#woke = false;
      this.#armDeadline();
    }
    this.#changed();
    return this.state();
  }

  #observeConflict(err: ContractError): void {
    const lease = (err.detail as { lease?: ScopeLease } | undefined)?.lease;
    if (lease) this.#observe(lease);
  }

  #observe(r: ScopeLease): void {
    // Never step back to an older record (a read that crossed a newer push).
    if (r.epoch < this.#known.epoch) return;
    this.#known = { ...r };
    if (r.holder !== null) this.#lastHolder = r.holder;
    this.#raise(r.epoch);
    if (r.holder !== this.self) this.#deadline = null;
    this.#armLapse();
  }

  /** Tells watchers when the known record runs out unrenewed. */
  #armLapse(): void {
    if (this.#lapseTimer) this.#o.clock.clearTimeout(this.#lapseTimer);
    this.#lapseTimer = undefined;
    const at = this.#known.expiresAt;
    if (at === null) return;
    this.#lapseTimer = this.#o.clock.setTimeout(() => this.#changed(), Math.max(0, at - this.#o.clock.now()));
  }

  /** Tells watchers when this device stops being allowed to act. */
  #armDeadline(): void {
    if (this.#deadlineTimer) this.#o.clock.clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = undefined;
    if (this.#deadline === null) return;
    this.#deadlineTimer = this.#o.clock.setTimeout(() => this.#changed(), Math.max(0, this.#deadline - this.#mono()));
  }

  #changed(): void {
    const s = this.state();
    const key = JSON.stringify([s, this.canAct()]);
    if (key === this.#lastEmitted) return;
    this.#lastEmitted = key;
    this.#listeners.emit(s);
  }
}
