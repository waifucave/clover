// FakeLeaseAuthority: the waifucave handshake's lease, in memory, on a shared fake clock. Each device gets a Lease
// over it; `cutOff` makes the handshake unreachable from one device, as a main that loses the internet would see.
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

  constructor(opts: { clock: Clock; main?: string; ttlMs?: number; marginMs?: number }) {
    this.#clock = opts.clock;
    this.#main = opts.main ?? null;
    this.ttlMs = opts.ttlMs ?? FAKE_LEASE_TTL_MS;
    this.marginMs = opts.marginMs ?? FAKE_LEASE_MARGIN_MS;
  }

  lease(device: string): FakeLease {
    return new FakeLease(device, this, this.#clock);
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
  acquire(device: string): void {
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

  constructor(self: string, authority: FakeLeaseAuthority, clock: Clock) {
    this.self = self;
    this.#authority = authority;
    this.#clock = clock;
  }

  state(): LeaseState {
    return this.#authority.view(this.self);
  }

  canAct(): boolean {
    const s = this.state();
    return s.holder === this.self && s.expiresAt !== null && this.#clock.now() < s.expiresAt - this.#authority.marginMs;
  }

  async acquire(): Promise<LeaseState> {
    this.#authority.acquire(this.self);
    return this.state();
  }

  async renew(): Promise<LeaseState> {
    this.#authority.renew(this.self);
    return this.state();
  }

  async release(): Promise<void> {
    this.#authority.release(this.self);
  }

  watch(fn: (state: LeaseState) => void): Unsubscribe {
    return this.#authority.onChange(() => fn(this.state()));
  }
}
