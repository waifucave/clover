import { describe, expect, test } from "bun:test";
import { FFT_SIZE, rmsOf, spectralCentroidOf } from "../src/lipsync/features";
import { MouthSmoother, SHUT, SILENCE_RMS, VISEMES, visemeWeights, type VisemeWeights } from "../src/lipsync/visemes";
import { LipSync, PushedSpeech, SpeechRing, analyserSource, bufferSource, frameSource, ringSource, speechFrames, type AnalyserLike } from "../src/lipsync/sources";
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

describe("the speech feed", () => {
  test("the app side stamps each hop with when it is heard", () => {
    const frames = speechFrames(vowel("a", 0.1), RATE, 2.5);
    expect(frames.length).toBe(Math.ceil((0.1 * RATE) / FFT_SIZE));
    expect(frames[0]!.t).toBe(2.5);
    expect(frames[1]!.t).toBeCloseTo(2.5 + FFT_SIZE / RATE, 9);
    expect(Object.keys(frames[0]!).sort()).toEqual(["centroid", "rms", "t"]);
    expect(frames[5]!.rms).toBeGreaterThan(0.05);
    expect(frames[5]!.centroid).toBeGreaterThan(0);
  });

  test("a ring reads the frame sounding at a time; before, between and after, silence", () => {
    const ring = new SpeechRing(RATE, 0);
    ring.push(speechFrames(vowel("i", 0.2), RATE, 1));
    expect(ring.frameAt(0.99)).toBeNull();
    expect(ring.frameAt(1.05)!.rms).toBeGreaterThan(0.05);
    expect(ring.frameAt(1.3)).toBeNull();
    // A frame that is not a number in every field is dropped, never drawn.
    ring.push([{ t: 5, rms: Number.NaN, centroid: 900 }]);
    expect(ring.frameAt(5.001)).toBeNull();
  });

  test("a frame is heard until the next, never past 50 ms: a feed that stalls goes quiet", () => {
    const ring = new SpeechRing(RATE, 0);
    ring.push([
      { t: 1, rms: 0.2, centroid: 800 },
      { t: 1.01, rms: 0.3, centroid: 900 },
      { t: 1.2, rms: 0.4, centroid: 1000 },
    ]);
    expect(ring.frameAt(1.005)!.rms).toBe(0.2);
    expect(ring.frameAt(1.015)!.rms).toBe(0.3);
    // 190 ms to the next frame: the one before it is heard for 50 ms, then silence.
    expect(ring.frameAt(1.05)!.rms).toBe(0.3);
    expect(ring.frameAt(1.1)).toBeNull();
    // The newest is heard for 50 ms at most (its hop before it was longer).
    expect(ring.frameAt(1.24)!.rms).toBe(0.4);
    expect(ring.frameAt(1.3)).toBeNull();
  });

  test("lip-sync reads the feed at the audio clock: the mouth opens on the vowel, bright for i, dark for a", () => {
    let audio = 0;
    const feed = new PushedSpeech(() => audio);
    const ring = new SpeechRing(RATE, 0);
    feed.subscribe((frames) => ring.push(frames));
    feed.push(speechFrames(vowel("a", 0.3), RATE, 1));
    feed.push(speechFrames(vowel("i", 0.3), RATE, 2));
    const lips = new LipSync(frameSource(ring, () => audio));
    const settle = () => {
      let w = lips.sample(1 / 60);
      for (let i = 0; i < 20; i++) w = lips.sample(1 / 60);
      return w;
    };
    audio = 0.5;
    expect(Object.values(settle()).every((v) => v < 0.01)).toBe(true);
    audio = 1.15;
    const a = settle();
    audio = 2.15;
    const i = settle();
    expect(a.aa + a.oh).toBeGreaterThan(a.ih + a.ee);
    expect(i.ih + i.ee).toBeGreaterThan(i.aa + i.oh);
  });
});
