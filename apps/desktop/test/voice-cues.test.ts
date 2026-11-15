// The app's player publishing its speech into the avatar cue API (interim, until Clover Voice's own plugin sends the cues):
// the player's frames become epoch-stamped levels in batches ahead of the clock, a stopped or replaced utterance cuts, and
// what the player plays never reaches a stage any other way.
import { describe, expect, test } from "bun:test";
import { FLUSH_MS, SpeechCueBridge, mergeLevels, type BridgeClock } from "../src/layer/clover/voice-cues";
import { VoiceStage, type AudioContextLike, type AudioSourceLike } from "../src/layer/clover/voice";
import type { VoicePiece } from "@waifucave/clover-plugin-sdk/ui/bridge";

function fakeClock(start = 1_800_000_000_000): BridgeClock & { advance(ms: number): void; timers(): number; at(): number } {
  let t = start;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    wall: () => t,
    at: () => t,
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
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const hops = (from: number, n: number, rms = 0.4) => Array.from({ length: n }, (_, i) => ({ t: from + i * 0.0053, rms, centroid: 1000 }));

describe("the player's speech as cue API levels", () => {
  test("four hops make one level, stamped in epoch ms from the audio clock, loudness their RMS, brightness weighted by it", () => {
    const levels = mergeLevels(hops(10, 8), (t) => 1_000_000 + (t - 10) * 1000);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toMatchObject({ t: 1_000_000, rms: 0.4, centroid: 1000 });
    expect(levels[1]!.t).toBe(Math.round(1_000_000 + 4 * 5.3));
    // A silent group has no brightness to give; stamps are strictly rising whatever the input.
    expect(mergeLevels(hops(10, 4, 0), (t) => t * 1000)[0]).not.toHaveProperty("centroid");
    expect(mergeLevels([{ t: 1, rms: 0.1, centroid: 1 }, { t: 1, rms: 0.1, centroid: 1 }], () => 5)).toHaveLength(1);
  });

  test("frames go in batches ahead of the clock: the first at once, then one batch a tick, at most 128 levels each; no timer while quiet", async () => {
    const clock = fakeClock();
    const sent: { bot: string; n: number; first: number; cut?: true }[] = [];
    const bridge = new SpeechCueBridge((bot, cue) => { sent.push({ bot, n: cue.frames.length, first: cue.frames[0]?.t ?? 0, ...(cue.cut ? { cut: true as const } : {})}); }, clock);
    expect(bridge.ticking).toBe(false);
    // Ten seconds of speech in one piece (1 887 hops), the player's audio clock at 10 s: the stamps run from now + 0.05 s.
    bridge.frames("luna", hops(10.05, 1_887), 10);
    expect(bridge.ticking).toBe(true);
    clock.advance(0);
    clock.advance(1);
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ bot: "luna", n: 128 });
    expect(sent[0]!.first).toBe(Math.round(1_800_000_000_000 + 50));
    // One batch a tick (under the core's window of 20 a second): each FLUSH_MS brings the next, and 1 887 hops are four batches.
    clock.advance(FLUSH_MS);
    await flush();
    expect(sent).toHaveLength(2);
    clock.advance(FLUSH_MS * 10);
    await flush();
    expect(sent).toHaveLength(4);
    expect(sent.every((s) => s.n <= 128)).toBe(true);
    expect(sent.reduce((a, s) => a + s.n, 0)).toBe(Math.ceil(1_887 / 4));
    expect(bridge.ticking).toBe(false);
    expect(clock.timers()).toBe(0);
  });

  test("a cut forgets that bot's unsent levels and goes after what was already sent, in order; another bot is untouched; a refused call is dropped", async () => {
    const clock = fakeClock();
    const order: string[] = [];
    let release: (() => void) | undefined;
    const bridge = new SpeechCueBridge((bot, cue) => {
      order.push(`${bot}:${cue.cut ? "cut" : cue.frames.length}`);
      if (order.length === 1) return new Promise<void>((r) => { release = r; }); // the first call is slow
      if (bot === "refused") throw new Error("refused");
    }, clock);
    bridge.frames("luna", hops(10, 1_000), 10);
    bridge.frames("alpha", hops(10, 20), 10);
    clock.advance(1);
    await flush();
    expect(order).toEqual(["luna:128", "alpha:5"]); // one batch for each bot a tick; the chain is per bot, so luna's slow call holds only luna's next
    bridge.cut("luna"); // before the next tick: the 122 levels still unsent are forgotten
    release?.();
    clock.advance(FLUSH_MS * 20);
    await flush();
    await flush();
    expect(order.filter((o) => o.startsWith("luna"))).toEqual(["luna:128", "luna:cut"]);
    expect(order).toContain("alpha:5");
    // A throwing send never reaches the player.
    bridge.frames("refused", hops(10, 8), 10);
    clock.advance(FLUSH_MS * 2);
    await flush();
    expect(order).toContain("refused:2");
    bridge.close();
    expect(bridge.ticking).toBe(false);
  });
});

describe("the player taps its frames and cuts", () => {
  class Src implements AudioSourceLike { buffer: unknown = null; onended: (() => void) | null = null; connect() {} start() {} stop() {} }
  const ctx: AudioContextLike & { currentTime: number } = {
    currentTime: 10, destination: {}, outputLatency: 0.02,
    createBuffer: (_c, length, sampleRate) => { const d = new Float32Array(length); return { getChannelData: () => d, duration: length / sampleRate }; },
    createBufferSource: () => new Src(),
  };
  const tone = (ms: number): string => {
    const n = Math.round(24 * ms);
    const bytes = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(i / 3) * 0.5 * 32767); bytes[i * 2] = v & 255; bytes[i * 2 + 1] = (v >> 8) & 255; }
    return btoa(String.fromCharCode(...bytes));
  };
  const piece = (seq: number, utterance: string, o: Partial<VoicePiece> = {}): VoicePiece => ({ bot: "luna", utterance, seq, audio: tone(100), format: "pcm16-24k", final: false, ...o });

  test("a scheduled piece's frames reach the tap with the audio clock; a stop and a newer utterance each cut", () => {
    const stage = new VoiceStage({ audio: () => ctx });
    const calls: string[] = [];
    stage.tap({ frames: (bot, frames, clock) => calls.push(`frames ${bot} ${frames.length > 0} ${clock}`), cut: (bot) => calls.push(`cut ${bot}`) });
    stage.piece(piece(0, "u1"));
    expect(calls).toEqual(["frames luna true 10"]);
    stage.piece(piece(0, "u2")); // replaces u1: cut, then the new one's frames
    expect(calls.slice(1)).toEqual(["cut luna", "frames luna true 10"]);
    stage.stop("luna");
    expect(calls.at(-1)).toBe("cut luna");
    stage.tap(undefined);
    stage.piece(piece(0, "u3"));
    expect(calls.at(-1)).toBe("cut luna");
  });
});
