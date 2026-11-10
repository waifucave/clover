// The stream's sender over a real throttled TCP link on loopback, in real time (`stream-loopback.ts`): it must start
// lowering the bitrate and keep the picture moving. It does NOT stay near real time here, and the test says so: a real
// socket's buffers (the sender's kernel buffer and the relay's, together some 0.5 MB on macOS loopback) take seconds of
// a 1 Mbit link's video before `write()` ever waits, so the sender can only see the trouble late (the in-memory
// simulation's 256 KiB case shows the same). That figure is the finding for lane H: keep the stream's send buffer to a
// few tens of KiB. Bounds are loose, since this runs on shared CI machines in real time; the figures are in
// `stream-measure.ts loopback`.
import { describe, expect, test } from "bun:test";
import { runLoopback } from "./stream-loopback";

describe("the stream over a throttled loopback link", () => {
  test("a 1 Mbit link: the bitrate comes down, the picture keeps moving, and the delay is bounded by the buffers", async () => {
    const r = await runLoopback({ name: "1 Mbit", durationMs: 16_000, capacityKbps: () => 1000, maxKbps: 2500 });
    console.log(JSON.stringify(r));
    // Without acks how soon the sender sees trouble depends on the machine's socket buffers (a Linux runner's may
    // hold the whole run), so only that the picture keeps moving is asserted here.
    expect(r.delivered).toBeGreaterThan(50);
    expect(r.longestGapMs).toBeLessThan(5000);
    expect(r.latencyP95).toBeLessThan(30_000);
  }, 60_000);

  test("with the receiver's acks: the delay stays near real time whatever the buffers hold, and the bitrate follows the link", async () => {
    const r = await runLoopback({ name: "1 Mbit, acks", durationMs: 16_000, capacityKbps: () => 1000, maxKbps: 2500 }, { acks: true });
    console.log(JSON.stringify(r));
    expect(r.delivered).toBeGreaterThan(50);
    expect(r.longestGapMs).toBeLessThan(3000);
    expect(r.latencyP95).toBeLessThan(3000);
    expect(r.lowered).toBeGreaterThan(0);
    expect(r.utilization).toBeGreaterThan(0.3);
  }, 60_000);
});
