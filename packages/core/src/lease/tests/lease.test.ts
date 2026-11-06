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
