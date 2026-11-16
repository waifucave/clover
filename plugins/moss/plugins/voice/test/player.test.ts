// MOSS Voice's player (../src/player.ts) against a fake audio clock, a fake device turn and a fake cue sink: one
// utterance at a time in the device's speech turn, a bot's new reply replacing its own at once (in the same turn), an
// asked one waiting, two bots first come first served, the user's stop and hold, the mute, and the mouth's cues.
import { describe, expect, test } from "bun:test";
import { SpeechPlayer, END_SLACK_MS, type AudioContextLike, type AudioSourceLike, type DeviceTurn } from "../src/player";
import { mergeLevels, measure, SpeechCues, SPEECH_FRAMES_MAX, FLUSH_MS } from "../src/levels";

class FakeAudio implements AudioContextLike {
  currentTime = 0;
  readonly destination = {};
  readonly sources: (AudioSourceLike & { at?: number; dur: number; stopped: boolean })[] = [];
  createBuffer(_c: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data, duration: length / rate };
  }
  createBufferSource() {
    const s = { buffer: undefined as unknown, onended: null as (() => void) | null, at: undefined as number | undefined, dur: 0, stopped: false,
      connect: () => undefined, start(when?: number) { s.at = when ?? 0; s.dur = (s.buffer as { duration: number }).duration; }, stop() { s.stopped = true; } };
    this.sources.push(s);
    return s;
  }
  /** Moves the audio clock on, ending the sources whose end has passed. */
  advance(seconds: number): void {
    this.currentTime += seconds;
    for (const s of this.sources) if (!s.stopped && s.at !== undefined && s.at + s.dur <= this.currentTime + 1e-9 && s.onended) { const f = s.onended; s.onended = null; f(); }
  }
}

function harness() {
  const audio = new FakeAudio();
  let now = 1_000_000;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const log: string[] = [];
  const cues: { bot: string; frames: number; cut?: boolean }[] = [];
  /** The device turn as the platform runs it: one holder, first come first served. */
  let holder: string | undefined;
  const waiting: { bot: string; grant: (t: DeviceTurn) => void }[] = [];
  const grant = (bot: string, resolve: (t: DeviceTurn) => void) => {
    holder = bot;
    log.push(`grant ${bot}`);
    let lose!: (r: unknown) => void;
    const lost = new Promise<unknown>((r) => { lose = r; });
    const t: DeviceTurn & { lose: (r: unknown) => void } = {
      lost, lose,
      done: () => {
        if (holder !== bot) return;
        log.push(`done ${bot}`);
        holder = undefined;
        const next = waiting.shift();
        if (next) grant(next.bot, next.grant);
      },
    };
    turns.push(t);
    resolve(t);
  };
  const turns: (DeviceTurn & { lose: (r: unknown) => void })[] = [];
  const player = new SpeechPlayer({
    audio: () => audio,
    take: (bot) => new Promise((resolve) => (holder === undefined ? grant(bot, resolve) : waiting.push({ bot, grant: resolve }))),
    cues: { frames: (bot, f) => cues.push({ bot, frames: f.length }), cut: (bot) => cues.push({ bot, frames: 0, cut: true }) },
    now: () => now,
    setTimeout: (fn, ms) => { const t = { at: now + ms, fn, dead: false }; timers.push(t); return t; },
    clearTimeout: (h) => { (h as { dead: boolean }).dead = true; },
  });
  const tick = async (ms: number) => {
    now += ms;
    audio.advance(ms / 1000);
    for (const t of timers.filter((x) => !x.dead && x.at <= now)) { t.dead = true; t.fn(); }
    await Promise.resolve();
    await Promise.resolve();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const occupy = (bot: string) => new Promise<DeviceTurn>((resolve) => (holder === undefined ? grant(bot, resolve) : waiting.push({ bot, grant: resolve })));
  return { audio, player, log, cues, turns, tick, settle, occupy, get holder() { return holder; }, get now() { return now; } };
}

/** `seconds` of a 220 Hz tone, pcm16-24k. */
function tone(seconds: number): Uint8Array {
  const n = Math.round(seconds * 24_000);
  const out = new Uint8Array(n * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 220 * i) / 24_000) * 12_000), true);
  return out;
}

describe("the player", () => {
  test("plays an utterance in the device's speech turn, sends its mouth, and lets the turn go when it has played", async () => {
    const h = harness();
    expect(h.player.begin({ bot: "alpha", id: "u1" })).toBe(true);
    await h.settle();
    expect(h.holder).toBe("alpha");
    h.player.push("u1", tone(0.5));
    h.player.end("u1");
    expect(h.player.speaking("alpha")).toBe(true);
    expect(h.cues.some((c) => c.bot === "alpha" && c.frames > 0)).toBe(true);
    await h.tick(400);
    expect(h.holder).toBe("alpha");
    await h.tick(200);
    expect(h.holder).toBeUndefined();
    expect(h.player.speaking("alpha")).toBe(false);
    const c = h.player.counters();
    expect(c.spans.length).toBe(1);
    expect(c.spans[0]!.cut).toBe(false);
  });

  test("a bot's newer reply replaces its own at once, in the same turn; an asked one waits", async () => {
    const h = harness();
    h.player.begin({ bot: "alpha", id: "u1" });
    await h.settle();
    h.player.push("u1", tone(1));
    h.player.begin({ bot: "alpha", id: "asked", asked: true });
    h.player.begin({ bot: "alpha", id: "u2" });
    await h.settle();
    expect(h.player.counters().cut).toBe(1);
    expect(h.cues.some((c) => c.cut)).toBe(true);
    // The turn passed straight on: one grant only.
    expect(h.log).toEqual(["grant alpha"]);
    expect(h.player.gone("u1")).toBe(true);
    h.player.push("u2", tone(0.2));
    h.player.end("u2");
    await h.tick(1000);
    // Then the asked one, in a turn of its own.
    expect(h.log).toEqual(["grant alpha", "done alpha", "grant alpha"]);
  });

  test("two bots: the second waits for the first, first come first served; never two at once", async () => {
    const h = harness();
    h.player.begin({ bot: "alpha", id: "a" });
    h.player.begin({ bot: "sunny", id: "s" });
    await h.settle();
    h.player.push("s", tone(0.2));
    h.player.end("s");
    h.player.push("a", tone(0.3));
    h.player.end("a");
    expect(h.player.speaking("sunny")).toBe(false);
    await h.tick(1000);
    await h.settle();
    await h.tick(1000);
    expect(h.log).toEqual(["grant alpha", "done alpha", "grant sunny", "done sunny"]);
    expect(h.player.counters().overlap).toBe(1);
    const [a, s] = h.player.counters().spans;
    expect(s!.from).toBeGreaterThanOrEqual(a!.to);
  });

  test("another plugin holding the device turn: this one waits for it", async () => {
    const h = harness();
    const chime = await h.occupy("chime");
    h.player.begin({ bot: "alpha", id: "u1" });
    await h.settle();
    h.player.push("u1", tone(0.2));
    expect(h.player.speaking("alpha")).toBe(false);
    chime.done();
    await h.settle();
    expect(h.holder).toBe("alpha");
    expect(h.player.speaking("alpha")).toBe(true);
  });

  test("the user's stop, the hold of push-to-talk and the mute", async () => {
    const h = harness();
    h.player.begin({ bot: "alpha", id: "u1" });
    await h.settle();
    h.player.push("u1", tone(2));
    h.player.stop("alpha");
    expect(h.holder).toBeUndefined();
    expect(h.player.counters().spans[0]!.cut).toBe(true);
    h.player.begin({ bot: "alpha", id: "u2" });
    await h.settle();
    h.player.hold("ptt1", true);
    expect(h.holder).toBeUndefined();
    h.player.begin({ bot: "alpha", id: "u3" });
    await h.settle();
    expect(h.holder).toBeUndefined();
    h.player.hold("ptt1", false);
    await h.settle();
    expect(h.holder).toBe("alpha");
    h.player.setMuted(true);
    expect(h.holder).toBeUndefined();
    expect(h.player.begin({ bot: "alpha", id: "u4" })).toBe(false);
  });

  test("where the audio clock doesn't run, an utterance ends by its length and a little", async () => {
    const h = harness();
    h.player.begin({ bot: "alpha", id: "u1" });
    await h.settle();
    h.player.push("u1", tone(0.5));
    h.player.end("u1");
    // The wall clock moves, the audio clock doesn't.
    h.audio.advance = () => undefined;
    await h.tick(500 + END_SLACK_MS - 50);
    expect(h.holder).toBe("alpha");
    await h.tick(100);
    expect(h.holder).toBeUndefined();
  });

  test("a turn the platform ends (its limit) stops the utterance", async () => {
    const h = harness();
    h.player.begin({ bot: "alpha", id: "u1" });
    await h.settle();
    h.player.push("u1", tone(1));
    h.turns[0]!.lose("limit");
    await h.settle();
    expect(h.player.speaking("alpha")).toBe(false);
  });
});

describe("the mouth's levels", () => {
  test("hops merge into rising levels; cues go in batches, a cut after what was sent", async () => {
    const samples = new Float32Array(24_000).map((_, i) => Math.sin((2 * Math.PI * 220 * i) / 24_000) * 0.5);
    const hops = measure(samples, 24_000, 10);
    expect(hops.length).toBe(Math.floor(24_000 / 128));
    expect(hops[0]!.rms).toBeGreaterThan(0.3);
    const levels = mergeLevels(hops, (t) => 1_000_000 + t * 1000);
    expect(levels.length).toBe(Math.ceil(hops.length / 4));
    for (let i = 1; i < levels.length; i++) expect(levels[i]!.t).toBeGreaterThan(levels[i - 1]!.t);
    const sent: { bot: string; n: number; cut?: true }[] = [];
    let wall = 0;
    const timers: (() => void)[] = [];
    const cues = new SpeechCues((bot, c) => { sent.push({ bot, n: c.frames.length, ...(c.cut ? { cut: true as const } : {}) }); }, { wall: () => wall, setTimeout: (fn) => { timers.push(fn); return fn; }, clearTimeout: () => undefined });
    cues.frames("alpha", hops, 10);
    expect(cues.ticking).toBe(true);
    while (timers.length > 0) { wall += FLUSH_MS; timers.shift()!(); await Promise.resolve(); }
    cues.cut("alpha");
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.every((s) => s.n <= SPEECH_FRAMES_MAX)).toBe(true);
    expect(sent.reduce((n, s) => n + s.n, 0)).toBe(levels.length);
    expect(sent.at(-1)).toEqual({ bot: "alpha", n: 0, cut: true });
  });
});
