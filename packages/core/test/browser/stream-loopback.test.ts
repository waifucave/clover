// The stream's sender over a real throttled TCP link on loopback, in real time (`stream-loopback.ts`): it must settle
// at what the link carries, keep the picture moving, and stay near real time. Bounds are loose, since this runs on
// shared CI machines in real time; the figures are in `stream-measure.ts loopback`.
import { describe, expect, test } from "bun:test";
import { runLoopback } from "./stream-loopback";

describe("the stream over a throttled loopback link", () => {
  test("a 1 Mbit link: the bitrate comes down to it, the picture keeps moving, and it stays near real time", async () => {
    const r = await runLoopback({ name: "1 Mbit", durationMs: 16_000, capacityKbps: () => 1000, maxKbps: 2500 });
    console.log(JSON.stringify(r));
    expect(r.lowered).toBeGreaterThan(0);
    expect(r.delivered).toBeGreaterThan(50);
    expect(r.longestGapMs).toBeLessThan(5000);
    expect(r.latencyP95).toBeLessThan(6000);
    expect(r.askRatio).toBeLessThan(2.2);
  }, 60_000);
});
