// The speech an `avatar` frame lip-syncs to (src/ui/speech.ts): the stage's side sends the feed's frames on in batches
// while there are any and the frame can be seen, and nothing (no timer at all) while the bot is quiet; the frame's side
// turns the batches back into a feed whose clock runs on between them; only numbers cross.
import { describe, expect, test } from "bun:test";
import type { SpeechFeed, SpeechFrame } from "../src/api/ui-api";
import { cleanSpeechMessage, ReceivedSpeech, SPEECH_BATCH_MAX, SPEECH_FLUSH_MS, SpeechForwarder, type ForwarderTimers, type SpeechMessage } from "../src/ui/speech";

/** Timers the test moves by hand, counting what was ever scheduled. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const intervals = new Map<number, { fn: () => void; ms: number; at: number }>();
  let scheduled = 0;
  const timers: ForwarderTimers = {
    setInterval: (fn, ms) => {
      scheduled++;
      const id = next++;
      intervals.set(id, { fn, ms, at: now + ms });
      return id;
    },
    clearInterval: (h) => void intervals.delete(h as number),
    wall: () => 1_000_000 + now,
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...intervals.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      now = due[1].at;
      due[1].at += due[1].ms;
      due[1].fn();
    }
    now = end;
  };
  return { timers, advance, running: () => intervals.size, scheduled: () => scheduled, now: () => now };
}

/** A feed the test pushes frames into, on its own audio clock. */
function pushedFeed(clock: () => number) {
  const listeners = new Set<(frames: readonly SpeechFrame[]) => void>();
  const feed: SpeechFeed = {
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    now: clock,
  };
  return { feed, push: (frames: SpeechFrame[]) => listeners.forEach((l) => l(frames)), listeners };
}

/** The app's frames: one every ~11.6 ms of audio (a 512-sample hop at 44.1 kHz). */
const HOP = 512 / 44_100;
const frameAt = (i: number, rms = 0.2): SpeechFrame => ({ t: i * HOP, rms, centroid: 1800 });

describe("the stage's side (SpeechForwarder)", () => {
  test("a quiet bot: no timer is ever scheduled and nothing is sent, however long", () => {
    const t = fakeTimers();
    const { feed } = pushedFeed(() => t.now() / 1000);
    const sent: SpeechMessage[] = [];
    const f = new SpeechForwarder(feed, (m) => sent.push(m), t.timers);
    f.setOpen(true);
    f.setSpeaking(false);
    t.advance(60_000);
    expect(sent).toEqual([]);
    expect(t.scheduled()).toBe(0);
    expect(f.ticking).toBe(false);
  });

  test("speaking: batches every 40 ms (about 25 a second), never a message per frame; every frame arrives, in order; then the timer stops", () => {
    const t = fakeTimers();
    const { feed, push } = pushedFeed(() => t.now() / 1000);
    const sent: SpeechMessage[] = [];
    const f = new SpeechForwarder(feed, (m) => sent.push(m), t.timers);
    f.setOpen(true);
    f.setSpeaking(true);
    // One second of speech, frames pushed as the audio is analysed (a few at a time, every ~11.6 ms).
    let i = 0;
    for (let ms = 0; ms < 1000; ms += 12) {
      push([frameAt(i++)]);
      t.advance(12);
    }
    t.advance(SPEECH_FLUSH_MS * 2);
    const frames = sent.flatMap((m) => m.frames);
    expect(frames.length).toBe(i);
    expect(frames.map((x) => x.t)).toEqual([...Array(i).keys()].map((k) => k * HOP));
    expect(sent.length).toBeGreaterThanOrEqual(20);
    expect(sent.length).toBeLessThanOrEqual(30);
    expect(sent.length).toBeLessThan(i / 2);
    expect(sent.every((m) => m.speaking)).toBe(true);
    // Each batch tells the frame the stage's audio clock against the wall clock.
    expect(sent[3]!.clock.wall - 1_000_000).toBeCloseTo(sent[3]!.clock.audio * 1000, 5);
    // Drained: no timer left running.
    expect(f.ticking).toBe(false);
    expect(t.running()).toBe(0);
    // The end of speech is sent at once, and then nothing more.
    const before = sent.length;
    f.setSpeaking(false);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)).toMatchObject({ speaking: false, frames: [] });
    t.advance(10_000);
    expect(sent.length).toBe(before + 1);
    expect(t.running()).toBe(0);
  });

  test("the first frame waits at most one flush (≤ 40 ms), and a burst goes in batches of at most 64", () => {
    const t = fakeTimers();
    const { feed, push } = pushedFeed(() => 0);
    const sent: SpeechMessage[] = [];
    const f = new SpeechForwarder(feed, (m) => sent.push(m), t.timers);
    f.setOpen(true);
    push([frameAt(0)]);
    t.advance(SPEECH_FLUSH_MS - 1);
    expect(sent).toHaveLength(0);
    t.advance(1);
    expect(sent).toHaveLength(1);
    push([...Array(150).keys()].map((k) => frameAt(k + 1)));
    t.advance(SPEECH_FLUSH_MS * 3);
    expect(sent.slice(1).map((m) => m.frames.length)).toEqual([SPEECH_BATCH_MAX, SPEECH_BATCH_MAX, 150 - 2 * SPEECH_BATCH_MAX]);
    expect(f.ticking).toBe(false);
  });

  test("hidden, asleep or gone (closed): nothing is heard, kept or sent; opened again it starts from what comes next", () => {
    const t = fakeTimers();
    const { feed, push, listeners } = pushedFeed(() => 0);
    const sent: SpeechMessage[] = [];
    const f = new SpeechForwarder(feed, (m) => sent.push(m), t.timers);
    f.setOpen(true);
    f.setSpeaking(true);
    push([frameAt(0)]);
    f.setOpen(false); // the window hidden before the flush
    expect(listeners.size).toBe(0);
    expect(f.ticking).toBe(false);
    push([frameAt(1)]);
    t.advance(1000);
    const whileClosed = sent.length;
    expect(sent.flatMap((m) => m.frames)).not.toContainEqual(frameAt(0));
    // Back in view while the bot still speaks: told at once, then the new frames only.
    f.setOpen(true);
    expect(sent.length).toBe(whileClosed + 1);
    expect(sent.at(-1)).toMatchObject({ speaking: true, frames: [] });
    push([frameAt(2)]);
    t.advance(SPEECH_FLUSH_MS);
    expect(sent.flatMap((m) => m.frames)).toEqual([frameAt(2)]);
    f.close();
    expect(listeners.size).toBe(0);
    push([frameAt(3)]);
    t.advance(1000);
    expect(sent.flatMap((m) => m.frames)).toEqual([frameAt(2)]);
    expect(t.running()).toBe(0);
  });
});

describe("what crosses (cleanSpeechMessage)", () => {
  const ok = { speaking: true, clock: { audio: 1.5, wall: 1000 }, frames: [{ t: 1.5, rms: 0.3, centroid: 1200 }] };

  test("numbers only, in range; anything else is no batch", () => {
    expect(cleanSpeechMessage(ok)).toEqual(ok);
    // Loudness and brightness are clamped; anything a page adds is dropped.
    expect(cleanSpeechMessage({ ...ok, text: "hello", frames: [{ t: 1, rms: 7, centroid: -3, audio: "AAAA" }] })).toEqual({ ...ok, frames: [{ t: 1, rms: 1, centroid: 0 }] });
    for (const bad of [
      null, "x", { ...ok, speaking: "yes" }, { ...ok, clock: { audio: Number.NaN, wall: 1 } }, { ...ok, clock: null },
      { ...ok, frames: "x" }, { ...ok, frames: [{ t: "1", rms: 0, centroid: 0 }] }, { ...ok, frames: [{ t: 1, rms: Infinity, centroid: 0 }] },
      { ...ok, frames: [() => 1] }, { ...ok, frames: Array.from({ length: SPEECH_BATCH_MAX + 1 }, () => ok.frames[0]) },
    ]) expect(cleanSpeechMessage(bad)).toBeUndefined();
  });
});

describe("the frame's side (ReceivedSpeech)", () => {
  test("a feed of the parent's frames, its clock running on by the wall clock between batches, and whether the bot speaks", () => {
    let wall = 5_000;
    const r = new ReceivedSpeech(() => wall);
    expect(r.now()).toBe(0);
    const got: SpeechFrame[][] = [];
    const speaking: boolean[] = [];
    const off = r.subscribe((frames) => got.push([...frames]));
    r.onSpeaking((s) => speaking.push(s));
    r.accept({ speaking: true, clock: { audio: 12, wall: 5_000 }, frames: [{ t: 12, rms: 0.2, centroid: 900 }] });
    expect(got).toEqual([[{ t: 12, rms: 0.2, centroid: 900 }]]);
    expect(r.speaking).toBe(true);
    wall += 250;
    expect(r.now()).toBeCloseTo(12.25, 6);
    // A batch with no frames (the end of speech) tells no listener of frames.
    r.accept({ speaking: false, clock: { audio: 12.3, wall: 5_300 }, frames: [] });
    expect(got).toHaveLength(1);
    expect(speaking).toEqual([true, false]);
    off();
    r.accept({ speaking: true, clock: { audio: 13, wall: 6_000 }, frames: [{ t: 13, rms: 0.1, centroid: 500 }] });
    expect(got).toHaveLength(1);
  });
});
