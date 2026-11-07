// An update's restart keeps the bots here (lane M's #198: the update gate's `beforeRestart`, which lane H registers):
// it isn't Hand over and quit. Just before the restart the holder renews, so the daemon is down inside a full lease from
// that moment; the other computer sees the lease held throughout and never takes it, and the new daemon renews the
// same epoch. Real links on the in-memory wire, real coordinators, short leases.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../../clock/system-clock";
import { makeLinkCluster } from "../../links/testing";
import { type MainComputerHandle, startMainComputer, type UpdateRestartGate } from "../main";
import { MemoryLeaseService } from "../testing";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

// A lease of 3 s whose holder stops 0.3 s early; the coordinator renews on its own only once it can no longer act.
const TIMINGS = { ttlMs: 3_000, marginMs: 300, ttlSec: 3, renewEveryMs: 60_000, readEveryMs: 100, takeoverDelayMs: 100, nudgeWaitMs: 100, reachTimeoutMs: 200, retryMs: 100 };

/** The update gate's restart hooks, as lane M's `UpdateGate` runs them. */
class Gate implements UpdateRestartGate {
  readonly hooks = new Set<() => Promise<void> | void>();
  beforeRestart(fn: () => Promise<void> | void): () => void {
    this.hooks.add(fn);
    return () => void this.hooks.delete(fn);
  }
  async prepareRestart(): Promise<void> {
    await Promise.all([...this.hooks].map((fn) => fn()));
  }
}

async function waitFor(cond: () => boolean, ms = 6_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("an update's restart", () => {
  test("renews just before, keeps the same epoch held through a restart inside the lease, and hands nothing over", async () => {
    const c = await makeLinkCluster(["Studio", "Laptop"], { clock, transport: { failFastMs: 200, dialTimeoutMs: 300 } });
    stops.push(() => c.close());
    const service = new MemoryLeaseService(clock, { minTtlSec: 0 });
    const studio = c.devices.get("Studio")!;
    const laptop = c.devices.get("Laptop")!;
    const studioHome = mkdtempSync(join(tmpdir(), "clover-h-update-"));
    const start = (d: typeof studio, home: string): MainComputerHandle => {
      const scope = service.scope(d.id);
      const mc = startMainComputer({
        home, self: d.id, registry: d.registry, transport: d.transport, clock, scope: () => scope, monotonic: () => performance.now(),
        watchSleep: false, timings: TIMINGS,
      });
      stops.push(() => mc.close());
      return mc;
    };
    let main = start(studio, studioHome);
    const other = start(laptop, mkdtempSync(join(tmpdir(), "clover-h-update-")));
    await studio.transport.connect(laptop.id);
    await main.coordinator.chooseSelf();
    await waitFor(() => service.record.holder === studio.id && main.lease.canAct() && other.choice.current() === studio.id);
    const epoch = service.record.epoch;

    // Some time into the lease, as at any update: the gate runs lane H's hook, a fresh renew.
    const gate = new Gate();
    const off = gate.beforeRestart(() => main.beforeUpdateRestart());
    await Bun.sleep(1_800);
    const before = service.record.expiresAt!;
    await gate.prepareRestart();
    off();
    const renewedAt = Date.now();
    expect(service.record.expiresAt!).toBeGreaterThan(before + 1_000);
    expect(service.record.expiresAt!).toBeGreaterThanOrEqual(renewedAt + TIMINGS.ttlMs - 100);
    expect(service.record).toMatchObject({ holder: studio.id, epoch });

    // The daemon stops (its links go with it) and the new one starts 1.5 s later, inside the lease: past the end of
    // the lease as it stood before the renew, so without it the laptop would have taken the bots.
    main.close();
    c.net.partition(studio.key.publicKey);
    const seen = new Set<string | null>();
    const down = Date.now();
    while (Date.now() - down < 1_500) {
      seen.add(service.record.holder);
      expect(other.lease.canAct()).toBe(false);
      await Bun.sleep(50);
    }
    // Past where the lease ended before the renew.
    expect(Date.now()).toBeGreaterThan(before);
    expect([...seen]).toEqual([studio.id]);
    c.net.heal(studio.key.publicKey);
    main = start(studio, studioHome);

    // The new daemon renews the same lease: same epoch, no hand-over, nothing released.
    await waitFor(() => main.lease.canAct());
    expect(service.record).toMatchObject({ holder: studio.id, epoch });
    expect(service.log.filter((l) => /release|takeover/.test(l))).toEqual([]);
    expect(other.lease.canAct()).toBe(false);
  }, 20_000);
});
