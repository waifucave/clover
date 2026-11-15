// The app's player, publishing its speech into the avatar cue API's speech path (interim: Clover Voice's own plugin
// sends these cues from its background part when voice leaves the core, and this file goes with the player). The stage
// takes its mouth from the cue API only; this is how what the player plays reaches it.
//
// * Each piece's frames (5.3 ms hops, on the audio clock) are merged into ~21 ms levels (four hops: loudness as their RMS,
//   brightness weighted by loudness), stamped in epoch milliseconds from the audio clock at the moment they were made, and
//   sent in `avatar.cue({ type: "speech", frames }, { bot })` batches of at most SPEECH_FRAMES_MAX, ahead of the clock.
// * The first batch of a burst goes at once; the rest every FLUSH_MS while any wait (one batch per tick), so a long piece
//   is spread under the core's per-second window. With nothing buffered no timer runs.
// * An utterance the player stops or replaces sends `cut` (after what was already sent, in order): the unsent levels of that
//   bot are forgotten and the stage drops what it holds.
// * A call the core refuses or answers `no-renderer` is dropped: the mouth is a display, never a reason to fail the sound.
import type { SpeechTap } from "./voice";

/** Levels in one batch at most (the SDK's `SPEECH_FRAMES_MAX`; the layer doesn't import the SDK's root). */
const SPEECH_FRAMES_MAX = 128;
/** How many of the player's frames make one level. */
const MERGE = 4;
/** Between two batches while levels wait. */
export const FLUSH_MS = 100;

export interface CueFrame { t: number; rms: number; centroid?: number }
export type SendCue = (bot: string, cue: { type: "speech"; frames: readonly CueFrame[]; cut?: true }) => Promise<unknown> | unknown;

export interface BridgeClock {
  /** Epoch milliseconds. */
  wall(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realClock: BridgeClock = { wall: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

interface PlayerFrame { t: number; rms: number; centroid: number }

/** Four hops as one level: loudness the RMS of their loudness, brightness weighted by it. */
export function mergeLevels(frames: readonly PlayerFrame[], toEpoch: (t: number) => number): CueFrame[] {
  const out: CueFrame[] = [];
  let last = -Infinity;
  for (let i = 0; i < frames.length; i += MERGE) {
    const group = frames.slice(i, i + MERGE);
    const energy = group.reduce((a, f) => a + f.rms * f.rms, 0);
    const weight = group.reduce((a, f) => a + f.rms, 0);
    const t = Math.round(toEpoch(group[0]!.t));
    if (!(t > last) || !Number.isFinite(t)) continue; // strictly rising stamps, as the cue wants
    last = t;
    out.push({ t, rms: Math.min(1, Math.sqrt(energy / group.length)), ...(weight > 0 ? { centroid: group.reduce((a, f) => a + f.centroid * f.rms, 0) / weight } : {}) });
  }
  return out;
}

export class SpeechCueBridge implements SpeechTap {
  readonly #buffers = new Map<string, CueFrame[]>();
  readonly #chains = new Map<string, Promise<unknown>>();
  #timer: unknown = undefined;
  #sentAt = -Infinity;

  constructor(private readonly send: SendCue, private readonly clock: BridgeClock = realClock) {}

  frames(bot: string, frames: readonly PlayerFrame[], audioNow: number): void {
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
    this.#post(bot, { type: "speech", frames: [], cut: true });
  }

  /** Stops for good (the shell unmounts): what is unsent is forgotten. */
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

  /** One batch for each bot that has levels waiting. */
  #flush(): void {
    this.#sentAt = this.clock.wall();
    for (const [bot, buffer] of this.#buffers) {
      const frames = buffer.splice(0, SPEECH_FRAMES_MAX);
      if (buffer.length === 0) this.#buffers.delete(bot);
      if (frames.length > 0) this.#post(bot, { type: "speech", frames });
    }
    if (this.#buffers.size > 0) this.#flushSoon();
  }

  /** In order per bot: a cut never overtakes the batch before it. */
  #post(bot: string, cue: Parameters<SendCue>[1]): void {
    const run = (): Promise<unknown> => Promise.resolve().then(() => this.send(bot, cue)).catch(() => undefined);
    this.#chains.set(bot, (this.#chains.get(bot) ?? Promise.resolve()).then(run));
  }
}
