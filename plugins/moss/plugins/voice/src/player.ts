// MOSS Voice's player (spec §6.6), in its background part (`app.background`): it plays what the host half streams it
// (a bot's reply in its voice, pcm16-24k: 16-bit little-endian mono at 24 kHz, no header) on one AudioContext, one
// utterance at a time, and sends what it plays as mouth levels to the plugins that fill `moss.voice.speech` (`levels.ts`).
//
// The rule (MOSS Voice's own queue):
// * One utterance at a time from this plugin, and one voice at a time on the device: the utterance at the head of the
//   queue takes the device's speech turn (`device/speech`, P2) before it sounds, so another plugin's speech waits for it
//   and it waits for another's. The turn is let go when it ends here (played out, stopped or cut).
// * Same bot: a new reply replaces the one it is saying at once (the turn passes to it, so nothing slips in between),
//   and a newer reply waiting replaces the older one waiting. A reply the user asked for (the speak button) waits its
//   turn instead.
// * Two bots: the second waits until the first is done, first come first served.
// * The user holding push-to-talk stops whatever sounds and nothing starts until they let go (the listening half).
// * Muted (the plugin's "Speak replies" off): what plays stops and nothing new is taken.
// * Ended here means its last samples have played on the audio clock; where the clock doesn't run (no output), its
//   length from when it was scheduled, plus a little.
import { HOP, measure, type HopFrame } from "./levels";

export const SAMPLE_RATE = 24_000;
/** How far after `currentTime` the first stretch starts (so its first samples aren't clipped). */
const LEAD_SECONDS = 0.03;
/** Past an utterance's length, how long its end waits for the audio clock before it counts as ended anyway. */
export const END_SLACK_MS = 500;
/** An utterance whose stream hasn't ended goes after this long with nothing new. */
export const STALL_MS = 8_000;

/** What the player needs of the browser's audio (a fake in the tests). */
export interface AudioSourceLike {
  buffer: unknown;
  onended: (() => void) | null;
  connect(destination: unknown): unknown;
  start(when?: number): void;
  stop(): void;
  disconnect?(): void;
}
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  readonly outputLatency?: number;
  readonly baseLatency?: number;
  createBuffer(channels: number, length: number, sampleRate: number): { getChannelData(channel: number): Float32Array; readonly duration: number };
  createBufferSource(): AudioSourceLike;
  resume?(): Promise<void>;
}

/** The device's speech turn, as the platform grants it (`turns.take("device/speech")`). */
export interface DeviceTurn {
  done(): Promise<void> | void;
  readonly lost: Promise<unknown>;
}

export interface PlayerDeps {
  audio(): AudioContextLike;
  /** Takes `device/speech` for `bot`'s utterance; resolves when it is this player's turn. */
  take(bot: string): Promise<DeviceTurn>;
  cues: { frames(bot: string, frames: readonly HopFrame[], audioNow: number): void; cut(bot: string): void };
  /** Epoch milliseconds. */
  now?(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  /** Called after each change the test build's counters show. */
  changed?(): void;
}

export interface UtteranceMeta {
  bot: string;
  id: string;
  /** The user asked for it (the speak button): it waits its turn instead of replacing the bot's reply. */
  asked?: boolean;
}

type State = "waiting" | "taking" | "playing";

interface Utterance extends UtteranceMeta {
  state: State;
  held: Uint8Array[];
  carry?: number;
  ended: boolean;
  sources: Set<AudioSourceLike>;
  cursor: number;
  turn?: DeviceTurn;
  /** When it got the device (epoch ms). */
  since?: number;
  /** When it counts as ended at the latest (epoch ms), and the timer for it. */
  until: number;
  timer?: unknown;
  /** When its last bytes came (epoch ms). */
  last: number;
}

/** A turn span the player held, for the test build's counters: whose, and when (epoch ms). */
export interface Span { bot: string; id: string; from: number; to: number; cut: boolean }

export class SpeechPlayer {
  #ctx: AudioContextLike | undefined;
  #queue: Utterance[] = [];
  #retired: string[] = [];
  #holds = new Set<string>();
  #muted = false;
  #pieces = 0;
  #frames = 0;
  #cuts = 0;
  #overlap = 0;
  #spans: Span[] = [];
  readonly #d: PlayerDeps;
  readonly #now: () => number;
  readonly #setTimeout: (fn: () => void, ms: number) => unknown;
  readonly #clearTimeout: (h: unknown) => void;

  constructor(deps: PlayerDeps) {
    this.#d = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#setTimeout = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** What the test build shows: pieces received, levels' hops made, who speaks, the most at once, the replies cut by a
   *  newer one of their bot, and the spans it held the device's speech turn. */
  counters(): { pieces: number; frames: number; speaking: string[]; overlap: number; cut: number; spans: Span[] } {
    return { pieces: this.#pieces, frames: this.#frames, speaking: this.#queue.filter((u) => u.state === "playing").map((u) => u.bot), overlap: this.#overlap, cut: this.#cuts, spans: [...this.#spans] };
  }

  /** Whether `bot` is speaking now. */
  speaking(bot: string): boolean {
    return this.#queue.some((u) => u.bot === bot && u.state === "playing");
  }

  /** A new utterance; false when it isn't taken (muted). */
  begin(meta: UtteranceMeta): boolean {
    if (this.#muted) return false;
    const u: Utterance = { ...meta, state: "waiting", held: [], ended: false, sources: new Set(), cursor: 0, until: Infinity, last: this.#now() };
    if (meta.asked !== true) {
      // A newer reply of the bot's takes the place of one waiting.
      for (const w of this.#queue.slice(1)) if (w.bot === meta.bot && w.asked !== true) this.#drop(w, false);
      const head = this.#queue[0];
      if (head !== undefined && head.bot === meta.bot && head.asked !== true && this.#holds.size === 0) {
        // Same bot, its reply sounding: the new one replaces it at once, in its turn.
        const turn = head.state === "playing" ? head.turn : undefined;
        if (head.state === "playing") this.#cuts++;
        head.turn = undefined;
        this.#drop(head, true);
        this.#queue.unshift(u);
        if (turn !== undefined) this.#granted(u, turn);
        else this.#pump();
        this.#d.changed?.();
        return true;
      }
    }
    this.#queue.push(u);
    this.#pump();
    this.#d.changed?.();
    return true;
  }

  /** Bytes of utterance `id`, as they come. */
  push(id: string, bytes: Uint8Array): void {
    const u = this.#queue.find((x) => x.id === id);
    if (u === undefined || bytes.length === 0) return;
    this.#pieces++;
    u.last = this.#now();
    if (u.state === "playing") this.#schedule(u, bytes);
    else u.held.push(bytes);
    this.#d.changed?.();
  }

  /** Utterance `id`'s stream ended: it ends once what was scheduled has played. */
  end(id: string): void {
    const u = this.#queue.find((x) => x.id === id);
    if (u === undefined) return;
    u.ended = true;
    this.#settle(u);
  }

  /** The user's stop on a bot: what it says ends now, and what it has waiting goes. */
  stop(bot: string): void {
    for (const u of [...this.#queue].reverse()) if (u.bot === bot) this.#drop(u, true);
    this.#pump();
    this.#d.changed?.();
  }

  stopAll(): void {
    for (const u of [...this.#queue].reverse()) this.#drop(u, true);
    this.#d.changed?.();
  }

  /** Push-to-talk held (`on`) or let go: held, whatever sounds stops and nothing starts. */
  hold(utterance: string, on: boolean): void {
    if (on) {
      this.#holds.add(utterance);
      for (const u of [...this.#queue].reverse()) if (u.state !== "waiting") this.#drop(u, true);
    } else {
      this.#holds.delete(utterance);
      this.#pump();
    }
    this.#d.changed?.();
  }

  setMuted(muted: boolean): void {
    if (this.#muted === muted) return;
    this.#muted = muted;
    if (muted) this.stopAll();
  }

  get muted(): boolean {
    return this.#muted;
  }

  /** Whether an utterance id is gone (stopped, replaced or ended): its late bytes go nowhere. */
  gone(id: string): boolean {
    return this.#retired.includes(id) || !this.#queue.some((u) => u.id === id);
  }

  #pump(): void {
    const head = this.#queue[0];
    if (head === undefined || head.state !== "waiting" || this.#holds.size > 0) return;
    head.state = "taking";
    void this.#d.take(head.bot).then((turn) => {
      if (this.#queue[0] !== head || head.state !== "taking" || this.#holds.size > 0) {
        void Promise.resolve(turn.done()).catch(() => undefined);
        if (this.#queue[0] === head && head.state === "taking") head.state = "waiting";
        return;
      }
      this.#granted(head, turn);
    }, () => {
      // Refused (no `audio`, or the turn's queue went away): nothing sounds.
      if (this.#queue.includes(head)) this.#drop(head, false);
      this.#pump();
    });
  }

  #granted(u: Utterance, turn: DeviceTurn): void {
    u.turn = turn;
    u.state = "playing";
    u.since = this.#now();
    void turn.lost.then(() => {
      if (u.turn !== turn) return;
      u.turn = undefined;
      if (this.#queue.includes(u)) {
        this.#drop(u, true);
        this.#pump();
      }
    }, () => undefined);
    this.#overlap = Math.max(this.#overlap, this.#queue.filter((x) => x.state === "playing").length);
    for (const b of u.held.splice(0)) this.#schedule(u, b);
    this.#settle(u);
    this.#d.changed?.();
  }

  #context(): AudioContextLike {
    this.#ctx ??= this.#d.audio();
    return this.#ctx;
  }

  #schedule(u: Utterance, bytes: Uint8Array): void {
    // Whole 16-bit samples: a byte left over waits for the next piece.
    const whole = new Uint8Array((u.carry === undefined ? 0 : 1) + bytes.length);
    if (u.carry !== undefined) whole[0] = u.carry;
    whole.set(bytes, u.carry === undefined ? 0 : 1);
    u.carry = whole.length % 2 === 1 ? whole[whole.length - 1] : undefined;
    const n = whole.length >> 1;
    if (n === 0) return;
    const samples = new Float32Array(n);
    const view = new DataView(whole.buffer, whole.byteOffset, n * 2);
    for (let i = 0; i < n; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const ctx = this.#context();
    void ctx.resume?.();
    const buffer = ctx.createBuffer(1, n, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    // Back to back: each stretch starts where the one before ends, and never in the past.
    const start = Math.max(u.cursor, ctx.currentTime + (u.sources.size === 0 && u.cursor <= ctx.currentTime ? LEAD_SECONDS : 0));
    u.cursor = start + buffer.duration;
    src.onended = () => {
      u.sources.delete(src);
      src.disconnect?.();
      this.#settle(u);
    };
    u.sources.add(src);
    src.start(start);
    const latency = ctx.outputLatency ?? ctx.baseLatency ?? 0;
    const frames = measure(samples, SAMPLE_RATE, start + latency, HOP);
    this.#frames += frames.length;
    this.#d.cues.frames(u.bot, frames, ctx.currentTime);
    // Its end at the latest by the wall clock, for a device whose audio clock doesn't run.
    u.until = this.#now() + (u.cursor - ctx.currentTime) * 1000 + END_SLACK_MS;
    this.#arm(u);
  }

  #arm(u: Utterance): void {
    if (u.timer !== undefined) this.#clearTimeout(u.timer);
    const due = u.ended ? u.until : Math.max(u.until, u.last + STALL_MS);
    u.timer = this.#setTimeout(() => {
      u.timer = undefined;
      if (!this.#queue.includes(u)) return;
      if (u.ended) this.#finish(u);
      else if (this.#now() - u.last >= STALL_MS) {
        this.#drop(u, true);
        this.#pump();
      } else this.#arm(u);
    }, Math.max(0, due - this.#now()));
  }

  #settle(u: Utterance): void {
    if (u.state !== "playing" || this.#queue[0] !== u) return;
    if (u.ended && u.sources.size === 0 && u.held.length === 0) return this.#finish(u);
    if (u.ended && u.until === Infinity) u.until = this.#now();
    this.#arm(u);
  }

  /** Played out: it lets go of the device and the next one's turn comes. */
  #finish(u: Utterance): void {
    this.#remove(u, false);
    this.#pump();
    this.#d.changed?.();
  }

  /** Stopped, replaced or dropped: what sounds stops now and the mouth levels are cut. */
  #drop(u: Utterance, cut: boolean): void {
    for (const s of u.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // already stopped
      }
      s.disconnect?.();
    }
    u.sources.clear();
    u.held.length = 0;
    if (cut && u.state === "playing") this.#d.cues.cut(u.bot);
    this.#remove(u, cut);
  }

  #remove(u: Utterance, cut: boolean): void {
    const at = this.#queue.indexOf(u);
    if (at >= 0) this.#queue.splice(at, 1);
    if (u.timer !== undefined) this.#clearTimeout(u.timer);
    u.timer = undefined;
    this.#retired.push(u.id);
    if (this.#retired.length > 16) this.#retired.shift();
    if (u.since !== undefined) {
      this.#spans.push({ bot: u.bot, id: u.id, from: u.since, to: this.#now(), cut });
      if (this.#spans.length > 32) this.#spans.shift();
    }
    const turn = u.turn;
    u.turn = undefined;
    u.state = "waiting";
    if (turn !== undefined) void Promise.resolve(turn.done()).catch(() => undefined);
  }
}
