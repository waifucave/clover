// The speech the app plays, for an avatar renderer in a frame of its own (a third-party `avatar` entry): the feed's
// frames cross from the stage's document to the renderer's frame as numbers only, in batches, through main, which
// checks that the sender is the frame's parent document (as it does for a frame's props).
//
// * Parent side (`SpeechForwarder`, run by the stage's `LayerFrame` for an `avatar` frame): it hears the feed, keeps
//   its frames, and sends them every SPEECH_FLUSH_MS while there are any (the mouth follows within that, well inside
//   the frames' own lead), and `speaking` when it changes. With nothing buffered no timer runs: a quiet bot costs no
//   wakeups. While the frame can't be seen (the window hidden, the frame asleep or gone) it sends nothing and keeps
//   nothing: stale speech is never replayed.
// * Child side (`ReceivedSpeech`): the `SpeechFeed` a framed renderer reads through `useAvatarSpeech()`. Each batch
//   carries the parent's audio clock against the wall clock, so `now()` runs on in the child between batches.
// * What crosses: `{ speaking, clock: { audio, wall }, frames: [{ t, rms, centroid }] }`, each a finite number (or the
//   boolean), at most SPEECH_BATCH_MAX frames. No audio, no text, no function.
import type { Unsubscribe } from "../api/plugin-api";
import type { SpeechFeed, SpeechFrame } from "../api/ui-api";

/** How often buffered frames go to the frame: well under the ~50 ms a mouth may lag and still look live. */
export const SPEECH_FLUSH_MS = 40;
/** Frames in one message at most (a flush carries ~4 at the feed's rate; a burst ahead of playback, more). */
export const SPEECH_BATCH_MAX = 64;
/** Frames the parent keeps while it waits to send (beyond, the oldest go). */
const BUFFER_MAX = 256;

/** One batch, as it crosses. */
export interface SpeechMessage {
  /** Whether the bot is speaking now (the spot's `speaking`). */
  speaking: boolean;
  /** The parent's audio clock (`feed.now()`, seconds) at `wall`, the wall clock in ms (`performance.timeOrigin + now`). */
  clock: { audio: number; wall: number };
  frames: SpeechFrame[];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A batch as it may cross: numbers only, in range, at most SPEECH_BATCH_MAX frames; undefined if it isn't one. Main
 *  and the receiving frame both read a batch through this. */
export function cleanSpeechMessage(raw: unknown): SpeechMessage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const clock = m.clock as Record<string, unknown> | null | undefined;
  if (typeof m.speaking !== "boolean" || clock === null || typeof clock !== "object" || !finite(clock.audio) || !finite(clock.wall)) return undefined;
  if (!Array.isArray(m.frames) || m.frames.length > SPEECH_BATCH_MAX) return undefined;
  const frames: SpeechFrame[] = [];
  for (const f of m.frames as unknown[]) {
    if (f === null || typeof f !== "object") return undefined;
    const { t, rms, centroid } = f as Record<string, unknown>;
    if (!finite(t) || !finite(rms) || !finite(centroid)) return undefined;
    frames.push({ t, rms: Math.min(1, Math.max(0, rms)), centroid: Math.min(24_000, Math.max(0, centroid)) });
  }
  return { speaking: m.speaking, clock: { audio: clock.audio, wall: clock.wall }, frames };
}

/** The wall clock in ms, the same across a window's documents. */
export const wallNow = (): number => performance.timeOrigin + performance.now();

export interface ForwarderTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  wall(): number;
}
const realTimers: ForwarderTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  wall: wallNow,
};

/** The parent side: one `avatar` frame's feed, sent on in batches while the frame can be seen. */
export class SpeechForwarder {
  private buffer: SpeechFrame[] = [];
  private timer: unknown = undefined;
  private speaking = false;
  private sentSpeaking = false;
  private open = false;
  private off: Unsubscribe | undefined;

  constructor(
    private readonly feed: SpeechFeed,
    private readonly send: (message: SpeechMessage) => void,
    private readonly timers: ForwarderTimers = realTimers,
  ) {}

  /** Whether the frame can be seen now (its window shown, the frame awake and not gone). Closed: nothing is heard,
   *  kept or sent; opened again, it starts from what comes next, and says whether the bot speaks. */
  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    if (!open) {
      this.off?.();
      this.off = undefined;
      this.buffer = [];
      this.stop();
      return;
    }
    this.off = this.feed.subscribe((frames) => this.hear(frames));
    // The frame may have missed a change while it couldn't be seen: it hears where things stand.
    if (this.speaking !== this.sentSpeaking || this.speaking) this.flush(true);
  }

  /** The spot's `speaking`: sent at once when it changes (with whatever frames are waiting). */
  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    if (this.open && speaking !== this.sentSpeaking) this.flush();
  }

  /** Stops for good (the frame unmounts). */
  close(): void {
    this.setOpen(false);
  }

  /** Whether a timer is running (tests: a quiet bot has none). */
  get ticking(): boolean {
    return this.timer !== undefined;
  }

  private hear(frames: readonly SpeechFrame[]): void {
    if (!this.open || frames.length === 0) return;
    this.buffer.push(...frames);
    if (this.buffer.length > BUFFER_MAX) this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
    if (this.timer === undefined) this.timer = this.timers.setInterval(() => this.flush(), SPEECH_FLUSH_MS);
  }

  private flush(force = false): void {
    if (!this.open) return this.stop();
    if (!force && this.buffer.length === 0 && this.speaking === this.sentSpeaking) return this.stop();
    const frames = this.buffer.splice(0, SPEECH_BATCH_MAX);
    this.sentSpeaking = this.speaking;
    this.send({ speaking: this.speaking, clock: { audio: this.feed.now(), wall: this.timers.wall() }, frames });
    // Frames still waiting (a burst), or none: the timer runs only while there is something to send.
    if (this.buffer.length === 0) this.stop();
    else if (this.timer === undefined) this.timer = this.timers.setInterval(() => this.flush(), SPEECH_FLUSH_MS);
  }

  private stop(): void {
    if (this.timer === undefined) return;
    this.timers.clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** The child side: the `SpeechFeed` of a framed renderer, fed by the batches its parent sends. */
export class ReceivedSpeech implements SpeechFeed {
  private readonly listeners = new Set<(frames: readonly SpeechFrame[]) => void>();
  private readonly speakingListeners = new Set<(speaking: boolean) => void>();
  private clock: { audio: number; wall: number } | undefined;
  speaking = false;

  constructor(private readonly wall: () => number = wallNow) {}

  /** A batch from the parent (already checked by `cleanSpeechMessage`). */
  accept(message: SpeechMessage): void {
    this.clock = message.clock;
    if (message.frames.length > 0) for (const l of this.listeners) l(message.frames);
    if (message.speaking !== this.speaking) {
      this.speaking = message.speaking;
      for (const l of this.speakingListeners) l(message.speaking);
    }
  }

  subscribe(listener: (frames: readonly SpeechFrame[]) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The parent's audio clock, run on from its last batch by the wall clock (0 before any batch). */
  now(): number {
    if (this.clock === undefined) return 0;
    return this.clock.audio + (this.wall() - this.clock.wall) / 1000;
  }

  onSpeaking(listener: (speaking: boolean) => void): Unsubscribe {
    this.speakingListeners.add(listener);
    return () => this.speakingListeners.delete(listener);
  }
}
