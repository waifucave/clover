// Test support: the handshake's lease record in memory, with PROTOCOL.md's rules for each operation, on a test's
// clock. Each device gets a `MainLease` over it (`lease(device)`), with its own wall-clock offset; `cutOff` makes the
// service unreachable from one device. The record's changes are pushed to every device, as the service's socket
// pushes them. It doubles as the harness the contracts' Lease conformance suite drives (`runLeaseConformance`).
import type { LeaseView } from "@waifucave/clover-protocol";
import type { Clock } from "../contracts/clock";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type { LeaseOp } from "../links/handshake";
import { MainLease, type MainLeaseOptions } from "./lease";
import type { LeaseScope, ScopeLease } from "./scope";

export class MemoryLeaseService {
  readonly #clock: Pick<Clock, "now">;
  #record: { holder: string | null; epoch: number; expiresAt: number | null } = { holder: null, epoch: 0, expiresAt: null };
  readonly #cut = new Set<string>();
  readonly #pushes = new Listeners<{ device?: string; record?: ScopeLease; reachable?: boolean }>();
  /** Every operation, as `<device> <op>`. */
  readonly log: string[] = [];

  readonly #minTtlSec: number;

  /** `minTtlSec`: the service's floor, 10 s as PROTOCOL.md says; tests on real time lower it. */
  constructor(clock: Pick<Clock, "now">, opts: { minTtlSec?: number } = {}) {
    this.#clock = clock;
    this.#minTtlSec = opts.minTtlSec ?? 10;
  }

  get record(): { holder: string | null; epoch: number; expiresAt: number | null } {
    return { ...this.#record };
  }

  cutOff(device: string, cut = true): void {
    if (cut) this.#cut.add(device);
    else this.#cut.delete(device);
    this.#pushes.emit({ device, reachable: !cut });
  }

  isCut(device: string): boolean {
    return this.#cut.has(device);
  }

  /** The scope one device sees. */
  scope(device: string): LeaseScope & { watch(fn: (e: { record?: ScopeLease; reachable?: boolean }) => void): Unsubscribe } {
    const asScope = (): ScopeLease => ({ ...this.#record, holderRaw: this.#record.holder });
    return {
      id: "memory",
      op: async (op: LeaseOp, epoch: number, ttlSec: number): Promise<ScopeLease> => {
        if (this.#cut.has(device)) throw new ContractError("offline", "the handshake can't be reached");
        this.log.push(`${device} ${op}`);
        const now = this.#clock.now();
        const l = this.#record;
        const lapsed = l.holder === null || (l.expiresAt ?? 0) <= now;
        const ttl = Math.min(300, Math.max(this.#minTtlSec, ttlSec)) * 1000;
        const held = () => new ContractError("conflict", "the lease is held", { lease: asScope() });
        if (op === "acquire") {
          if (!lapsed && l.holder !== device) throw held();
          this.#record = { holder: device, epoch: l.holder === device && !lapsed ? l.epoch : l.epoch + 1, expiresAt: now + ttl };
        } else if (op === "renew") {
          if (l.holder !== device || l.epoch !== epoch || lapsed) throw held();
          this.#record = { ...l, expiresAt: now + ttl };
        } else if (op === "release") {
          if (l.holder !== device || l.epoch !== epoch) throw held();
          this.#record = { holder: null, epoch: l.epoch, expiresAt: null };
        } else {
          this.#record = { holder: device, epoch: l.epoch + 1, expiresAt: now + ttl };
        }
        this.#pushes.emit({ record: asScope() });
        return asScope();
      },
      read: async (): Promise<ScopeLease> => {
        if (this.#cut.has(device)) throw new ContractError("offline", "the handshake can't be reached");
        return asScope();
      },
      watch: (fn) => this.#pushes.add((e) => {
        if (e.device !== undefined && e.device !== device) return;
        fn(e.record ? { record: e.record } : { ...(e.reachable === undefined ? {} : { reachable: e.reachable }) });
      }),
    };
  }
}

/** A device's MainLease over a memory service, following its pushes. */
export function memoryLease(service: MemoryLeaseService, o: Omit<MainLeaseOptions, "scope"> & { scope?: boolean }): MainLease & { closePushes(): void } {
  const scope = service.scope(o.self);
  const lease = new MainLease({ ...o, scope: () => (o.scope === false ? undefined : scope) }) as MainLease & { closePushes(): void };
  const off = scope.watch((e) => {
    if (e.record) lease.observe(e.record);
    if (e.reachable !== undefined) lease.setReachable(e.reachable);
  });
  lease.closePushes = off;
  return lease;
}

/** The conformance suite's harness: the shape of the contracts' FakeLeaseAuthority, built on MainLease. */
export class MainLeaseHarness {
  readonly ttlMs: number;
  readonly marginMs: number;
  readonly #clock: Clock;
  readonly #service: MemoryLeaseService;
  #main: string | null;
  readonly #leases = new Map<string, MainLease>();

  /** `account` is the contract's (with or without one, the lease is a record at the handshake, item 85). */
  constructor(opts: { clock: Clock; main?: string; ttlMs?: number; marginMs?: number; account?: boolean }) {
    this.#clock = opts.clock;
    this.#service = new MemoryLeaseService(opts.clock);
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.marginMs = opts.marginMs ?? 5_000;
    this.#main = opts.main ?? null;
  }

  lease(device: string, opts: { offsetMs?: number } = {}): MainLease & { wallNow(): number; offsetMs: number } {
    const offset = opts.offsetMs ?? 0;
    const clock = this.#clock;
    const shifted = { now: () => clock.now() + offset, setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock) };
    const lease = memoryLease(this.#service, {
      self: device, clock: shifted, monotonic: () => clock.monotonic(), ttlMs: this.ttlMs, marginMs: this.marginMs,
      // With an account or without, the lease is a record at the handshake (item 85): the account's, or the
      // account-less devices' group's. The harness keeps one record for either.
      main: () => this.#main,
    }) as unknown as MainLease & { wallNow(): number; offsetMs: number };
    lease.wallNow = () => clock.now() + offset;
    lease.offsetMs = offset;
    this.#leases.set(device, lease);
    return lease;
  }

  setMain(device: string | null): void {
    this.#main = device;
    for (const l of this.#leases.values()) l.recheck();
  }

  cutOff(device: string, cut = true): void {
    this.#service.cutOff(device, cut);
  }

  view(device: string): LeaseView {
    return this.#leases.get(device)?.state() ?? { main: this.#main, holder: null, epoch: 0, expiresAt: null, refresher: null, state: "lapsed" };
  }

  acquire(device: string, byUser = false): void {
    void this.#leases.get(device)?.acquire({ byUser });
  }

  renew(device: string): void {
    void this.#leases.get(device)?.renew();
  }

  release(device: string): void {
    void this.#leases.get(device)?.release();
  }

  onChange(fn: () => void): Unsubscribe {
    const offs = [...this.#leases.values()].map((l) => l.watch(() => fn()));
    return () => {
      for (const off of offs) off();
    };
  }
}
