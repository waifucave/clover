// Speech-like sound made in code, for the tests and the gallery: a voiced vowel (harmonics of a pitch shaped
// by the vowel's formants) or a hiss, under a syllable's swell. Nothing recorded, nothing licensed.

export type Vowel = "a" | "i" | "u" | "e" | "o";

/** Formant centres in Hz (an adult speaker's, roughly). */
export const FORMANTS: Readonly<Record<Vowel, readonly [number, number, number]>> = {
  a: [800, 1200, 2500],
  i: [300, 2300, 3000],
  u: [320, 800, 2250],
  e: [450, 2000, 2600],
  o: [500, 850, 2400],
};

const BANDWIDTH = [90, 110, 160] as const;

/** One vowel held for `seconds` at a pitch, at `level` RMS, with soft ends. */
export function vowel(v: Vowel, seconds: number, sampleRate = 48000, pitch = 210, level = 0.18): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const harmonics: [number, number][] = [];
  for (let k = 1; k * pitch < Math.min(5000, sampleRate / 2); k++) {
    const f = k * pitch;
    let gain = 0;
    FORMANTS[v].forEach((centre, i) => {
      const x = (f - centre) / BANDWIDTH[i]!;
      gain += (i === 0 ? 1 : i === 1 ? 0.9 : 0.6) / (1 + x * x);
    });
    harmonics.push([f, gain / k ** 0.3]);
  }
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let s = 0;
    for (const [f, g] of harmonics) s += g * Math.sin(2 * Math.PI * f * t);
    out[i] = s;
  }
  // Scaled to `level` RMS, then the swell in and out.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += out[i]! * out[i]!;
  const scale = n > 0 && sum > 0 ? level / Math.sqrt(sum / n) : 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const edge = Math.max(0, Math.min(1, t / 0.03, (seconds - t) / 0.05));
    out[i] = out[i]! * scale * edge;
  }
  return out;
}

/** A hiss (an "s"): bright noise from a seeded generator. */
export function hiss(seconds: number, sampleRate = 48000, level = 0.06, seed = 7): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  let a = seed >>> 0;
  let previous = 0;
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const white = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    // A first difference tilts it bright, as a fricative is.
    out[i] = (white - previous) * level;
    previous = white;
  }
  return out;
}

/** Clips one after another. */
export function concat(...clips: Float32Array[]): Float32Array {
  const out = new Float32Array(clips.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of clips) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** "Hello, I'm Alpha" in vowels and a hiss: enough for a mouth to move like speech. */
export function phrase(sampleRate = 48000): Float32Array {
  const pause = (s: number) => new Float32Array(Math.round(s * sampleRate));
  return concat(
    vowel("e", 0.16, sampleRate),
    vowel("o", 0.22, sampleRate, 190),
    pause(0.08),
    vowel("a", 0.2, sampleRate, 220),
    vowel("i", 0.12, sampleRate, 230),
    pause(0.06),
    vowel("a", 0.18, sampleRate, 200),
    hiss(0.08, sampleRate),
    vowel("a", 0.24, sampleRate, 180),
    pause(0.2),
  );
}
