// The real lease (lease/lease.ts) against the contracts' Lease conformance suite, over the handshake's lease rules in
// memory; then what the real one adds: the fencing token, the exceptions to fencing, a takeover by the user's choice,
// and the scopes over the handshake's wire (group and account) through the local stand-in for lane I's service.
import { describe, expect, test } from "bun:test";
import { runLeaseConformance, type LeaseFactory } from "../../contracts/conformance/lease";
import { isContractError } from "../../contracts/common";
import { FakeClock } from "../../contracts/fakes/clock";
import { MainLease } from "../lease";
import { MainLeaseHarness, MemoryLeaseService, memoryLease } from "../testing";

runLeaseConformance(((opts: ConstructorParameters<typeof MainLeaseHarness>[0]) => new MainLeaseHarness(opts)) as unknown as LeaseFactory);

describe("MainLease beyond the contract", () => {
  test("the fencing token is (scope, epoch): a new scope counts afresh, and a scope this device left is an earlier lease", async () => {
    const clock = new FakeClock();
    let scope = "group:g1";
    const epochs: Record<string, number> = { "group:g1": 7, account: 1 };
    const lease = new MainLease({
      self: "studio", clock,
      scope: () => ({
        id: scope,
        read: async () => ({ holder: null, holderRaw: "k", epoch: epochs[scope]!, expiresAt: clock.now() + 30_000 }),
        op: async () => { throw new Error("not here"); },
      }),
    });
    await lease.refresh();
    expect(lease.fence()).toEqual({ scope: "group:g1", epoch: 7 });
    // Signing in moves the lease to the account's record, whose count starts at 1.
    scope = "account";
    lease.scopeChanged();
    await lease.refresh();
    expect(lease.fence()).toEqual({ scope: "account", epoch: 1 });
    expect(lease.isStale(1, "account")).toBe(false);
    expect(lease.isStale(1)).toBe(false);
    // What the old group's main does is from an earlier lease, whatever its epoch.
    expect(lease.isStale(7, "group:g1")).toBe(true);
    expect(lease.isStale(99, "group:g1")).toBe(true);
    // A scope this device hasn't reached yet isn't judged here.
    expect(lease.isStale(1, "group:g2")).toBe(false);
  });

  test("a lease held by a group member this computer doesn't know reads as held, by no device it can name, never as lapsed", async () => {
    const clock = new FakeClock();
    const lease = new MainLease({
      self: "studio", clock,
      scope: () => ({
        id: "group:g1",
        read: async () => ({ holder: null, holderRaw: "a-member-key", epoch: 3, expiresAt: clock.now() + 30_000 }),
        op: async () => { throw new Error("not here"); },
      }),
    });
    await lease.refresh();
    // The views show "held by another computer in your group" for this (the controller's ruling).
    expect(lease.state()).toMatchObject({ holder: null, state: "held", epoch: 3 });
    expect(lease.canAct()).toBe(false);
  });

  test("a peer's newer epoch is a claim: before its deadline the holder acts on; past it, acting through the exception, it stops; a claim the service disproves gets that peer ignored a TTL (checks 3 to 6)", async () => {
    const clock = new FakeClock();
    const service = new MemoryLeaseService(clock);
    const studio = memoryLease(service, { self: "studio", clock, mayOutlast: () => true });
    await studio.acquire();
    expect(studio.canAct()).toBe(true);
    // Not newer, or another scope's: no claim.
    expect(studio.peerEpoch(1, undefined, "laptop")).toBe(false);
    expect(studio.peerEpoch(9, "group:other", "laptop")).toBe(false);
    // A newer epoch: a claim. Before the deadline the service's word stands, and the holder acts on (check 6, L8).
    expect(studio.peerEpoch(2, studio.scopeId(), "laptop")).toBe(true);
    expect(studio.canAct()).toBe(true);
    // Past the deadline, acting only through the exception, the open claim stops it (L3, L4).
    clock.advance(studio.ttlMs - studio.marginMs + 1);
    expect(studio.canAct()).toBe(false);
    // A renew sent after the claim shows epoch 1: the claim was false. The holder acts again, and the laptop's claims
    // are ignored for a TTL; another peer's still count.
    await studio.renew();
    expect(studio.canAct()).toBe(true);
    expect(studio.highestEpoch()).toBe(1);
    expect(studio.distrusts("laptop")).toBe(true);
    expect(studio.peerEpoch(3, undefined, "laptop")).toBe(false);
    expect(studio.peerEpoch(3, undefined, "server")).toBe(true);
    clock.advance(studio.ttlMs);
    expect(studio.distrusts("laptop")).toBe(false);
  });

  test("an acquire answered after a release gives the lease back instead of holding it unasked (check 3)", async () => {
    const clock = new FakeClock();
    const service = new MemoryLeaseService(clock);
    const inner = service.scope("studio");
    let gate: Promise<void> | undefined;
    const studio = new MainLease({
      self: "studio", clock,
      scope: () => ({
        ...inner,
        op: async (op, epoch, ttl) => {
          if (op === "acquire" && gate) await gate;
          return inner.op(op, epoch, ttl);
        },
      }),
    });
    await studio.acquire();
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    // An acquire in flight (the main taking its own back) while a hand-over releases.
    const inFlight = studio.acquire();
    await studio.release();
    expect(service.record.holder).toBe(null);
    open();
    await inFlight;
    expect(studio.holds()).toBe(false);
    expect(service.record.holder).toBe(null);
  });

  test("the epoch is a fencing token: a takeover raises it, and acts stamped with an older one are stale", async () => {
    const clock = new FakeClock();
    const service = new MemoryLeaseService(clock);
    const studio = memoryLease(service, { self: "studio", clock });
    const laptop = memoryLease(service, { self: "laptop", clock });
    await studio.acquire();
    expect(studio.highestEpoch()).toBe(1);
    // The user chose the laptop: it takes the lease while the studio's still runs.
    await laptop.takeOver();
    expect(laptop.canAct()).toBe(true);
    expect(laptop.state()).toMatchObject({ holder: "laptop", epoch: 2 });
    // The studio heard the push: it no longer acts, and refuses what's stamped with its old epoch.
    expect(studio.canAct()).toBe(false);
    expect(studio.isStale(1)).toBe(true);
    expect(studio.isStale(2)).toBe(false);
    expect(isContractError(await studio.renew().catch((e: unknown) => e), "not_main")).toBe(true);
  });

  test("past its deadline a holder that can't renew acts on only while an exception holds", async () => {
    const clock = new FakeClock();
    const service = new MemoryLeaseService(clock);
    let linkedToAll = true;
    const studio = memoryLease(service, { self: "studio", clock, mayOutlast: () => linkedToAll });
    await studio.acquire();
    service.cutOff("studio");
    const seen: boolean[] = [];
    studio.watch(() => seen.push(studio.canAct()));
    clock.advance(studio.ttlMs - studio.marginMs);
    expect(studio.canAct()).toBe(true);
    linkedToAll = false;
    studio.recheck();
    expect(studio.canAct()).toBe(false);
    expect(seen.at(-1)).toBe(false);
  });

  test("a deadline passing tells the watchers, so the bots stop without anyone asking", async () => {
    const clock = new FakeClock();
    const service = new MemoryLeaseService(clock);
    const studio = memoryLease(service, { self: "studio", clock });
    await studio.acquire();
    service.cutOff("studio");
    const acts: boolean[] = [];
    studio.watch(() => acts.push(studio.canAct()));
    clock.advance(studio.ttlMs - studio.marginMs);
    expect(acts).toEqual([false]);
  });

  test("a read never steps back to an older record", async () => {
    const clock = new FakeClock();
    const service = new MemoryLeaseService(clock);
    const studio = memoryLease(service, { self: "studio", clock });
    await studio.acquire();
    studio.observe({ holder: null, holderRaw: null, epoch: 0, expiresAt: null });
    expect(studio.state()).toMatchObject({ holder: "studio", epoch: 1 });
  });
});
