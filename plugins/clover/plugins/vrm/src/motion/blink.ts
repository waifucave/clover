// When the avatar blinks: every 2 to 6 seconds, now and then twice, each blink closing fast and opening
// slower. A pure function of time from a seed, so a still frame and a test see the same blink.

export const BLINK = {
  minGap: 2,
  maxGap: 6,
  close: 0.06,
  open: 0.1,
  /** How often a blink comes as a pair. */
  doubleChance: 0.15,
  doubleGap: 0.08,
} as const;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** One blink's closure `t` seconds after it began: 0 open, 1 shut. */
export function blinkCurve(t: number): number {
  if (t < 0) return 0;
  if (t < BLINK.close) return smooth(t / BLINK.close);
  if (t < BLINK.close + BLINK.open) return 1 - smooth((t - BLINK.close) / BLINK.open);
  return 0;
}

export class Blinker {
  private readonly starts: number[] = [];
  private readonly random: () => number;
  private horizon = 0;

  constructor(seed = 0x5eed) {
    this.random = mulberry32(seed);
  }

  private extend(until: number): void {
    while (this.horizon <= until + BLINK.maxGap) {
      const at = this.horizon + BLINK.minGap + this.random() * (BLINK.maxGap - BLINK.minGap);
      this.starts.push(at);
      if (this.random() < BLINK.doubleChance) this.starts.push(at + BLINK.close + BLINK.open + BLINK.doubleGap);
      this.horizon = this.starts[this.starts.length - 1]!;
    }
  }

  /** How shut the eyes are at `time` seconds. */
  value(time: number): number {
    this.extend(time);
    let shut = 0;
    for (const start of this.starts) {
      if (start > time) break;
      shut = Math.max(shut, blinkCurve(time - start));
    }
    return shut;
  }

  /** The blinks that begin before `until` (tests). */
  schedule(until: number): number[] {
    this.extend(until);
    return this.starts.filter((s) => s < until);
  }
}
