// The bot's voice player: pieces → scheduled sources → frames and `speaking`; order; one utterance per bot; stop; mute; idle
// cost. A fake AudioContext (a clock the test moves and sources it ends by hand).
import { describe, expect, test } from "bun:test";
import { SpeechRing, frameSource, visemeWeights } from "../../../plugins/clover/plugins/vrm/src/lipsync/index";
import { VoiceStage, type AudioContextLike, type AudioSourceLike } from "../src/layer/clover/voice";
import type { VoicePiece } from "@waifucave/clover-plugin-sdk/ui/bridge";

class FakeSource implements AudioSourceLike {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  startedAt: number | undefined;
  stopped = false;
  connect() {}
  start(when?: number) { this.startedAt = when; }
  stop() { this.stopped = true; }
  end() { const f = this.onended; this.onended = null; f?.(); }
}
class FakeContext implements AudioContextLike {
  currentTime = 10;
  destination = {};
  outputLatency = 0.02;
  sources: FakeSource[] = [];
  buffers = 0;
  createBuffer(_c: number, length: number, sampleRate: number) {
    this.buffers++;
    const data = new Float32Array(length);
    return { getChannelData: () => data, duration: length / sampleRate };
  }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
}

/** `ms` of a loud tone as the core sends it: base64 of 16-bit little-endian samples at 24 kHz. */
function tone(ms: number, amp = 0.5): string {
  const n = Math.round(24 * ms);
  const bytes = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin(i / 3) * amp * 32767);
    bytes[i * 2] = v & 255;
    bytes[i * 2 + 1] = (v >> 8) & 255;
  }
  return btoa(String.fromCharCode(...bytes));
}
const piece = (seq: number, o: Partial<VoicePiece> = {}): VoicePiece => ({ bot: "luna", utterance: "u1", seq, audio: tone(100), format: "pcm16-24k", final: false, ...o });
const last = (seq: number, o: Partial<VoicePiece> = {}): VoicePiece => piece(seq, { audio: "", final: true, ...o });

function make() {
  const ctx = new FakeContext();
  let made = 0;
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const stage = new VoiceStage({
    audio: () => { made++; return ctx; },
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (h) => { (h as { live: boolean }).live = false; },
  });
  return { ctx, stage, made: () => made, timers };
}

describe("the voice player", () => {
  test("pieces play back to back on one context; frames follow the audio clock with the latency; speaking runs until the queue drains", () => {
    const { ctx, stage, made } = make();
    const heard: number[] = [];
    const seen: boolean[] = [];
    stage.feedOf("luna").subscribe((frames) => heard.push(...frames.map((f) => f.t)));
    stage.watch("luna", (s) => seen.push(s.speaking));
    stage.piece(piece(0));
    stage.piece(piece(1));
    expect(made()).toBe(1);
    expect(ctx.sources).toHaveLength(2);
    const [a, b] = ctx.sources as [FakeSource, FakeSource];
    expect(a.startedAt).toBeGreaterThanOrEqual(ctx.currentTime);
    expect(b.startedAt).toBeCloseTo(a.startedAt! + 0.1, 5);
    expect(heard.length).toBeGreaterThan(0);
    expect(heard[0]).toBeCloseTo(a.startedAt! + 0.02, 5);
    expect(Math.max(...heard)).toBeLessThanOrEqual(b.startedAt! + 0.1 + 0.02);
    expect(stage.speaking("luna")).toBe(true);
    stage.piece(last(2));
    a.end();
    expect(stage.speaking("luna")).toBe(true);
    b.end();
    expect(stage.speaking("luna")).toBe(false);
    expect(seen).toEqual([true, false]);
    // Loud tone → real loudness; the counters say what happened.
    const c = stage.counters();
    expect(c.pieces).toBe(3);
    expect(c.frames).toBeGreaterThan(0);
    expect(c.speaking).toEqual([]);
    expect(c.overlap).toBe(1);
  });

  test("a stage that subscribes mid-sentence hears the frames still ahead", () => {
    const { stage } = make();
    stage.piece(piece(0, { audio: tone(500) }));
    let got = 0;
    stage.feedOf("luna").subscribe((f) => (got += f.length));
    expect(got).toBeGreaterThan(0);
  });

  test("pieces out of order wait for the ones before them", () => {
    const { ctx, stage } = make();
    stage.piece(piece(1));
    expect(ctx.sources).toHaveLength(0);
    expect(stage.speaking("luna")).toBe(false);
    stage.piece(piece(0));
    expect(ctx.sources).toHaveLength(2);
    expect((ctx.sources[1] as FakeSource).startedAt!).toBeGreaterThan((ctx.sources[0] as FakeSource).startedAt!);
  });

  test("a new utterance of the same bot replaces the playing one; a straggler of the replaced one is dropped; another bot is unaffected", () => {
    const { ctx, stage } = make();
    stage.piece(piece(0));
    stage.piece(piece(0, { bot: "mira", utterance: "m1" }));
    const first = ctx.sources[0] as FakeSource;
    stage.piece(piece(0, { utterance: "u2" }));
    expect(first.stopped).toBe(true);
    expect((ctx.sources[1] as FakeSource).stopped).toBe(false);
    const before = ctx.sources.length;
    stage.piece(piece(1, { utterance: "u1" }));
    expect(ctx.sources).toHaveLength(before);
    expect(stage.speaking("luna")).toBe(true);
    expect(stage.speaking("mira")).toBe(true);
    // The player itself plays two bots at once; the voice mode's queue is what keeps it from happening.
    expect(stage.counters().overlap).toBe(2);
  });

  test("stop silences the bot at once and its late pieces are dropped", () => {
    const { ctx, stage } = make();
    stage.piece(piece(0));
    stage.piece(piece(1));
    stage.stop("luna");
    expect(ctx.sources.every((s) => (s as FakeSource).stopped)).toBe(true);
    expect(stage.speaking("luna")).toBe(false);
    stage.piece(piece(2));
    stage.piece(last(3));
    expect(ctx.sources).toHaveLength(2);
    expect(stage.speaking("luna")).toBe(false);
  });

  test("muted: nothing plays, nothing is made; muting while speaking stops it", () => {
    const { ctx, stage, made } = make();
    stage.piece(piece(0));
    stage.setMuted(true);
    expect(stage.speaking("luna")).toBe(false);
    expect((ctx.sources[0] as FakeSource).stopped).toBe(true);
    stage.piece(piece(0, { utterance: "u9" }));
    expect(ctx.sources).toHaveLength(1);
    expect(made()).toBe(1);
    stage.setMuted(false);
    stage.piece(piece(0, { utterance: "u10" }));
    expect(ctx.sources).toHaveLength(2);
  });

  test("only pcm16-24k plays; a bad piece is ignored", () => {
    const { ctx, stage, made } = make();
    stage.piece(piece(0, { format: "mp3" as never }));
    stage.piece({ ...piece(0), seq: -1 });
    stage.piece({ ...piece(0), audio: "!!!" });
    expect(ctx.sources).toHaveLength(0);
    expect(made()).toBe(0);
  });

  test("idle costs nothing: no context, no timer, no source until a piece comes; an utterance that ends with its final leaves no timer", () => {
    const { ctx, stage, made, timers } = make();
    expect(made()).toBe(0);
    expect(timers).toHaveLength(0);
    stage.piece(piece(0));
    stage.piece(last(1));
    (ctx.sources[0] as FakeSource).end();
    expect(timers.filter((t) => t.live)).toHaveLength(0);
    expect(stage.counters().speaking).toEqual([]);
  });

  test("an utterance that drains without its final ends on a stall timer, not forever", () => {
    const { ctx, stage, timers } = make();
    stage.piece(piece(0));
    (ctx.sources[0] as FakeSource).end();
    expect(stage.speaking("luna")).toBe(true);
    const t = timers.filter((x) => x.live);
    expect(t).toHaveLength(1);
    t[0]!.fn();
    expect(stage.speaking("luna")).toBe(false);
  });

  test("the avatars' own reading of the feed (a SpeechRing at the audio clock) finds the speech while it plays and silence after", () => {
    const { ctx, stage } = make();
    const feed = stage.feedOf("luna");
    const ring = new SpeechRing(48000, 0);
    feed.subscribe((frames) => ring.push(frames));
    const source = frameSource(ring, () => feed.now());
    expect(source.features()).toBeNull(); // nothing played yet
    stage.piece(piece(0, { audio: tone(300) }));
    stage.piece(last(1));
    const start = (ctx.sources[0] as FakeSource).startedAt!;
    ctx.currentTime = start + 0.1; // a hundred ms in (the output latency is in the frames' stamps)
    const heard = source.features();
    expect(heard).not.toBeNull();
    expect(heard!.rms).toBeGreaterThan(0.1);
    // The loud frame opens the mouth.
    expect(visemeWeights(heard!.rms, heard!.centroid)).not.toEqual(visemeWeights(0, 0));
    ctx.currentTime = start + 5; // long after: nothing sounds
    expect(source.features()).toBeNull();
  });
});
