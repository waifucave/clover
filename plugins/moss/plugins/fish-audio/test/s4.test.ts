// Spike S4's harness (../src/s4.ts) against the recorded fake: the same run live gate 5 makes against Fish with the
// owner's key (../scripts/s4-live.ts) works end to end here, and says what it found.
import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/fish";
import { percentile, runS4, S4_TEXTS, wordSimilarity } from "../src/s4";
import { FakeFish, VirtualTimer } from "./fake-fish";

const KEY = "test-key-not-a-secret";
const keyed = (fish: FakeFish): FetchLike => (url, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${KEY}`);
  return fish.fetch(url, { ...init, headers });
};

describe("spike S4", () => {
  test("the run measures time to first audio, the concurrency limit, a burst and a round trip", async () => {
    const timer = new VirtualTimer();
    const fish = new FakeFish({ key: KEY, timer, ttfaMs: 380, chunkMs: 10, balanceUsd: 1 });
    const progress: string[] = [];
    const samples: string[] = [];
    const report = await runS4({
      fetch: keyed(fish), timer, runs: 3, burst: 10, onProgress: (l) => progress.push(l),
      onAudio: (s) => samples.push(`${s.model} ${s.kind} ${s.sampleRate} ${s.pcm.length > 0}`),
    });
    expect(report.model).toBe("s2.1-pro-free");
    expect(report.voice).toBe("8e1f6c3a9b2d4e7f8a1b2c3d4e5f6a7b");
    for (const kind of ["short", "medium", "long"] as const) {
      expect(report.ttfa[kind]).toMatchObject({ runs: 3, ok: 3, p50: 380, p95: 380, max: 380 });
      expect(report.ttfa[kind].meanRtf).toBeGreaterThan(0);
    }
    expect(report.paid).toBeUndefined();
    expect(report.concurrency).toEqual({ fired: 8, ok: 5, rateLimited: 3, other: 0 });
    expect(report.burst).toMatchObject({ requests: 10, ok: 10, rateLimited: 0, paymentRequired: 0, p50: 380 });
    expect(report.roundTrip).toEqual({ said: S4_TEXTS.medium, heard: S4_TEXTS.medium, similarity: 1 });
    expect(report.failures).toEqual([]);
    expect(report.forTheOwner.length).toBeGreaterThan(0);
    // One sample of each text for the owner to listen to.
    expect(samples).toEqual(["s2.1-pro-free short 24000 true", "s2.1-pro-free medium 24000 true", "s2.1-pro-free long 24000 true"]);
    expect(progress.some((l) => l.includes("8 at once: 5 ok, 3 rate-limited"))).toBe(true);
    // The free model cost nothing; only the round trip's listening was billed.
    expect(fish.calls.filter((c) => c.path === "/v1/tts").every((c) => c.billedModel === "s2.1-pro-free" && (c.status !== 200 || c.costUsd === 0))).toBe(true);
    expect(fish.inFlight).toBe(0);
  });

  test("if the free model turns out to need credit, the report shows it as payment required", async () => {
    const timer = new VirtualTimer();
    const fish = new FakeFish({ key: KEY, timer, freeModelNeedsCredit: true, balanceUsd: 0 });
    const report = await runS4({ fetch: keyed(fish), timer, runs: 1, burst: 3, roundTrip: false, voice: "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f" });
    expect(report.ttfa.short).toEqual({ runs: 1, ok: 0 });
    expect(report.burst).toMatchObject({ requests: 3, ok: 0, paymentRequired: 3 });
    expect(new Set(report.failures.map((f) => f.code))).toEqual(new Set(["payment_required"]));
  });

  test("with --paid it measures s2.1-pro beside the free model", async () => {
    const timer = new VirtualTimer();
    const fish = new FakeFish({ key: KEY, timer, balanceUsd: 1 });
    const report = await runS4({ fetch: keyed(fish), timer, runs: 1, burst: 1, comparePaid: true, roundTrip: false });
    expect(report.paid?.long).toMatchObject({ runs: 1, ok: 1 });
    expect(fish.calls.some((c) => c.billedModel === "s2.1-pro" && (c.costUsd ?? 0) > 0)).toBe(true);
  });

  test("its arithmetic", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([], 50)).toBeUndefined();
    expect(wordSimilarity("Hello, world!", "hello world")).toBe(1);
    expect(wordSimilarity("the cat sat", "the dog sat")).toBeCloseTo(2 / 3, 5);
  });
});
