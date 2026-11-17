// MOSS Voice's mouth (spec §6.6): what its player plays reaches every plugin with an entry in MOSS Voice's own point
// `moss.voice.speech` as a point message (`points.send`, `{ bot, frames, cut? }`), which a part that moves a mouth reads
// (`points.onMessage`). Filling the point is what its `fills` line on that plugin's OK card says.
//
// * Each scheduled stretch of samples is measured in hops of HOP samples (5.3 ms at 24 kHz): loudness as the hop's RMS,
//   brightness from its zero crossings. Four hops make one level (~21 ms: loudness the RMS of their loudness,
//   brightness weighted by it), stamped in epoch milliseconds from the audio clock at the moment they were scheduled,
//   and sent in batches of at most SPEECH_FRAMES_MAX, ahead of the clock.
// * The first batch of a burst goes at once; the rest every FLUSH_MS while any wait (one batch per tick), so a long
//   stretch is spread under the core's per-second window. With nothing buffered no timer runs.
// * An utterance the player stops or replaces sends `cut` (after what was already sent, in order): the unsent levels
//   of that bot are forgotten and a listener drops what it holds.
// * A send the core refuses is dropped: the mouth is a display, never a reason to fail the sound.

/** Levels in one batch at most (the SDK's `SPEECH_FRAMES_MAX`). */
export const SPEECH_FRAMES_MAX = 128;
/** Samples per measured hop. */
export const HOP = 128;
/** How many hops make one level. */
const MERGE = 4;
/** Between two batches while levels wait. */
export const FLUSH_MS = 100;

/** One hop as measured: its time on the audio clock (seconds), its loudness and its brightness (Hz). */
export interface HopFrame { t: number; rms: number; centroid: number }
export interface CueFrame { t: number; rms: number; centroid?: number }
export type SendCue = (bot: string, cue: { frames: readonly CueFrame[]; cut?: true }) => Promise<unknown> | unknown;

/** The hops of `samples` (mono, -1..1) starting at `start` seconds on the audio clock. */
export function measure(samples: Float32Array, sampleRate: number, start: number, hop = HOP): HopFrame[] {
  const out: HopFrame[] = [];
  for (let at = 0; at + hop <= samples.length; at += hop) {
    let sum = 0;
    let crossings = 0;
    for (let i = at; i < at + hop; i++) {
      const v = samples[i]!;
      sum += v * v;
      if (i > at && (v >= 0) !== (samples[i - 1]! >= 0)) crossings++;
    }
    out.push({ t: start + at / sampleRate, rms: Math.min(1, Math.sqrt(sum / hop)), centroid: Math.min(24_000, (crossings * sampleRate) / (2 * hop)) });
  }
  return out;
}

/** Four hops as one level: loudness the RMS of their loudness, brightness weighted by it. Stamps strictly rise. */
export function mergeLevels(frames: readonly HopFrame[], toEpoch: (t: number) => number): CueFrame[] {
  const out: CueFrame[] = [];
  let last = -Infinity;
  for (let i = 0; i < frames.length; i += MERGE) {
    const group = frames.slice(i, i + MERGE);
    const energy = group.reduce((a, f) => a + f.rms * f.rms, 0);
    const weight = group.reduce((a, f) => a + f.rms, 0);
    const t = Math.round(toEpoch(group[0]!.t));
    if (!(t > last) || !Number.isFinite(t)) continue;
    last = t;
    out.push({ t, rms: Math.min(1, Math.sqrt(energy / group.length)), ...(weight > 0 ? { centroid: group.reduce((a, f) => a + f.centroid * f.rms, 0) / weight } : {}) });
  }
  return out;
}

export interface CueClock {
  /** Epoch milliseconds. */
  wall(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realClock: CueClock = { wall: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** Batches the player's levels into speech cues, per bot, in order. */
export class SpeechCues {
  readonly #buffers = new Map<string, CueFrame[]>();
  readonly #chains = new Map<string, Promise<unknown>>();
  #timer: unknown = undefined;
  #sentAt = -Infinity;
  /** Levels sent (the test build's counter). */
  sent = 0;

  constructor(private readonly send: SendCue, private readonly clock: CueClock = realClock) {}

  /** The hops just scheduled for `bot`, with the audio clock now (to stamp them in epoch milliseconds). */
  frames(bot: string, frames: readonly HopFrame[], audioNow: number): void {
    const wall = this.clock.wall();
    const levels = mergeLevels(frames, (t) => wall + (t - audioNow) * 1000);
    if (levels.length === 0) return;
    const buffer = this.#buffers.get(bot) ?? [];
    this.#buffers.set(bot, buffer);
    buffer.push(...levels);
    this.#flushSoon();
  }

  cut(bot: string): void {
    this.#buffers.delete(bot);
    this.#post(bot, { frames: [], cut: true });
  }

  /** Stops for good: what is unsent is forgotten. */
  close(): void {
    if (this.#timer !== undefined) this.clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#buffers.clear();
  }

  get ticking(): boolean {
    return this.#timer !== undefined;
  }

  #flushSoon(): void {
    if (this.#timer !== undefined) return;
    const wait = Math.max(0, FLUSH_MS - (this.clock.wall() - this.#sentAt));
    this.#timer = this.clock.setTimeout(() => { this.#timer = undefined; this.#flush(); }, wait);
  }

  #flush(): void {
    this.#sentAt = this.clock.wall();
    for (const [bot, buffer] of this.#buffers) {
      const frames = buffer.splice(0, SPEECH_FRAMES_MAX);
      if (buffer.length === 0) this.#buffers.delete(bot);
      if (frames.length > 0) {
        this.sent += frames.length;
        this.#post(bot, { frames });
      }
    }
    if (this.#buffers.size > 0) this.#flushSoon();
  }

  /** In order per bot: a cut never overtakes the batch before it. */
  #post(bot: string, cue: Parameters<SendCue>[1]): void {
    const run = (): Promise<unknown> => Promise.resolve().then(() => this.send(bot, cue)).catch(() => undefined);
    this.#chains.set(bot, (this.#chains.get(bot) ?? Promise.resolve()).then(run));
  }
}
