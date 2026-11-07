// The shared clock (spec §6.4): the reference keeps public time, the others measure their offset from it over the
// link the NTP way, and shared time never steps back for a reader. Real links on the in-memory wire; a stand-in for
// the public servers; one device's wall clock five seconds off.
import { afterEach, describe, expect, test } from "bun:test";
import { SystemClock } from "../system-clock";
import type { Clock } from "../../contracts/clock";
import { makeLinkCluster } from "../../links/testing";
import { SharedClock, SntpTimeSource, type TimeSource } from "../shared-clock";

let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

/** A wall clock `off` ms from the machine's, with the machine's monotonic time and timers. */
function offClock(off: number): Clock {
  const sys = new SystemClock();
  return { now: () => Date.now() + off, monotonic: () => sys.monotonic(), setTimeout: (f, ms) => sys.setTimeout(f, ms), clearTimeout: (h) => sys.clearTimeout(h), status: () => sys.status() };
}

const publicAt = (offsetMs: number): TimeSource => ({ sample: async () => ({ offsetMs, rttMs: 12 }) });

describe("the shared clock", () => {
  test("the reference keeps public time; a device whose wall clock is 5 s off follows it to within the round trip", async () => {
    const c = await makeLinkCluster(["Studio", "Laptop"], { clock: new SystemClock() });
    stops.push(() => c.close());
    const studio = c.devices.get("Studio")!;
    const laptop = c.devices.get("Laptop")!;
    const ref = () => studio.id;
    // The studio's wall clock is 1.234 s behind public time; the laptop's is 5 s ahead of the studio's.
    const s = new SharedClock({ self: studio.id, base: offClock(0), transport: studio.transport, reference: ref, publicTime: publicAt(1234) });
    const l = new SharedClock({ self: laptop.id, base: offClock(5_000), transport: laptop.transport, reference: ref });
    stops.push(() => s.close(), () => l.close());
    await s.measure();
    expect(s.status()).toMatchObject({ reference: "public", offsetMs: 1234, synced: true });
    for (let i = 0; i < 5; i++) await l.measure();
    const st = l.status();
    expect(st.reference).toBe(studio.id);
    expect(st.synced).toBe(true);
    expect(Math.abs(st.offsetMs - (1234 - 5_000))).toBeLessThan(50);
    expect(Math.abs(l.now() - s.now())).toBeLessThan(50);
    expect(st.accuracyMs).toBeLessThan(25);
  });

  test("a reference far from this device's own clock is followed only when public time bears it out", async () => {
    const c = await makeLinkCluster(["Studio", "Laptop"], { clock: new SystemClock() });
    stops.push(() => c.close());
    const studio = c.devices.get("Studio")!;
    const laptop = c.devices.get("Laptop")!;
    // The studio says it's ten minutes later than the laptop thinks.
    const s = new SharedClock({ self: studio.id, base: offClock(600_000), transport: studio.transport, reference: () => studio.id });
    const l = new SharedClock({ self: laptop.id, base: offClock(0), transport: laptop.transport, reference: () => studio.id });
    stops.push(() => s.close(), () => l.close());
    expect(await l.measure()).toBeUndefined();
    expect(l.status().synced).toBe(false);
    // With public time here agreeing, it's followed.
    const l2 = new SharedClock({ self: laptop.id, base: offClock(0), transport: laptop.transport, reference: () => studio.id, publicTime: publicAt(600_000) });
    stops.push(() => l2.close());
    expect(await l2.measure()).toBeDefined();
    expect(Math.abs(l2.status().offsetMs - 600_000)).toBeLessThan(100);
  });

  test("shared time never steps back for a reader when a correction goes down", async () => {
    const c = await makeLinkCluster(["Studio"], { clock: new SystemClock() });
    stops.push(() => c.close());
    let sample = { offsetMs: 10_000, rttMs: 50 };
    const s = new SharedClock({ self: "x", base: offClock(0), transport: c.devices.get("Studio")!.transport, reference: () => null, publicTime: { sample: async () => sample } });
    stops.push(() => s.close());
    await s.measure();
    const before = s.now();
    // A sample with a shorter round trip wins, and moves shared time 20 s back.
    sample = { offsetMs: -10_000, rttMs: 1 };
    await s.measure();
    expect(s.status().offsetMs).toBe(-10_000);
    // A reader sees time stand still instead.
    expect(s.now()).toBeGreaterThanOrEqual(before);
    expect(s.now()).toBeLessThan(before + 1_000);
  });

  test("with no reference known it says it isn't synced", async () => {
    const c = await makeLinkCluster(["Studio"], { clock: new SystemClock() });
    stops.push(() => c.close());
    const s = new SharedClock({ self: "x", base: offClock(0), transport: c.devices.get("Studio")!.transport, reference: () => null });
    stops.push(() => s.close());
    expect(await s.measure()).toBeUndefined();
    expect(s.status()).toMatchObject({ reference: "public", synced: false, offsetMs: 0 });
  });

  test.skipIf(process.env.CLOVER_LIVE_TIME !== "1")("SNTP against the public servers (live; off by default)", async () => {
    const r = await new SntpTimeSource().sample();
    expect(Math.abs(r.offsetMs)).toBeLessThan(60_000);
  });
});
