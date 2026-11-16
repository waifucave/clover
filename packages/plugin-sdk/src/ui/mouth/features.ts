// The two numbers lip-sync reads from a frame of audio: how loud it is, and where its energy sits in the
// spectrum. Adapted from waifucave/daydreamers (src/core/speech/lipsync/features.ts), which the spec names as
// the renderer's starting point (§12).
//
// Lip-sync is ENERGY-driven, not phoneme-driven: loudness opens the jaw, and the spectral centroid decides
// whether the shape is dark (aa, oh) or bright (ih, ee). For a stylised VRM face, whose mouth shapes are single
// continuous morphs, that is close to the ceiling; phoneme timing would need a second model in the path.
// Pure over a Float32Array: no AudioContext here (the sources in `sources.ts` bring the samples).

/** The window: 256 samples, 128 usable bins. Cheap, not exact. */
export const FFT_SIZE = 256;
const HALF = FFT_SIZE / 2;

/** Root mean square: the frame's loudness, in the samples' own units. */
export function rmsOf(frame: Float32Array, length: number = frame.length): number {
  const n = Math.min(length, frame.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / n);
}

/** Hann window, built once: without it a tone between bins leaks everywhere and drags every centroid to the middle. */
const HANN = (() => {
  const w = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  return w;
})();

const REVERSED = (() => {
  const bits = Math.log2(FFT_SIZE);
  const out = new Uint16Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
    out[i] = r;
  }
  return out;
})();

// Scratch, reused every frame (not re-entrant: one frame loop, one thread).
const RE = new Float32Array(FFT_SIZE);
const IM = new Float32Array(FFT_SIZE);

function fft(): void {
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size / 2;
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(step * k);
        const wi = Math.sin(step * k);
        const i = start + k;
        const j = i + half;
        const tr = RE[j]! * wr - IM[j]! * wi;
        const ti = RE[j]! * wi + IM[j]! * wr;
        RE[j] = RE[i]! - tr;
        IM[j] = IM[i]! - ti;
        RE[i] = RE[i]! + tr;
        IM[i] = IM[i]! + ti;
      }
    }
  }
}

/**
 * The spectral centroid in Hz: the centre of mass of the frame's magnitude spectrum, over its first 256
 * samples (zero-padded when shorter). The frame's mean is taken out first and bin 0 is left out: an offset
 * under a bright tone would otherwise drag the centroid dark and put the mouth on the wrong vowel. A frame
 * with no energy reads 0, never NaN (a NaN weight would leave a morph target broken for the session).
 */
export function spectralCentroidOf(frame: Float32Array, sampleRate: number, length: number = frame.length): number {
  const n = Math.min(length, frame.length, FFT_SIZE);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i]!;
  if (n > 0) mean /= n;
  for (let i = 0; i < FFT_SIZE; i++) {
    RE[REVERSED[i]!] = i < n ? (frame[i]! - mean) * HANN[i]! : 0;
    IM[i] = 0;
  }
  fft();
  const binHz = sampleRate / FFT_SIZE;
  let weighted = 0;
  let total = 0;
  for (let k = 1; k <= HALF; k++) {
    const magnitude = Math.hypot(RE[k]!, IM[k]!);
    weighted += magnitude * k * binHz;
    total += magnitude;
  }
  return total > 0 ? weighted / total : 0;
}
