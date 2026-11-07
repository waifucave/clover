// FakeLeaseAuthority: the waifucave handshake's lease, in memory, on a shared fake clock. Each device gets a Lease
// over it, with its own clock offset (`lease(device, { offsetMs })`), so a device's wall clock can be wrong; `cutOff`
// makes the handshake unreachable from one device, as a main that loses the internet would see. Without an account
// (`account: false`) the lease is the account-less devices' group's record at the handshake (item 85), which acts the
// same; `byUser` marks the user's own takeover.
import type { LeaseView } from "@waifucave/clover-protocol";
import type { Clock, TimerHandle } from "../clock";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import type { Lease, LeaseState } from "../lease";

/** The fake's numbers; lane H picks the real ones. */
export const FAKE_LEASE_TTL_MS = 30_000;
export const FAKE_LEASE_MARGIN_MS = 5_000;

export class FakeLeaseAuthority {
  readonly #clock: Clock;
  readonly ttlMs: number;
  readonly marginMs: number;
  #holder: string | null = null;
  #epoch = 0;
  #expiresAt: number | null = null;
  #main: string | null;
  readonly #cutOff = new Set<string>();
  readonly #listeners = new Listeners<void>();
  #lapseTimer: TimerHandle | undefined;
  readonly #account: boolean;

  constructor(opts: { clock: Clock; main?: string; ttlMs?: number; marginMs?: number; account?: boolean }) {
    this.#clock = opts.clock;
    this.#main = opts.main ?? null;
    this.ttlMs = opts.ttlMs ?? FAKE_LEASE_TTL_MS;
    this.marginMs = opts.marginMs ?? FAKE_LEASE_MARGIN_MS;
    this.#account = opts.account ?? true;
  }

  /** A device's lease; `offsetMs` is how far its wall clock is off, which `canAct` must not care about. */
  lease(device: string, opts: { offsetMs?: number } = {}): FakeLease {
    return new FakeLease(device, this, this.#clock, opts.offsetMs ?? 0);
  }

  /** The computer the user chose as main (§6.4). */
  setMain(device: string | null): void {
    this.#main = device;
    this.#listeners.emit();
  }

  /** The handshake can't be reached from `device` (true), or can again (false). */
  cutOff(device: string, cut = true): void {
    if (cut) this.#cutOff.add(device);
    else this.#cutOff.delete(device);
    this.#listeners.emit();
  }

  /** @internal */
  view(device: string): LeaseView {
    const now = this.#clock.now();
    const live = this.#holder !== null && this.#expiresAt !== null && now < this.#expiresAt;
    let state: LeaseView["state"] = live ? "held" : "lapsed";
    if (this.#cutOff.has(device) && this.#holder !== device) state = "unreachable";
    return {
      main: this.#main,
      holder: live ? this.#holder : null,
      epoch: this.#epoch,
      expiresAt: live ? this.#expiresAt : null,
      refresher: live ? this.#holder : null,
      state,
    };
  }

  /** @internal */
  acquire(device: string, byUser = false): void {
    if (this.#cutOff.has(device)) throw new ContractError("offline", "the handshake can't be reached");
    const now = this.#clock.now();
    const live = this.#holder !== null && this.#expiresAt !== null && now < this.#expiresAt;
    if (live && this.#holder !== device) throw new ContractError("not_main", `${this.#holder} holds the lease until ${this.#expiresAt}`);
    if (!live || this.#holder !== device) this.#epoch += 1;
    this.#holder = device;
    this.#expiresAt = now + this.ttlMs;
    this.#armLapse();
    this.#listeners.emit();
  }

  /** @internal */
  renew(device: string): void {
    if (this.#cutOff.has(device)) throw new ContractError("offline", "the handshake can't be reached");
    const now = this.#clock.now();
    if (this.#holder !== device || this.#expiresAt === null || now >= this.#expiresAt) throw new ContractError("not_main", "this device doesn't hold the lease");
    this.#expiresAt = now + this.ttlMs;
    this.#armLapse();
    this.#listeners.emit();
  }

  /** @internal */
  release(device: string): void {
    if (this.#holder !== device) return;
    this.#holder = null;
    this.#expiresAt = null;
    if (this.#lapseTimer) this.#clock.clearTimeout(this.#lapseTimer);
    this.#listeners.emit();
  }

  /** Tells watchers when the lease lapses unrenewed. */
  #armLapse(): void {
    if (this.#lapseTimer) this.#clock.clearTimeout(this.#lapseTimer);
    this.#lapseTimer = this.#clock.setTimeout(() => this.#listeners.emit(), this.ttlMs);
  }

  /** @internal */
  onChange(fn: () => void): Unsubscribe {
    return this.#listeners.add(fn);
  }
}

export class FakeLease implements Lease {
  readonly self: string;
  readonly #authority: FakeLeaseAuthority;
  readonly #clock: Clock;
  /** How far this device's wall clock is off; only what it shows uses it. */
  readonly offsetMs: number;
  /** On this device's monotonic clock: when it may no longer act. */
  #deadline: number | null = null;
  #woke = false;

  constructor(self: string, authority: FakeLeaseAuthority, clock: Clock, offsetMs = 0) {
    this.self = self;
    this.#authority = authority;
    this.#clock = clock;
    this.offsetMs = offsetMs;
  }

  /** This device's own wall clock, off by `offsetMs`. */
  wallNow(): number {
    return this.#clock.now() + this.offsetMs;
  }

  state(): LeaseState {
    return this.#authority.view(this.self);
  }

  canAct(): boolean {
    return !this.#woke && this.#deadline !== null && this.state().holder === this.self && this.#clock.monotonic() < this.#deadline;
  }

  async acquire(opts: { byUser?: boolean } = {}): Promise<LeaseState> {
    const sent = this.#clock.monotonic();
    this.#authority.acquire(this.self, opts.byUser ?? false);
    this.#granted(sent);
    return this.state();
  }

  async renew(): Promise<LeaseState> {
    const sent = this.#clock.monotonic();
    this.#authority.renew(this.self);
    this.#granted(sent);
    return this.state();
  }

  async release(): Promise<void> {
    this.#deadline = null;
    this.#authority.release(this.self);
  }

  wake(): void {
    this.#woke = true;
  }

  #granted(sentAt: number): void {
    this.#deadline = sentAt + this.#authority.ttlMs - this.#authority.marginMs;
    this.#woke = false;
  }

  watch(fn: (state: LeaseState) => void): Unsubscribe {
    return this.#authority.onChange(() => fn(this.state()));
  }
}
