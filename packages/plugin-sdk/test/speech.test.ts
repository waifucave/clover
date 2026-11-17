// `TimedSpeech`, a speech feed from mouth levels stamped in epoch ms: kept by time and handed to the listeners as they come
// due; `speaking` follows the stamps; a cut forgets what is not yet released; quiet runs no timer.
import { describe, expect, test } from "bun:test";
import { AHEAD_MAX_MS, TimedSpeech, KEEP_PAST_MS, QUEUE_MAX, RELEASE_AHEAD_MS, SPEAKING_HOLD_MS, type TimedSpeechClock } from "../src/ui/speech";
import type { SpeechFrame } from "../src/api/ui-api";

/** A clock the test moves: timers fire in order as time passes. */
function fakeClock(start = 1_700_000_000_000): TimedSpeechClock & { advance(ms: number): void; timers(): number } {
  let t = start;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (h) => { pending.delete(h as number); },
    timers: () => pending.size,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (next === undefined) break;
        pending.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
      }
      t = end;
    },
  };
}

const levels = (from: number, n: number, step = 20, rms = 0.5) => Array.from({ length: n }, (_, i) => ({ t: from + i * step, rms, centroid: 1000 + i }));

describe("the stage's speech from the cue API", () => {
  test("a batch sent ahead is handed to the renderer as each level comes due, on the feed's own clock, never all at receipt", () => {
    const clock = fakeClock();
    const speech = new TimedSpeech(clock);
    const got: { at: number; frames: readonly SpeechFrame[] }[] = [];
    speech.subscribe((frames) => got.push({ at: clock.now(), frames }));
    const t0 = clock.now();
    speech.accept({ frames: levels(t0 + 2_000, 50) }); // a second of mouth, starting two seconds ahead
    expect(got).toEqual([]);
    clock.advance(1_700);
    expect(got).toEqual([]); // nothing yet: the first level is 2 s out and is released only RELEASE_AHEAD_MS before its stamp
    clock.advance(1_300);
    const all = got.flatMap((g) => g.frames);
    expect(all).toHaveLength(50);
    // Each level came no later than its stamp and no earlier than RELEASE_AHEAD_MS before it; the frame's t is the stage's own seconds.
    for (const g of got) for (const f of g.frames) {
      const stamp = t0 + f.t * 1000;
      expect(g.at).toBeLessThanOrEqual(stamp);
      expect(stamp - g.at).toBeLessThanOrEqual(RELEASE_AHEAD_MS + 1);
    }
    expect(all[0]).toEqual({ t: 2, rms: 0.5, centroid: 1000 });
    expect(speech.stats.released).toBe(50);
    expect(speech.stats.minAheadMs).toBeGreaterThanOrEqual(0);
    expect(speech.stats.maxAheadMs).toBeLessThanOrEqual(RELEASE_AHEAD_MS);
    expect(speech.now()).toBeCloseTo((clock.now() - t0) / 1000, 6);
  });

  test("speaking turns true at the first stamp, not at receipt, and false a hold after the last; no timer runs while quiet", () => {
    const clock = fakeClock();
    const speech = new TimedSpeech(clock);
    const changes: [boolean, number][] = [];
    speech.onSpeaking((s) => changes.push([s, clock.now()]));
    expect(speech.ticking).toBe(false);
    const t0 = clock.now();
    speech.accept({ frames: levels(t0 + 1_000, 20) }); // 1.0 s to 1.38 s
    expect(speech.speaking).toBe(false);
    clock.advance(3_000);
    expect(changes).toEqual([[true, t0 + 1_000], [false, t0 + 1_000 + 19 * 20 + SPEAKING_HOLD_MS]]);
    expect(speech.ticking).toBe(false);
    expect(clock.timers()).toBe(0);
  });

  test("a cut forgets every level not yet released and ends the speech; a new speech after it starts at its own first stamp", () => {
    const clock = fakeClock();
    const speech = new TimedSpeech(clock);
    const heard: number[] = [];
    speech.subscribe((frames) => heard.push(...frames.map((f) => f.rms)));
    const t0 = clock.now();
    speech.accept({ frames: levels(t0 + 100, 100, 20, 0.9) });
    clock.advance(400);
    const before = heard.length;
    expect(before).toBeGreaterThan(0);
    expect(speech.speaking).toBe(true);
    speech.accept({ frames: [], cut: true });
    expect(speech.speaking).toBe(false);
    clock.advance(5_000);
    expect(heard).toHaveLength(before);
    speech.accept({ frames: levels(clock.now() + 500, 5, 20, 0.2) });
    clock.advance(2_000);
    expect(heard.slice(before)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);
  });

  test("a cut drops only its own sender's levels: another plugin's speech goes on", () => {
    const clock = fakeClock();
    const speech = new TimedSpeech(clock);
    const heard: number[] = [];
    speech.subscribe((frames) => heard.push(...frames.map((f) => f.rms)));
    const t0 = clock.now();
    speech.accept({ frames: levels(t0 + 100, 50, 20, 0.9) }, "moss/voice");
    speech.accept({ frames: levels(t0 + 110, 50, 20, 0.3) }, "acme-voice");
    clock.advance(200);
    const before = heard.length;
    speech.accept({ frames: [], cut: true }, "moss/voice");
    expect(speech.speaking).toBe(true);
    clock.advance(2_000);
    const after = heard.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((rms) => rms === 0.3)).toBe(true);
    speech.accept({ frames: [], cut: true }, "acme-voice");
    clock.advance(2_000);
    expect(speech.speaking).toBe(false);
  });

  test("stale levels are dropped, levels absurdly far ahead are ignored, the queue is bounded, and bad numbers are never taken", () => {
    const clock = fakeClock();
    const speech = new TimedSpeech(clock);
    const t0 = clock.now();
    speech.accept({ frames: [{ t: t0 - KEEP_PAST_MS - 1, rms: 1 }, { t: t0 + AHEAD_MAX_MS + 1, rms: 1 }, { t: Number.NaN, rms: 1 }, { t: t0 + 50, rms: Number.POSITIVE_INFINITY }, { t: t0 + 60, rms: "loud" }, null, { t: t0 + 70, rms: 7, centroid: -3 }] });
    expect(speech.stats.levels).toBe(1);
    const heard: SpeechFrame[] = [];
    speech.subscribe((f) => heard.push(...f));
    clock.advance(500);
    expect(heard).toEqual([{ t: 0.07, rms: 1, centroid: 0 }]); // clamped: loudness to 1, brightness to 0
    const before = speech.stats.released;
    for (let i = 0; i < 5; i++) speech.accept({ frames: levels(clock.now() + 10_000 + i * 21_000, 1_000) }); // 5 000 levels, 100 s ahead at most
    clock.advance(130_000);
    expect(speech.stats.released - before).toBe(QUEUE_MAX); // the oldest 1 000 went; the rest were all heard
  });

  test("levels with no brightness read as a middle vowel; a renderer that subscribes mid-speech hears the last moment's levels; close ends it all", () => {
    const clock = fakeClock();
    const speech = new TimedSpeech(clock);
    const t0 = clock.now();
    speech.accept({ frames: levels(t0 + 10, 30, 10).map(({ t, rms }) => ({ t, rms })) });
    clock.advance(100);
    const late: SpeechFrame[] = [];
    speech.subscribe((f) => late.push(...f));
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((f) => f.centroid === 1_500)).toBe(true);
    expect(late.every((f) => (t0 + f.t * 1000) > clock.now() - 120)).toBe(true);
    speech.close();
    speech.accept({ frames: levels(clock.now() + 10, 5) });
    expect(speech.ticking).toBe(false);
  });

  test("a listener that subscribed in another effect still hears the levels after the feeding effect closes and reopens the feed", () => {
    const clock = fakeClock();
    const speech = new TimedSpeech(clock);
    const heard: SpeechFrame[] = [];
    const turns: boolean[] = [];
    const off = speech.subscribe((f) => heard.push(...f));
    speech.onSpeaking((on) => turns.push(on));
    speech.accept({ frames: levels(clock.now() + 10, 5) });
    clock.advance(30);
    speech.close();
    expect(turns).toEqual([true, false]);
    speech.reopen();
    const before = heard.length;
    speech.accept({ frames: levels(clock.now() + 10, 5) });
    clock.advance(400);
    expect(heard.length - before).toBe(5);
    expect(turns).toEqual([true, false, true, false]);
    off();
    speech.accept({ frames: levels(clock.now() + 10, 5) });
    clock.advance(400);
    expect(heard.length - before).toBe(5);
  });
});
