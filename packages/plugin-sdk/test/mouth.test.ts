// The SDK's helpers for any part that moves a mouth: mouth levels from speech (`ui/mouth`). Nothing in them is one format's.
import { describe, expect, test } from "bun:test";
import { FULL_RMS, MouthSmoother, PushedSpeech, SHUT, SILENCE_RMS, visemeWeights } from "../src/ui/mouth";

describe("mouth levels from speech", () => {
  test("silence is a shut mouth; loudness opens it, and the five weights never sum past one", () => {
    expect(visemeWeights(SILENCE_RMS / 2, 1000)).toEqual(SHUT);
    const open = visemeWeights(FULL_RMS, 1200);
    const sum = Object.values(open).reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(0.5);
    expect(sum).toBeLessThanOrEqual(1.0001);
  });

  test("the smoother eases toward the target, and a pushed feed hands its frames on", () => {
    const m = new MouthSmoother();
    const first = m.step(visemeWeights(FULL_RMS, 900), 1 / 60);
    expect(Object.values(first).some((v) => v > 0)).toBe(true);
    const feed = new PushedSpeech(() => 0);
    const got: number[] = [];
    const off = feed.subscribe((frames) => got.push(...frames.map((f) => f.t)));
    feed.push([{ t: 1, rms: 0.2, centroid: 900 }]);
    off();
    expect(got).toEqual([1]);
  });
});
