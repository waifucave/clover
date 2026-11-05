// Where lip-sync's samples come from: the speech the app plays (spec §6.2: the avatar lip-syncs to it).
//
// - `SpeechRing` + `ringSource`: the speech player writes each chunk with the time its first sample will
//   play; lip-sync reads the window that plays NOW (the audio clock plus the output's latency), so the mouth
//   moves with the sound, not after it. The way daydreamers does it, and the one to prefer.
// - `analyserSource`: an AnalyserNode tapped on the speech's output. It reads what has just gone out, a few
//   milliseconds late; good enough where the app can only hand over a node or a MediaStream.
// - `bufferSource`: a whole clip and a clock (tests, the gallery, a clip the app plays itself).

import { FFT_SIZE, rmsOf, spectralCentroidOf } from "./features";
import { MouthSmoother, SHUT, visemeWeights, type VisemeWeights } from "./visemes";

export interface LipSyncSource {
  readonly sampleRate: number;
  /** Fills `into` with the samples sounding now; returns how many it wrote (0: silence, nothing playing). */
  read(into: Float32Array): number;
}

/** Recent speech, by the audio clock: each slot remembers which sample it holds, so a gap reads as silence. */
export class SpeechRing {
  private readonly samples: Float32Array;
  private readonly stamps: Float64Array;

  constructor(
    readonly sampleRate: number,
    seconds = 4,
  ) {
    const size = Math.max(FFT_SIZE * 2, Math.ceil(sampleRate * seconds));
    this.samples = new Float32Array(size);
    this.stamps = new Float64Array(size).fill(-1);
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
    private source: LipSyncSource | null,
    smoother: MouthSmoother = new MouthSmoother(),
  ) {
    this.smoother = smoother;
  }

  use(source: LipSyncSource | null): void {
    this.source = source;
  }

  /** The weights now, `dt` seconds after the last call. */
  sample(dt: number): VisemeWeights {
    if (!this.source) return this.smoother.step(SHUT, dt);
    const n = this.source.read(this.frame);
    if (n === 0) return this.smoother.step(SHUT, dt);
    const target = visemeWeights(rmsOf(this.frame, n), spectralCentroidOf(this.frame, this.source.sampleRate, n));
    return this.smoother.step(target, dt);
  }

  /** The weights for this one frame of samples, unsmoothed: what a still shows. */
  static analyse(frame: Float32Array, sampleRate: number): VisemeWeights {
    return visemeWeights(rmsOf(frame), spectralCentroidOf(frame, sampleRate));
  }
}
