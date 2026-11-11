// The player for a bot's voice, in the main window's shell document. The core streams a bot's reply as `voice.play` pieces
// (main forwards each here as a `voice` layer message): one utterance is pieces `seq` 0, 1, 2…, base64 pcm16-24k (16-bit
// little-endian signed mono, no header), the last `final` with no audio. This plays them back to back on one AudioContext
// and tells the bot's stage what it plays: a `SpeechFeed` of `{ t, rms, centroid }` frames (the audio clock, the output's
// latency added) for the avatar's mouth, and `speaking`.
//
// * The frames are measured from the decoded samples as each piece is scheduled (`speechFrames`, the feed's reference
//   side), so they run a little ahead of the sound and no analyser node or polling timer is needed. While nothing plays
//   there is no node, no timer and no listener work: an idle player costs nothing.
// * One utterance per bot at a time. A piece of a new utterance of the same bot replaces the playing one at once; a late
//   piece of one already replaced is dropped. A piece out of order waits for the ones before it.
// * A stage that isn't shown still has its bot's sound. The frames are kept ahead of the clock, and a feed's subscriber hears
//   those still ahead when it subscribes, so a stage that mounts mid-sentence is in time.
// * Test-build counters: pieces received and frames produced (`counters()`), read by the acceptance run.
import type { VoicePiece } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { speechFrames, type SpeechFeed, type SpeechFrame } from "../../../../../plugins/clover/plugins/vrm/src/lipsync/index";

export type { VoicePiece };

/** What the player needs of the browser's audio: the parts of `AudioContext` it uses (a fake in the tests). */
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

export interface VoiceDeps {
  /** The one AudioContext, made when the first sound is due. */
  audio(): AudioContextLike;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export const VOICE_SAMPLE_RATE = 24_000;
/** The most a bot may be silent between pieces of one utterance before it counts as finished without its `final`. */
const STALL_MS = 4000;
/** Frames are measured from the samples in hops this small. */
const HOP = 256;
/** How far behind `currentTime` the first piece starts (a little room so the first samples aren't clipped). */
const LEAD_SECONDS = 0.03;
/** Frames this far past are no longer replayed to a new subscriber. */
const FRAME_KEEP_SECONDS = 0.1;
/** Replaced utterance ids remembered, to drop their stragglers. */
const RETIRED_KEPT = 8;

export interface SpeechState {
  speaking: boolean;
}

class Utterance {
  readonly sources = new Set<AudioSourceLike>();
  /** The pieces that came out of order, by seq. */
  readonly waiting = new Map<number, VoicePiece>();
  next = 0;
  /** Where on the audio clock the next piece starts (not before now). */
  cursor = 0;
  finalSeen = false;
  stall: unknown;
  constructor(readonly id: string) {}
}

/** One bot's feed: frames as they're made, and the clock. A subscriber hears the frames not yet past first. */
class BotFeed implements SpeechFeed {
  private readonly listeners = new Set<(frames: readonly SpeechFrame[]) => void>();
  private frames: SpeechFrame[] = [];
  constructor(private readonly clock: () => number) {}
  now(): number {
    return this.clock();
  }
  subscribe(listener: (frames: readonly SpeechFrame[]) => void): () => void {
    this.listeners.add(listener);
    const ahead = this.frames.filter((f) => f.t + FRAME_KEEP_SECONDS >= this.clock());
    if (ahead.length > 0) listener(ahead);
    return () => {
      this.listeners.delete(listener);
    };
  }
  push(frames: readonly SpeechFrame[]): void {
    const now = this.clock();
    this.frames = this.frames.filter((f) => f.t + FRAME_KEEP_SECONDS >= now).concat(frames);
    for (const l of [...this.listeners]) l(frames);
  }
  clear(): void {
    this.frames = [];
  }
}

function pcm16(base64: string): Float32Array {
  const bin = atob(base64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
    out[i] = v / 32768;
  }
  return out;
}

export class VoiceStage {
  private ctx: AudioContextLike | undefined;
  private readonly now: UtteranceMap = new Map();
  private readonly retired: string[] = [];
  private readonly feeds = new Map<string, BotFeed>();
  private readonly states = new Map<string, boolean>();
  private readonly watchers = new Map<string, Set<(s: SpeechState) => void>>();
  private muted = false;
  private changed: (() => void) | undefined;
  private readonly muteWatchers = new Set<(muted: boolean) => void>();
  private pieces = 0;
  private framesMade = 0;
  private readonly timeout: (fn: () => void, ms: number) => unknown;
  private readonly untimeout: (h: unknown) => void;

  constructor(private readonly deps: VoiceDeps) {
    this.timeout = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.untimeout = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** The player's counts, for the acceptance run (test builds only show them). */
  counters(): { pieces: number; frames: number; speaking: string[] } {
    return { pieces: this.pieces, frames: this.framesMade, speaking: [...this.states].filter(([, s]) => s).map(([b]) => b) };
  }

  /** Called after each piece and each speaking change (the test build's counters); never otherwise. */
  onChange(fn: () => void): void {
    this.changed = fn;
  }

  /** The app's mute (`voice.speakReplies` false): what plays stops, and pieces that still arrive are dropped. */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    for (const l of [...this.muteWatchers]) l(muted);
    if (muted) for (const bot of [...this.now.keys()]) this.stop(bot);
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Hears the mute change; returns how to stop. */
  watchMuted(listener: (muted: boolean) => void): () => void {
    this.muteWatchers.add(listener);
    return () => {
      this.muteWatchers.delete(listener);
    };
  }

  feedOf(bot: string): SpeechFeed {
    let f = this.feeds.get(bot);
    if (f === undefined) {
      f = new BotFeed(() => this.clockNow());
      this.feeds.set(bot, f);
    }
    return f;
  }

  speaking(bot: string): boolean {
    return this.states.get(bot) === true;
  }

  /** Hears a bot's `speaking` change; returns how to stop. */
  watch(bot: string, listener: (s: SpeechState) => void): () => void {
    let set = this.watchers.get(bot);
    if (set === undefined) this.watchers.set(bot, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.watchers.delete(bot);
    };
  }

  /** One piece, from the core. */
  piece(p: VoicePiece): void {
    if (this.muted || p.format !== "pcm16-24k") return;
    if (typeof p.bot !== "string" || typeof p.utterance !== "string" || !Number.isInteger(p.seq) || p.seq < 0) return;
    this.pieces++;
    this.changed?.();
    if (this.retired.includes(`${p.bot}\u0000${p.utterance}`)) return;
    let u = this.now.get(p.bot);
    if (u !== undefined && u.id !== p.utterance) {
      this.retire(p.bot, u);
      u = undefined;
    }
    if (u === undefined) {
      u = new Utterance(p.utterance);
      this.now.set(p.bot, u);
    }
    u.waiting.set(p.seq, p);
    // Play what is in order now; a gap waits for the missing piece.
    for (let q = u.waiting.get(u.next); q !== undefined; q = u.waiting.get(u.next)) {
      u.waiting.delete(u.next);
      u.next++;
      this.schedule(p.bot, u, q);
    }
    this.settle(p.bot, u);
  }

  /** The user stopped a bot's speech, or the core ended it: what plays stops at once. */
  stop(bot: string): void {
    const u = this.now.get(bot);
    if (u === undefined) return;
    this.retire(bot, u);
    this.setSpeaking(bot, false);
  }

  private clockNow(): number {
    return this.ctx?.currentTime ?? 0;
  }

  private context(): AudioContextLike {
    if (this.ctx === undefined) this.ctx = this.deps.audio();
    return this.ctx;
  }

  private retire(bot: string, u: Utterance): void {
    this.now.delete(bot);
    this.retired.push(`${bot}\u0000${u.id}`);
    if (this.retired.length > RETIRED_KEPT) this.retired.shift();
    if (u.stall !== undefined) this.untimeout(u.stall);
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
    this.feeds.get(bot)?.clear();
  }

  private schedule(bot: string, u: Utterance, p: VoicePiece): void {
    if (p.final) u.finalSeen = true;
    if (p.audio === "") return;
    let samples: Float32Array;
    try {
      samples = pcm16(p.audio);
    } catch {
      return;
    }
    if (samples.length === 0) return;
    const ctx = this.context();
    void ctx.resume?.();
    const buffer = ctx.createBuffer(1, samples.length, VOICE_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    // Back to back: each piece starts where the one before ends, and never in the past (an underrun starts again from now).
    const start = Math.max(u.cursor, ctx.currentTime + (u.sources.size === 0 && u.cursor <= ctx.currentTime ? LEAD_SECONDS : 0));
    u.cursor = start + buffer.duration;
    src.onended = () => {
      u.sources.delete(src);
      src.disconnect?.();
      this.settle(bot, u);
    };
    u.sources.add(src);
    src.start(start);
    // The frames of what is now scheduled, kept ahead of the clock for any stage that is or becomes shown (a few hundred a
    // second: cheap beside the audio itself).
    const latency = ctx.outputLatency ?? ctx.baseLatency ?? 0;
    const frames = speechFrames(samples, VOICE_SAMPLE_RATE, start + latency, HOP);
    this.framesMade += frames.length;
    this.changed?.();
    (this.feeds.get(bot) ?? this.feedOf(bot) as BotFeed).push(frames);
    this.setSpeaking(bot, true);
  }

  /** After a piece or when a source ends: the utterance is over once its last piece has played; waiting for a missing piece or a final that never came, it ends on a stall. */
  private settle(bot: string, u: Utterance): void {
    if (this.now.get(bot) !== u) return;
    if (u.stall !== undefined) {
      this.untimeout(u.stall);
      u.stall = undefined;
    }
    if (u.sources.size > 0) return;
    if (u.finalSeen && u.waiting.size === 0) {
      this.now.delete(bot);
      this.feeds.get(bot)?.clear();
      this.setSpeaking(bot, false);
      return;
    }
    if (this.states.get(bot) === true || u.waiting.size > 0) {
      u.stall = this.timeout(() => {
        u.stall = undefined;
        if (this.now.get(bot) === u) this.stop(bot);
      }, STALL_MS);
    }
  }

  private setSpeaking(bot: string, on: boolean): void {
    if ((this.states.get(bot) ?? false) === on) return;
    if (on) this.states.set(bot, true);
    else this.states.delete(bot);
    this.changed?.();
    for (const l of [...(this.watchers.get(bot) ?? [])]) l({ speaking: on });
  }
}

type UtteranceMap = Map<string, Utterance>;
