// A speech feed made from mouth levels stamped in epoch milliseconds (`TimedSpeech`), for any part that moves a mouth:
// whoever plays the sound sends its levels in batches ahead of the clock (a point message, say), and the part that draws
// keeps them here by time, as the `SpeechFeed` the SDK's lip-sync reads (`LipSync`, `SpeechRing`).
//
// * The feed's clock is its own: seconds since the feed was made, `now()` read from the wall clock, a level's `t` its
//   stamp on that clock.
// * A batch is kept here by time and handed to the listeners only as it comes due (RELEASE_AHEAD_MS before its stamp),
//   in one call per tick, so a listener's ring never holds more than a moment of speech and a `cut` (the speech was
//   stopped or replaced) drops everything not yet released. What was released stays heard (at most RELEASE_AHEAD_MS).
// * `speaking` is true from the first level's stamp until SPEAKING_HOLD_MS after the last one's. One timer runs while
//   there is something to release or a change of `speaking` to come, and none otherwise: quiet costs no wakeups.
// * Bounds: a level more than KEEP_PAST_MS behind is dropped (stale), one more than AHEAD_MAX_MS ahead is ignored (another
//   device's clock), at most QUEUE_MAX are kept (the oldest go).
import type { SpeechFeed, SpeechFrame } from "../api/ui-api";

/** A level is handed to the listeners this long before its stamp. */
export const RELEASE_AHEAD_MS = 200;
/** How often a tick hands over what has come into that window, while levels wait. */
export const TICK_MS = 80;
/** `speaking` holds this long after the last level's stamp (a level is heard for at most 50 ms; a gap shorter than this inside one speech never flickers). */
export const SPEAKING_HOLD_MS = 150;
/** A level stamped more than this far in the past is dropped. */
export const KEEP_PAST_MS = 1_000;
/** A level stamped more than this far ahead is ignored. */
export const AHEAD_MAX_MS = 180_000;
/** Levels kept at most (about a minute of speech at 50 a second); beyond, the oldest go. */
export const QUEUE_MAX = 4_000;
/** The brightness of a level with none, in Hz. */
const DEFAULT_CENTROID = 1_500;
/** Released levels kept for a listener that subscribes mid-speech (this long behind now). */
const REPLAY_MS = 120;

/** A mouth level, and the plugin that sent it (a `cut` drops only its sender's). */
interface Level { t: number; rms: number; centroid: number; from: string }

export interface TimedSpeechClock {
  /** Epoch milliseconds. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realClock: TimedSpeechClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** What the feed has seen of the speech (counters for a test; cheap, always kept). Times are epoch ms. */
export interface TimedSpeechStats {
  /** Speech cues taken and the levels in them. */
  batches: number;
  levels: number;
  /** Levels handed to the listeners, and how far ahead of their stamps the first and the furthest went (ms; negative: late). */
  released: number;
  minAheadMs: number;
  maxAheadMs: number;
  /** Listeners hearing the feed now. */
  listeners: number;
  /** When `speaking` last turned true and false, and the stamps of the speech's first and last level. */
  onAt: number | undefined;
  offAt: number | undefined;
  firstT: number | undefined;
  lastT: number | undefined;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export class TimedSpeech implements SpeechFeed {
  readonly #clock: TimedSpeechClock;
  readonly #origin: number;
  readonly #listeners = new Set<(frames: readonly SpeechFrame[]) => void>();
  readonly #speakingListeners = new Set<(speaking: boolean) => void>();
  #queue: Level[] = [];
  #recent: Level[] = [];
  #timer: unknown = undefined;
  #closed = false;
  /** The stamps of the speech now going on: its first level, and the end of its last plus the hold. Undefined when none. */
  #start: number | undefined;
  #end: number | undefined;
  #speaking = false;
  readonly stats: TimedSpeechStats = { batches: 0, levels: 0, released: 0, minAheadMs: Infinity, maxAheadMs: -Infinity, listeners: 0, onAt: undefined, offAt: undefined, firstT: undefined, lastT: undefined };

  constructor(clock: TimedSpeechClock = realClock) {
    this.#clock = clock;
    this.#origin = clock.now();
  }

  /** The feed's clock, in the levels' seconds. */
  now(): number {
    return (this.#clock.now() - this.#origin) / 1000;
  }

  get speaking(): boolean {
    return this.#speaking;
  }

  /** A listener hears the levels as they come due; one that subscribes mid-speech also hears the last moment's. */
  subscribe(listener: (frames: readonly SpeechFrame[]) => void): () => void {
    this.#listeners.add(listener);
    this.stats.listeners = this.#listeners.size;
    const now = this.#clock.now();
    const replay = this.#recent.filter((l) => l.t > now - REPLAY_MS);
    if (replay.length > 0) listener(replay.map((l) => this.#frame(l)));
    return () => {
      this.#listeners.delete(listener);
      this.stats.listeners = this.#listeners.size;
    };
  }

  onSpeaking(listener: (speaking: boolean) => void): () => void {
    this.#speakingListeners.add(listener);
    return () => this.#speakingListeners.delete(listener);
  }

  /** A batch of levels (`{ frames, cut? }`; read again here: only finite numbers in range are kept), from the
   *  plugin `from`: its `cut` drops only that plugin's own levels. */
  accept(raw: unknown, from = ""): void {
    if (this.#closed || raw === null || typeof raw !== "object") return;
    const c = raw as { frames?: unknown; cut?: unknown };
    const now = this.#clock.now();
    if (c.cut === true) this.#cut(now, from);
    const list = Array.isArray(c.frames) ? (c.frames as unknown[]) : [];
    const fresh: Level[] = [];
    for (const f of list.slice(0, 4_096)) {
      const r = f as { t?: unknown; rms?: unknown; centroid?: unknown } | null;
      if (r === null || typeof r !== "object" || !num(r.t) || !num(r.rms)) continue;
      if (r.t < now - KEEP_PAST_MS || r.t > now + AHEAD_MAX_MS) continue;
      fresh.push({ t: r.t, rms: Math.min(1, Math.max(0, r.rms)), centroid: num(r.centroid) ? Math.min(24_000, Math.max(0, r.centroid)) : DEFAULT_CENTROID, from });
    }
    this.stats.batches += 1;
    this.stats.levels += fresh.length;
    if (fresh.length > 0) {
      fresh.sort((a, b) => a.t - b.t);
      const last = this.#queue.at(-1);
      this.#queue = last === undefined || fresh[0]!.t >= last.t ? this.#queue.concat(fresh) : this.#queue.concat(fresh).sort((a, b) => a.t - b.t);
      if (this.#queue.length > QUEUE_MAX) this.#queue.splice(0, this.#queue.length - QUEUE_MAX);
      const first = fresh[0]!.t;
      const end = fresh.at(-1)!.t + SPEAKING_HOLD_MS;
      // A new speech starts at its first level; one that arrives while another goes on carries it further.
      if (this.#end === undefined || now >= this.#end) {
        this.#start = first;
        this.stats.firstT = first;
      }
      this.#end = Math.max(this.#end ?? 0, end);
      this.stats.lastT = Math.max(this.stats.lastT ?? 0, fresh.at(-1)!.t);
    }
    this.#tick();
  }

  /** Takes cues again after a `close` (an effect that ran twice). */
  reopen(): void {
    this.#closed = false;
  }

  /** Stops (its part unmounts, or the effect that feeds it runs again): no timer and no level kept, and no cue taken
   *  until `reopen`. Its listeners stay, each ended by its own unsubscribe: a part's other effects that subscribed (a
   *  mouth, a lip-sync) outlive one run of the effect that feeds it, and must hear the levels after its `reopen`. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#queue = [];
    this.#recent = [];
    this.#start = undefined;
    this.#end = undefined;
    if (this.#speaking) this.#set(false, this.#clock.now());
  }

  /** Whether a timer is set (tests: a quiet bot has none). */
  get ticking(): boolean {
    return this.#timer !== undefined;
  }

  #frame(l: Level): SpeechFrame {
    return { t: (l.t - this.#origin) / 1000, rms: l.rms, centroid: l.centroid };
  }

  #cut(now: number, from: string): void {
    this.#queue = this.#queue.filter((l) => l.from !== from);
    const last = this.#queue.at(-1);
    if (last === undefined) {
      this.#start = undefined;
      this.#end = undefined;
      this.#set(false, now);
      return;
    }
    // Another sender's speech goes on: its own last level now ends it.
    this.#end = last.t + SPEAKING_HOLD_MS;
  }

  #set(speaking: boolean, now: number): void {
    if (speaking === this.#speaking) return;
    this.#speaking = speaking;
    if (speaking) this.stats.onAt = now;
    else this.stats.offAt = now;
    for (const l of [...this.#speakingListeners]) l(speaking);
  }

  #tick(): void {
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#closed) return;
    const now = this.#clock.now();
    // Hand over what is due within the window.
    let n = 0;
    while (n < this.#queue.length && this.#queue[n]!.t <= now + RELEASE_AHEAD_MS) n += 1;
    if (n > 0) {
      const due = this.#queue.splice(0, n);
      for (const l of due) {
        const ahead = l.t - now;
        this.stats.minAheadMs = Math.min(this.stats.minAheadMs, ahead);
        this.stats.maxAheadMs = Math.max(this.stats.maxAheadMs, ahead);
      }
      this.stats.released += due.length;
      this.#recent = this.#recent.filter((l) => l.t > now - REPLAY_MS).concat(due);
      const frames = due.map((l) => this.#frame(l));
      for (const l of [...this.#listeners]) l(frames);
    }
    // `speaking`: from the first stamp to the hold after the last.
    if (this.#start !== undefined && this.#end !== undefined) {
      if (now >= this.#end) { this.#start = undefined; this.#end = undefined; this.#set(false, now); }
      else if (now >= this.#start) this.#set(true, now);
    }
    // The next wake: when the next level comes into the window (never sooner than a tick, so dense levels cost ~12 wakeups a second), when `speaking` turns true, or when it turns false.
    let next = Infinity;
    if (this.#queue.length > 0) next = Math.max(TICK_MS, this.#queue[0]!.t - RELEASE_AHEAD_MS - now);
    if (this.#start !== undefined && now < this.#start) next = Math.min(next, this.#start - now);
    if (this.#end !== undefined && now < this.#end) next = Math.min(next, this.#end - now);
    if (next !== Infinity) this.#timer = this.#clock.setTimeout(() => { this.#timer = undefined; this.#tick(); }, Math.max(1, Math.ceil(next)));
  }
}
