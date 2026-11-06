// The real lease (lease/lease.ts) against the contracts' Lease conformance suite, over the handshake's lease rules in
// memory; then what the real one adds: the fencing token, the exceptions to fencing, a takeover by the user's choice,
// and the scopes over the handshake's wire (group and account) through the local stand-in for lane I's service.
import { describe, expect, test } from "bun:test";
import { runLeaseConformance, type LeaseFactory } from "../../contracts/conformance/lease";
import { isContractError } from "../../contracts/common";
import { FakeClock } from "../../contracts/fakes/clock";
import { MainLeaseHarness, MemoryLeaseService, memoryLease } from "../testing";

runLeaseConformance(((opts: ConstructorParameters<typeof MainLeaseHarness>[0]) => new MainLeaseHarness(opts)) as unknown as LeaseFactory);

describe("MainLease beyond the contract", () => {
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
