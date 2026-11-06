// Loudness and brightness to the five mouth weights. Adapted from waifucave/daydreamers
// (src/core/speech/lipsync/visemes.ts).
//
// ONE budget, split, never five curves: a VRM's mouth shapes are single morphs that ADD, so weights summing
// past 1 would deform the face rather than clip. Loudness buys one budget in [0, 1] and the rest divides it,
// so the sum is at most 1 by construction. The dark/bright split is a smoothstep ramp, not a threshold: speech
// lives in the middle, and a mouth snapping between two shapes is the flap this avoids.

export interface VisemeWeights {
  readonly aa: number;
  readonly ih: number;
  readonly ou: number;
  readonly ee: number;
  readonly oh: number;
}

export const VISEMES = ["aa", "ih", "ou", "ee", "oh"] as const;

/** Below this RMS the mouth is shut: room tone and breath. */
export const SILENCE_RMS = 0.01;
/** The RMS at which the jaw is fully open. */
export const FULL_RMS = 0.25;
/** The centroid ramp: vowel formants below, fricatives above. */
export const DARK_HZ = 500;
export const BRIGHT_HZ = 2500;
/** `ou` is lip rounding riding on top, never the shape that carries the frame. */
const OU_SHARE = 0.1;
/** In the dark pair `aa` is the jaw, `oh` the rounding that goes with it. */
const AA_OF_DARK = 0.65;
/** In the bright pair `ee` is the wider. */
const EE_OF_BRIGHT = 0.55;

export const SHUT: VisemeWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

/** Written so a NaN folds to 0: every comparison with NaN is false. */
export function clamp01(x: number): number {
  return x > 0 ? (x > 1 ? 1 : x) : 0;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** The five weights for one frame: each in [0, 1], summing to at most 1. A non-finite loudness shuts the mouth. */
export function visemeWeights(rms: number, centroidHz: number): VisemeWeights {
  if (!Number.isFinite(rms) || rms <= SILENCE_RMS) return SHUT;
  const budget = clamp01((rms - SILENCE_RMS) / (FULL_RMS - SILENCE_RMS));
  const bright = smoothstep(DARK_HZ, BRIGHT_HZ, centroidHz);
  const dark = 1 - bright;
  const vowels = budget * (1 - OU_SHARE);
  return {
    aa: vowels * dark * AA_OF_DARK,
    oh: vowels * dark * (1 - AA_OF_DARK),
    ee: vowels * bright * EE_OF_BRIGHT,
    ih: vowels * bright * (1 - EE_OF_BRIGHT),
    ou: budget * OU_SHARE,
  };
}

/**
 * The mouth eased toward each frame's weights: quick to open (attack), slower to close (release), so a word's
 * consonants don't make it flap. Exponential, by the real time since the last frame.
 */
export class MouthSmoother {
  private current: VisemeWeights = SHUT;

  constructor(
    readonly attackSeconds = 0.035,
    readonly releaseSeconds = 0.09,
  ) {}

  get weights(): VisemeWeights {
    return this.current;
  }

  step(target: VisemeWeights, dt: number): VisemeWeights {
    const t = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const next = {} as Record<(typeof VISEMES)[number], number>;
    for (const name of VISEMES) {
      const from = this.current[name];
      const to = target[name];
      const tau = to > from ? this.attackSeconds : this.releaseSeconds;
      const k = tau <= 0 ? 1 : 1 - Math.exp(-t / tau);
      next[name] = clamp01(from + (to - from) * k);
    }
    // Easing each weight on its own keeps the sum within what the two frames allowed; hold it to 1 regardless.
    const sum = VISEMES.reduce((s, n) => s + next[n], 0);
    if (sum > 1) for (const n of VISEMES) next[n] /= sum;
    this.current = next;
    return next;
  }

  reset(): void {
    this.current = SHUT;
  }
}
