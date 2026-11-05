import { describe, expect, test } from "bun:test";
import { FFT_SIZE, rmsOf, spectralCentroidOf } from "../src/lipsync/features";
import { MouthSmoother, SHUT, SILENCE_RMS, VISEMES, visemeWeights, type VisemeWeights } from "../src/lipsync/visemes";
import { LipSync, SpeechRing, analyserSource, bufferSource, ringSource, type AnalyserLike } from "../src/lipsync/sources";
import { hiss, phrase, vowel } from "../src/lipsync/synth";

const RATE = 48000;
const tone = (hz: number, amplitude = 0.5, offset = 0, n = FFT_SIZE) => Float32Array.from({ length: n }, (_, i) => offset + amplitude * Math.sin((2 * Math.PI * hz * i) / RATE));
const sum = (w: VisemeWeights) => VISEMES.reduce((s, n) => s + w[n], 0);

describe("the frame's two numbers", () => {
  test("loudness is the root mean square", () => {
    expect(rmsOf(tone(440, 0.5, 0, 4800))).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(rmsOf(new Float32Array(0))).toBe(0);
    expect(rmsOf(Float32Array.of(1, -1, 1, -1), 2)).toBe(1);
  });

  test("the centroid finds where the energy sits", () => {
    expect(spectralCentroidOf(tone(2000), RATE)).toBeGreaterThan(1700);
    expect(spectralCentroidOf(tone(2000), RATE)).toBeLessThan(2400);
    expect(spectralCentroidOf(tone(300), RATE)).toBeLessThan(700);
  });

  test("an offset under a bright tone does not drag it dark (the mean comes out first)", () => {
    expect(spectralCentroidOf(tone(2000, 0.3, 0.6), RATE)).toBeGreaterThan(1500);
  });

  test("silence reads 0, never NaN", () => {
    expect(spectralCentroidOf(new Float32Array(FFT_SIZE), RATE)).toBe(0);
    expect(spectralCentroidOf(new Float32Array(FFT_SIZE).fill(0.4), RATE)).toBe(0);
  });
});

describe("five mouth weights from one budget", () => {
  test("quiet shuts the mouth; nothing past a sum of 1", () => {
    expect(visemeWeights(SILENCE_RMS, 1000)).toEqual(SHUT);
    expect(visemeWeights(Number.NaN, 1000)).toEqual(SHUT);
    for (const rms of [0.02, 0.1, 0.25, 0.9]) for (const hz of [0, 400, 1500, 3000, Number.NaN]) {
      const w = visemeWeights(rms, hz);
      for (const n of VISEMES) {
        expect(w[n]).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(w[n])).toBe(true);
      }
      expect(sum(w)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  test("dark sounds open aa and oh, bright ones ee and ih", () => {
    const dark = visemeWeights(0.2, 300);
    const bright = visemeWeights(0.2, 3000);
    expect(dark.aa + dark.oh).toBeGreaterThan(dark.ee + dark.ih);
    expect(bright.ee + bright.ih).toBeGreaterThan(bright.aa + bright.oh);
    // An unreadable centroid falls dark, and the jaw still follows the loudness.
    expect(visemeWeights(0.2, Number.NaN).aa).toBe(dark.aa);
  });

  test("a sung 'a' reads dark and an 'i' bright", () => {
    const a = LipSync.analyse(vowel("a", 0.2).subarray(4800, 4800 + FFT_SIZE), RATE);
    const i = LipSync.analyse(vowel("i", 0.2).subarray(4800, 4800 + FFT_SIZE), RATE);
    expect(a.aa).toBeGreaterThan(a.ee);
    expect(i.ee + i.ih).toBeGreaterThan(i.aa + i.oh);
    expect(sum(a)).toBeGreaterThan(0.3);
  });

  test("the mouth opens quickly and closes more slowly, never past 1", () => {
    const smoother = new MouthSmoother();
    const open = smoother.step({ aa: 0.6, ih: 0, ou: 0.1, ee: 0, oh: 0.3 }, 1 / 60);
    expect(open.aa).toBeGreaterThan(0.6 * 0.3);
    for (let i = 0; i < 30; i++) smoother.step({ aa: 0.6, ih: 0, ou: 0.1, ee: 0, oh: 0.3 }, 1 / 60);
    const closing = smoother.step(SHUT, 1 / 60);
    const closedShare = 1 - closing.aa / 0.6;
    const openedShare = open.aa / 0.6;
    expect(closedShare).toBeLessThan(openedShare);
    expect(sum(closing)).toBeLessThanOrEqual(1);
    smoother.reset();
    expect(smoother.weights).toEqual(SHUT);
  });
});

describe("the samples' sources", () => {
  test("a speech ring reads what plays at a time, and a gap as silence", () => {
    const ring = new SpeechRing(RATE, 1);
    const chunk = tone(500, 0.3, 0, 4800);
    ring.write(chunk, 2.0);
    const into = new Float32Array(FFT_SIZE);
    expect(ring.read(into, 2.05)).toBe(FFT_SIZE);
    expect(into[0]).toBeCloseTo(chunk[2400]!, 6);
    expect(ring.read(into, 1.5)).toBe(0);
    expect(into.every((v) => v === 0)).toBe(true);
    // A second later the same slots hold other samples: the old time reads silent, not stale.
    ring.write(tone(900, 0.3, 0, 4800), 3.0);
    expect(ring.read(into, 2.05)).toBe(0);
    let clock = 3.01;
    const source = ringSource(ring, () => clock);
    expect(source.read(into)).toBe(FFT_SIZE);
    clock = 9;
    expect(source.read(into)).toBe(0);
  });

  test("an analyser hands over its newest samples", () => {
    const fake: AnalyserLike = {
      fftSize: 512,
      context: { sampleRate: 44100 },
      getFloatTimeDomainData: (array) => array.forEach((_, i) => (array[i] = i / 512)),
    };
    const source = analyserSource(fake);
    const into = new Float32Array(FFT_SIZE);
    expect(source.sampleRate).toBe(44100);
    expect(source.read(into)).toBe(FFT_SIZE);
    expect(into[FFT_SIZE - 1]).toBeCloseTo(511 / 512, 6);
  });

  test("a clip and a clock: speech while inside it, silence past its ends", () => {
    let at = 0.1;
    const source = bufferSource(vowel("o", 0.3), RATE, () => at);
    const into = new Float32Array(FFT_SIZE);
    expect(source.read(into)).toBe(FFT_SIZE);
    at = 5;
    expect(source.read(into)).toBe(0);
  });

  test("lip-sync over a phrase: the mouth moves with the vowels and shuts in the pauses", () => {
    const clip = phrase(RATE);
    let at = 0;
    const lips = new LipSync(bufferSource(clip, RATE, () => at));
    const opened: number[] = [];
    for (; at < clip.length / RATE; at += 1 / 60) opened.push(sum(lips.sample(1 / 60)));
    expect(Math.max(...opened)).toBeGreaterThan(0.4);
    expect(opened.at(-1)!).toBeLessThan(0.05);
    // The hiss is bright: it never opens the jaw much.
    const s = LipSync.analyse(hiss(0.05).subarray(0, FFT_SIZE), RATE);
    expect(s.aa).toBeLessThan(s.ee + s.ih);
    lips.use(null);
    for (let i = 0; i < 30; i++) lips.sample(1 / 60);
    expect(sum(lips.sample(1 / 60))).toBeLessThan(0.01);
  });
});
