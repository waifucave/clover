// The stream sender's thresholds on a throttled link, in virtual time (`throttle-sim.ts`): what the defaults must keep
// whatever tuning comes next. The sweep behind the figures is `stream-measure.ts`.
import { describe, expect, test } from "bun:test";
import { SCENARIOS, simulate } from "./throttle-sim";

const by = (name: string) => SCENARIOS.find((s) => s.name.startsWith(name))!;

describe("the stream on a throttled link", () => {
  test("a link with room: the bitrate stays where it began and nothing is dropped", async () => {
    const m = await simulate(by("roomy"));
    expect(m).toMatchObject({ lowered: 0, droppedShare: 0, frozenSec: 0 });
    expect(m.latencyP95).toBeLessThan(100);
  });

  for (const [name, buffer] of [["tight", 0], ["tight", 64 * 1024], ["slow", 0], ["drop", 0], ["flapping", 0], ["mobile", 0]] as const) {
    test(`${name} link, ${buffer / 1024} KiB socket buffer: the picture never freezes, stays within about a second, and still uses a fair part of the link`, async () => {
      const m = await simulate(by(name), { sndbufBytes: buffer });
      expect(m.frozenSec).toBe(0);
      expect(m.latencyP95).toBeLessThan(buffer > 0 ? 1500 : 800);
      expect(m.utilization).toBeGreaterThan(0.3);
      expect(m.utilization).toBeLessThan(1.05);
    });
  }

  test("after a drop to 600 kbit it asks for what fits within a few seconds, and goes back up when the link does", async () => {
    const m = await simulate(by("drop"));
    expect(m.lowered).toBeGreaterThan(0);
    expect(m.raised).toBeGreaterThan(0);
    expect(m.laggingSec).toBeLessThan(10);
  });

  test("a keyframe's burst never counts as falling behind on a link that has the room", async () => {
    const m = await simulate({ name: "3 Mbit", durationMs: 30_000, capacityKbps: () => 3000 }, {});
    expect(m.lowered).toBe(0);
  });

  test("with acks and a 100 ms round trip, a big socket buffer no longer holds the picture seconds behind", async () => {
    for (const buffer of [64 * 1024, 256 * 1024]) {
      const without = await simulate(by("tight"), { sndbufBytes: buffer, latencyMs: 50 });
      const withAcks = await simulate(by("tight"), { sndbufBytes: buffer, latencyMs: 50, acks: true });
      expect(withAcks.frozenSec).toBeLessThan(1);
      expect(withAcks.latencyP95).toBeLessThan(without.latencyP95);
      expect(withAcks.laggingSec).toBeLessThan(without.laggingSec);
      expect(withAcks.utilization).toBeGreaterThan(0.3);
    }
  });
});
