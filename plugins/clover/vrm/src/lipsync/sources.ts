// Where lip-sync's input comes from: the speech the app plays (spec §6.2: the avatar lip-syncs to it).
//
// - THE FEED (`SpeechFeed`, what the `avatar` spot is given): the app analyses the speech where the audio is,
//   and pushes frames of two numbers — loudness and brightness — each stamped with when it will be HEARD (the
//   audio clock, the output's latency already added). The avatar keeps them in a `SpeechRing` and reads the
//   frame that sounds NOW, so the mouth moves with the sound, not after it. No samples cross into the avatar,
//   so it asks for no `audio` capability: it never hears anything, it is told what plays. `speechFrames` is
//   the app side's reference (lanes B and E), and `PushedSpeech` a feed pushed by hand.
// - In-process samples, where they already are: `SpeechRing` + `ringSource` (chunks written with the time
//   their first sample plays), `analyserSource` (an AnalyserNode, a few milliseconds late) and `bufferSource`
//   (a whole clip and a clock: tests, the gallery).

import { FFT_SIZE, rmsOf, spectralCentroidOf } from "./features";
import { MouthSmoother, SHUT, visemeWeights, type VisemeWeights } from "./visemes";

/** One frame of the speech the app plays: the shape the `avatar` spot's speech feed carries (asked of lanes B and
 *  E). Frames come in time order, one per analysis hop, each a few milliseconds long. */
export interface SpeechFrame {
  /** When it is heard: seconds on the audio clock (`AudioContext.currentTime`), the output's latency added. */
  readonly at: number;
  /** How long it lasts, in seconds: the hop between frames (256 samples at 48 kHz is 5.3 ms). */
  readonly duration: number;
  /** Loudness: the RMS of the frame's samples, on −1…1. */
  readonly rms: number;
  /** Brightness: the frame's spectral centroid, in hertz; 0 for a silent frame. */
  readonly centroid: number;
}

/** The `avatar` spot's speech: frames pushed as the app analyses what it plays, and the clock they are stamped in. */
export interface SpeechFeed {
  /** The audio clock now, in seconds: what each frame's `at` is measured on. */
  now(): number;
  /** Takes every batch of frames pushed from here on; returns how to stop. */
  subscribe(onFrames: (frames: readonly SpeechFrame[]) => void): () => void;
}

/**
 * The app side of the feed, for reference: the speech it plays, cut into hops and measured, each stamped with when
 * it is heard. `startTime` is when the first sample plays on the audio clock, the output's latency added
 * (`ctx.currentTime + ctx.outputLatency` as the chunk is scheduled).
 */
export function speechFrames(samples: Float32Array, sampleRate: number, startTime: number, hop = FFT_SIZE): SpeechFrame[] {
  const frames: SpeechFrame[] = [];
  for (let i = 0; i < samples.length; i += hop) {
    const window = samples.subarray(i, Math.min(samples.length, i + FFT_SIZE));
    frames.push({ at: startTime + i / sampleRate, duration: hop / sampleRate, rms: rmsOf(window), centroid: spectralCentroidOf(window, sampleRate) });
  }
  return frames;
}

/** A feed pushed by hand: the tests' and the gallery's, and a model of what lanes B and E push through. */
export class PushedSpeech implements SpeechFeed {
  private readonly listeners = new Set<(frames: readonly SpeechFrame[]) => void>();

  constructor(private readonly clock: () => number) {}

  now(): number {
    return this.clock();
  }

  push(frames: readonly SpeechFrame[]): void {
    for (const listener of this.listeners) listener(frames);
  }

  subscribe(onFrames: (frames: readonly SpeechFrame[]) => void): () => void {
    this.listeners.add(onFrames);
    return () => {
      this.listeners.delete(onFrames);
    };
  }
}

/** Loudness and brightness: what lip-sync reads, from a frame of samples or from a pushed frame. */
export interface SpeechFeatures {
  readonly rms: number;
  readonly centroid: number;
}

/** A source of features rather than samples: the speech heard now, or null for silence. */
export interface SpeechFeatureSource {
  features(): SpeechFeatures | null;
}

/** How many pushed frames a ring keeps: about five seconds of 5.3 ms hops. */
const RING_FRAMES = 1024;

export interface LipSyncSource {
  readonly sampleRate: number;
  /** Fills `into` with the samples sounding now; returns how many it wrote (0: silence, nothing playing). */
  read(into: Float32Array): number;
}

/**
 * Recent speech, by the audio clock: pushed frames (the feed), or written samples (in-process). Each slot remembers
 * which moment it holds, so a gap reads as silence and a late frame is never heard early.
 */
export class SpeechRing {
  private readonly samples: Float32Array;
  private readonly stamps: Float64Array;
  private readonly frames: (SpeechFrame | null)[] = new Array(RING_FRAMES).fill(null);
  private newest = -1;

  /** `seconds` of samples are kept for written speech; a ring that only takes pushed frames can keep none. */
  constructor(
    readonly sampleRate: number,
    seconds = 4,
  ) {
    const size = Math.max(FFT_SIZE * 2, Math.ceil(sampleRate * seconds));
    this.samples = new Float32Array(size);
    this.stamps = new Float64Array(size).fill(-1);
  }

  /** Frames from the feed, in time order. */
  push(frames: readonly SpeechFrame[]): void {
    for (const frame of frames) {
      if (!(Number.isFinite(frame.at) && Number.isFinite(frame.duration) && frame.duration > 0 && Number.isFinite(frame.rms) && Number.isFinite(frame.centroid))) continue;
      this.newest = (this.newest + 1) % RING_FRAMES;
      this.frames[this.newest] = frame;
    }
  }

  /** The pushed frame sounding at `time` (seconds, audio clock), or null: nothing pushed covers it. */
  frameAt(time: number): SpeechFrame | null {
    if (this.newest < 0) return null;
    for (let k = 0; k < RING_FRAMES; k++) {
      const frame = this.frames[(this.newest - k + RING_FRAMES) % RING_FRAMES];
      if (!frame) return null;
      if (frame.at <= time && time < frame.at + frame.duration) return frame;
      // Older frames only get earlier; one that ended a second ago ends the search.
      if (frame.at + frame.duration < time - 1) return null;
    }
    return null;
  }

  /** A chunk whose first sample plays at `startTime` seconds on the audio clock. */
  write(chunk: Float32Array, startTime: number): void {
    const first = Math.round(startTime * this.sampleRate);
    const size = this.samples.length;
    for (let i = 0; i < chunk.length; i++) {
      const at = first + i;
      const slot = ((at % size) + size) % size;
      this.samples[slot] = chunk[i]!;
      this.stamps[slot] = at;
    }
  }

  /** The samples from `time` on (seconds, audio clock); anything not written reads as 0. Returns how many were speech. */
  read(into: Float32Array, time: number): number {
    const first = Math.round(time * this.sampleRate);
    const size = this.samples.length;
    let heard = 0;
    for (let i = 0; i < into.length; i++) {
      const at = first + i;
      const slot = ((at % size) + size) % size;
      if (this.stamps[slot] === at) {
        into[i] = this.samples[slot]!;
        heard++;
      } else into[i] = 0;
    }
    return heard;
  }
}

/** Reads the frames pushed into `ring` at `now()`: the audio clock (the frames already carry the output's latency). */
export function frameSource(ring: SpeechRing, now: () => number): SpeechFeatureSource {
  return {
    features: () => {
      const frame = ring.frameAt(now());
      return frame ? { rms: frame.rms, centroid: frame.centroid } : null;
    },
  };
}

/** Reads `ring` at `now()`: the audio clock plus the output's latency, in seconds. */
export function ringSource(ring: SpeechRing, now: () => number): LipSyncSource {
  return {
    sampleRate: ring.sampleRate,
    read: (into) => (ring.read(into, now()) > 0 ? into.length : 0),
  };
}

/** The bits of an AnalyserNode lip-sync uses. */
export interface AnalyserLike {
  readonly fftSize: number;
  readonly context: { readonly sampleRate: number };
  getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void;
}

export function analyserSource(analyser: AnalyserLike): LipSyncSource {
  const scratch = new Float32Array(Math.max(analyser.fftSize, FFT_SIZE));
  return {
    sampleRate: analyser.context.sampleRate,
    read(into) {
      analyser.getFloatTimeDomainData(scratch);
      // The newest samples are at the end.
      const n = Math.min(into.length, analyser.fftSize);
      into.set(scratch.subarray(analyser.fftSize - n, analyser.fftSize));
      return n;
    },
  };
}

/** A whole clip read at `now()` seconds into it; past either end, silence. */
export function bufferSource(clip: Float32Array, sampleRate: number, now: () => number): LipSyncSource {
  return {
    sampleRate,
    read(into) {
      const first = Math.round(now() * sampleRate);
      let heard = 0;
      for (let i = 0; i < into.length; i++) {
        const at = first + i;
        const inside = at >= 0 && at < clip.length;
        into[i] = inside ? clip[at]! : 0;
        if (inside) heard++;
      }
      return heard > 0 ? into.length : 0;
    },
  };
}

/** A source's speech, frame by frame, as the five mouth weights, eased. */
export class LipSync {
  private readonly frame = new Float32Array(FFT_SIZE);
  private readonly smoother: MouthSmoother;

  constructor(
    private source: LipSyncSource | SpeechFeatureSource | null,
    smoother: MouthSmoother = new MouthSmoother(),
  ) {
    this.smoother = smoother;
  }

  use(source: LipSyncSource | SpeechFeatureSource | null): void {
    this.source = source;
  }

  /** The weights now, `dt` seconds after the last call. */
  sample(dt: number): VisemeWeights {
    const heard = this.heard();
    return this.smoother.step(heard ? visemeWeights(heard.rms, heard.centroid) : SHUT, dt);
  }

  private heard(): SpeechFeatures | null {
    const source = this.source;
    if (!source) return null;
    if ("features" in source) return source.features();
    const n = source.read(this.frame);
    return n === 0 ? null : { rms: rmsOf(this.frame, n), centroid: spectralCentroidOf(this.frame, source.sampleRate, n) };
  }

  /** The weights for this one frame of samples, unsmoothed: what a still shows. */
  static analyse(frame: Float32Array, sampleRate: number): VisemeWeights {
    return visemeWeights(rmsOf(frame), spectralCentroidOf(frame, sampleRate));
  }
}
