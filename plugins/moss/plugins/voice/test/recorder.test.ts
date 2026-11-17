// What the talk button records from (src/recorder.ts): the audio's shape and the generated clip a test or acceptance build
// takes in place of the microphone. None of this opens a device or raises a system prompt; the tone is made here.
import { describe, expect, test } from "bun:test";
import { Downsampler, LISTEN_RATE, clipSource, floatToPcm16, testBuild } from "../src/recorder";

const tone = (seconds: number, rate: number, hz = 440): Float32Array => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate) * 0.5);

describe("the audio's shape", () => {
  test("float samples become 16-bit little-endian PCM, clamped", () => {
    const pcm = floatToPcm16(Float32Array.of(0, 0.5, -0.5, 1, -1, 2, -2));
    const v = new DataView(pcm.buffer);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => v.getInt16(i * 2, true))).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
    expect(pcm.length).toBe(14);
  });

  test("48 kHz and 44.1 kHz input come out at 16 kHz with the tone's level and about the right length, and 16 kHz passes through", () => {
    for (const rate of [48_000, 44_100, 32_000, 16_000]) {
      const d = new Downsampler(rate);
      const input = tone(1, rate);
      // In pieces of 4096, as the processor hands them over, so the position must carry across calls.
      const out: number[] = [];
      for (let at = 0; at < input.length; at += 4096) out.push(...d.push(input.subarray(at, at + 4096)));
      expect(Math.abs(out.length - LISTEN_RATE)).toBeLessThanOrEqual(1);
      const peak = Math.max(...out.slice(100).map(Math.abs));
      expect(peak).toBeGreaterThan(0.4);
      expect(peak).toBeLessThanOrEqual(0.51);
    }
    const same = Float32Array.of(0.1, 0.2, 0.3);
    expect([...new Downsampler(16_000).push(same)].map((x) => Math.round(x * 10))).toEqual([1, 2, 3]);
  });

  test("a rate below 16 kHz is refused (it could only be stretched)", () => {
    expect(() => new Downsampler(8_000)).toThrow("below 16 kHz");
  });
});

describe("the generated clip the test and acceptance builds use in place of a microphone", () => {
  // Waits for what a test means, bounded so a failure can't hang: the clip is a chain of timers (a timer at least `everyMs`
  // long between pieces), and how long the whole chain takes is the machine's, not the clip's (a loaded runner made 4 of
  // its 12 pieces in a guessed 60 ms).
  async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  test("it makes the same 1.2 s of tone every time, whatever the hold's length, and stops when closed", async () => {
    const chunks: number[] = [];
    const sum = (): number => chunks.reduce((a, b) => a + b, 0);
    const handle = await clipSource({ everyMs: 1 })({ chunk: (p) => chunks.push(p.length), end: () => undefined });
    await until("the whole clip", () => sum() >= 38_400);
    expect(sum()).toBe(38_400);
    expect(chunks.length).toBe(12);
    // Complete, it makes nothing more, closed or not.
    handle.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(chunks.length).toBe(12);
  });

  test("closed part-way, it makes nothing more", async () => {
    const chunks: number[] = [];
    const handle = await clipSource({ everyMs: 1 })({ chunk: (p) => chunks.push(p.length), end: () => undefined });
    await until("the first piece", () => chunks.length >= 1);
    handle.stop();
    const after = chunks.length;
    expect(after).toBeLessThan(12);
    await new Promise((r) => setTimeout(r, 50));
    expect(chunks.length).toBe(after);
  });

  test("a run with neither mark defined (bun test) is not a test build by the app's convention", () => {
    expect(testBuild()).toBe(false);
  });
});
