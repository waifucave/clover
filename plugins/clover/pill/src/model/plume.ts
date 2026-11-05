// What the pill shows while its bot works (the Swift reference's `PropulsionPlume` and `WorkingAnimationModel`): a
// sideways rocket plume filling the pill. Flat puffs leave a nozzle behind the stop button big, bunched and
// white-hot, and stream toward the leading end, cooling, spreading and shrinking; a few sparks shoot
// through faster. Every tool the bot uses is THROWN out of the nozzle as a small disc — its glyph, or a
// site's favicon — and rides the plume away. A value advanced by `tick`, never by a render loop, so its
// whole behaviour is testable; kept in normalised terms and laid out only when drawn, at any size.

export interface PlumeThrow {
  /** Stable across renders: each is thrown once. */
  id: string;
  kind: { tool: ToolGlyph } | { site: string };
}

export type ToolGlyph = "terminal" | "doc" | "pencil" | "search" | "globe" | "people" | "checklist" | "box" | "sparkle";

/** A tool's glyph on its disc, from the tool's name (the Swift reference's `workingToolSymbol`). */
export function toolGlyph(rawName: string): ToolGlyph {
  const name = rawName.toLowerCase();
  if (name.startsWith("mcp__")) {
    const [, , tool] = name.split("__");
    if (tool === "webfetch" || tool === "browser") return "globe";
    if (tool === "websearch") return "search";
    return "box";
  }
  switch (name) {
    case "bash":
    case "powershell":
      return "terminal";
    case "read":
    case "ls":
      return "doc";
    case "write":
    case "edit":
    case "multiedit":
      return "pencil";
    case "glob":
    case "grep":
    case "websearch":
    case "glossary":
      return "search";
    case "webfetch":
    case "browser":
      return "globe";
    case "agent":
    case "sendmessage":
    case "listagents":
      return "people";
    case "todowrite":
    case "routine":
      return "checklist";
    default:
      return "sparkle";
  }
}

/** mulberry32: a tiny seeded generator, so a plume is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Puff {
  age: number;
  lifetime: number;
  /** Where across the plume it drifts to, -1 (top) … 1 (bottom). */
  lane: number;
  size: number;
  spark: boolean;
  serial: number;
}

interface Token {
  age: number;
  lifetime: number;
  lane: number;
  item: PlumeThrow;
  serial: number;
}

export interface PlumeCircle {
  x: number;
  y: number;
  diameter: number;
  /** 1 at the nozzle (white-hot), 0 at the tail. */
  heat: number;
  spark: boolean;
}

export interface PlumeTile {
  x: number;
  y: number;
  side: number;
  heat: number;
  item: PlumeThrow;
}

export const PLUME = {
  defaultSeed: 0x9e3779b9,
  puffsPerSecond: 34,
  sparksPerSecond: 6,
  puffLifetime: [0.95, 1.3] as const,
  sparkLifetime: [0.45, 0.65] as const,
  puffSize: [0.78, 1.0] as const,
  nozzleDiameterShare: 0.9,
  sparkDiameterShare: 0.14,
  shrinkAlongPlume: 0.5,
  tailOvershootShare: 0.4,
  travelExponent: 1.7,
  tokenLifetime: [1.6, 1.9] as const,
  tokenSideShare: 0.7,
  tokenEmergeShare: 0.08,
  tokenTravelExponent: 1.35,
} as const;

const between = (random: () => number, [lo, hi]: readonly [number, number]) => lo + (hi - lo) * random();

export class PropulsionPlume {
  puffs: Puff[] = [];
  tokens: Token[] = [];
  private spawnedPuffs = 0;
  private launchedTokens = 0;
  private puffDebt = 0;
  private sparkDebt = 0;
  private readonly random: () => number;

  constructor(seed: number = PLUME.defaultSeed, prewarmed = false) {
    this.random = mulberry32(seed);
    if (prewarmed) {
      // Long enough that the oldest puff alive has reached the tail: a steady plume from the first frame.
      for (let i = 0; i < Math.ceil(PLUME.puffLifetime[1] * 60) + 1; i++) this.advance(1 / 60);
    }
  }

  /** The tail for a plume this high whose leading edge is at x = 0. */
  static tailX(height: number): number {
    return -height * PLUME.tailOvershootShare;
  }

  advance(dt: number): void {
    if (dt <= 0) return;
    for (const p of this.puffs) p.age += dt;
    this.puffs = this.puffs.filter((p) => p.age < p.lifetime);
    for (const t of this.tokens) t.age += dt;
    this.tokens = this.tokens.filter((t) => t.age < t.lifetime);
    this.puffDebt += dt * PLUME.puffsPerSecond;
    while (this.puffDebt >= 1) {
      this.puffDebt -= 1;
      this.spawn(this.puffDebt / PLUME.puffsPerSecond, false);
    }
    this.sparkDebt += dt * PLUME.sparksPerSecond;
    while (this.sparkDebt >= 1) {
      this.sparkDebt -= 1;
      this.spawn(this.sparkDebt / PLUME.sparksPerSecond, true);
    }
  }

  launch(item: PlumeThrow): void {
    this.tokens.push({ age: 0, lifetime: between(this.random, PLUME.tokenLifetime), lane: -0.85 + 1.7 * this.random(), item, serial: this.launchedTokens++ });
  }

  private spawn(age: number, spark: boolean): void {
    const lifetime = between(this.random, spark ? PLUME.sparkLifetime : PLUME.puffLifetime);
    const lane = -1 + 2 * this.random();
    const size = spark ? 1 : between(this.random, PLUME.puffSize);
    this.puffs.push({ age: Math.min(age, lifetime * 0.5), lifetime, lane, size, spark, serial: this.spawnedPuffs++ });
  }

  /** Every puff laid out in a rect, born at `emitterX` on its mid line, dying at `tailX`; oldest first. */
  circles(height: number, midY: number, emitterX: number, tailX: number): PlumeCircle[] {
    const out: PlumeCircle[] = [];
    for (const puff of this.puffs) {
      const p = Math.min(Math.max(puff.age / puff.lifetime, 0), 1);
      const travel = puff.spark ? p : p ** PLUME.travelExponent;
      const x = emitterX - travel * (emitterX - tailX);
      const diameter = puff.spark
        ? height * PLUME.sparkDiameterShare * (1 - 0.5 * travel)
        : height * PLUME.nozzleDiameterShare * puff.size * (1 - PLUME.shrinkAlongPlume * travel);
      const slack = Math.max(0, (height - diameter) / 2);
      const y = midY + puff.lane * slack * Math.min(1, p * 3);
      if (diameter > 0.25) out.push({ x, y, diameter, heat: puff.spark ? 1 : 1 - p, spark: puff.spark });
    }
    // Sparks draw over every puff.
    return [...out.filter((c) => !c.spark), ...out.filter((c) => c.spark)];
  }

  /** Every thrown disc laid out; it grows out of the nozzle, drifts to its lane and rides out. */
  tiles(height: number, midY: number, emitterX: number, tailX: number): PlumeTile[] {
    return this.tokens
      .map((token) => {
        const p = Math.min(Math.max(token.age / token.lifetime, 0), 1);
        const travel = p ** PLUME.tokenTravelExponent;
        const x = emitterX - travel * (emitterX - tailX);
        const side = height * PLUME.tokenSideShare * Math.min(1, 0.35 + (0.65 * p) / PLUME.tokenEmergeShare);
        const slack = Math.max(0, (height - side) / 2);
        const y = midY + token.lane * slack * Math.min(1, p * 2.5);
        return { x, y, side: Math.max(0, side), heat: 1 - p, item: token.item };
      })
      .filter((t) => t.side > 0.5);
  }
}

/**
 * The plume plus what it throws: tools seen for the first time leave the nozzle one by one; while a round
 * runs, its throws leave again in turn. What was already listed on the FIRST tick happened before the
 * plume appeared (the pill opened mid-turn) and is not thrown.
 */
export class WorkingAnimation {
  static readonly maxStep = 0.1;
  static readonly throwSpacing = 0.22;
  static readonly maxQueued = 24;
  static readonly repeatSpacing = 0.4;

  readonly plume: PropulsionPlume;
  queued: PlumeThrow[] = [];
  private seen = new Set<string>();
  private primed = false;
  private sinceLastThrow = Number.POSITIVE_INFINITY;
  private repeatCursor = 0;

  constructor(seed: number = PLUME.defaultSeed) {
    this.plume = new PropulsionPlume(seed, true);
  }

  tick(rawDt: number, thrown: readonly PlumeThrow[] = [], repeating: readonly PlumeThrow[] = [], animates = true): void {
    const dt = Math.max(0, Math.min(rawDt, WorkingAnimation.maxStep));
    if (!this.primed) {
      this.primed = true;
      for (const item of thrown) this.seen.add(item.id);
    } else {
      for (const item of thrown) {
        if (!this.seen.has(item.id)) {
          this.seen.add(item.id);
          this.queued.push(item);
        }
      }
      if (this.queued.length > WorkingAnimation.maxQueued) this.queued.splice(0, this.queued.length - WorkingAnimation.maxQueued);
    }
    if (!animates) return;
    this.plume.advance(dt);
    this.sinceLastThrow += dt;
    if (this.queued.length > 0) {
      if (this.sinceLastThrow < WorkingAnimation.throwSpacing) return;
      this.plume.launch(this.queued.shift()!);
      this.sinceLastThrow = 0;
    } else if (repeating.length > 0 && this.sinceLastThrow >= WorkingAnimation.repeatSpacing) {
      this.plume.launch(repeating[this.repeatCursor % repeating.length]!);
      this.repeatCursor = (this.repeatCursor + 1) % repeating.length;
      this.sinceLastThrow = 0;
    } else if (repeating.length === 0) {
      this.repeatCursor = 0;
    }
  }
}

export type Rgb = readonly [number, number, number];

export interface PlumePalette {
  tail: Rgb;
  body: Rgb;
  hot: Rgb;
}

const rgb = (r: number, g: number, b: number): Rgb => [r, g, b];

/** Dispatch's own plume is blue; each child agent's pill gets one of the others, never repeating on a row. */
export const PALETTES = {
  blue: { tail: rgb(0.05, 0.33, 1.0), body: rgb(0.16, 0.55, 1.0), hot: rgb(0.8, 0.93, 1.0) },
  violet: { tail: rgb(0.36, 0.12, 0.92), body: rgb(0.64, 0.4, 1.0), hot: rgb(0.93, 0.87, 1.0) },
  mint: { tail: rgb(0.0, 0.5, 0.46), body: rgb(0.15, 0.84, 0.7), hot: rgb(0.82, 1.0, 0.94) },
  rose: { tail: rgb(0.82, 0.08, 0.4), body: rgb(1.0, 0.36, 0.6), hot: rgb(1.0, 0.87, 0.92) },
  ember: { tail: rgb(0.88, 0.3, 0.0), body: rgb(1.0, 0.6, 0.12), hot: rgb(1.0, 0.94, 0.72) },
  lime: { tail: rgb(0.28, 0.58, 0.0), body: rgb(0.58, 0.88, 0.18), hot: rgb(0.92, 1.0, 0.78) },
  gold: { tail: rgb(0.72, 0.5, 0.0), body: rgb(1.0, 0.82, 0.16), hot: rgb(1.0, 0.97, 0.8) },
  orchid: { tail: rgb(0.62, 0.0, 0.66), body: rgb(0.9, 0.3, 0.92), hot: rgb(1.0, 0.86, 1.0) },
} as const satisfies Record<string, PlumePalette>;

export const CHILD_PALETTES: readonly PlumePalette[] = [PALETTES.violet, PALETTES.mint, PALETTES.rose, PALETTES.ember, PALETTES.lime, PALETTES.gold, PALETTES.orchid];

export function childPalette(index: number): PlumePalette {
  const n = CHILD_PALETTES.length;
  return CHILD_PALETTES[((index % n) + n) % n]!;
}

/** The plume's colour for a heat: the tail at 0, the body through the middle, the hot stop at the nozzle. */
export function plumeColor(heat: number, palette: PlumePalette = PALETTES.blue): Rgb {
  const stops: [number, Rgb][] = [
    [0, palette.tail],
    [0.55, palette.body],
    [1, palette.hot],
  ];
  const h = Math.min(Math.max(heat, 0), 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i]!;
    const [b, cb] = stops[i + 1]!;
    if (h <= b) {
      const t = (h - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
    }
  }
  return palette.hot;
}

export function cssRgb([r, g, b]: Rgb, alpha = 1): string {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

/** The soft bloom under each puff (the Swift reference's `PlumeGlow`): a disc blurred by 22 % of the plume's height. */
export const GLOW = {
  blurShare: 0.22,
  strength: 0.9,
  locations: [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1] as const,
};

/** A disc of `discRadius` convolved with a Gaussian of `sigma`, read at `r` from its centre (worked once). */
function blurredDisc(discRadius: number, sigma: number, r: number): number {
  const n = 48;
  const step = (2 * discRadius) / n;
  let sum = 0;
  for (let iy = 0; iy < n; iy++) {
    const y = -discRadius + step / 2 + iy * step;
    for (let ix = 0; ix < n; ix++) {
      const x = -discRadius + step / 2 + ix * step;
      if (x * x + y * y <= discRadius * discRadius) {
        const dx = r - x;
        sum += Math.exp(-(dx * dx + y * y) / (2 * sigma * sigma));
      }
    }
  }
  return Math.min(1, (sum * step * step) / (2 * Math.PI * sigma * sigma));
}

const glowGeometry = (() => {
  const discRadius = (PLUME.nozzleDiameterShare / 2) * 1.15;
  const sigma = GLOW.blurShare;
  const layerRadius = discRadius + 2.5 * sigma;
  return {
    /** The glow's radius, as a multiple of a puff's base diameter. */
    reach: layerRadius / PLUME.nozzleDiameterShare,
    alphas: GLOW.locations.map((location) => blurredDisc(discRadius, sigma, location * layerRadius)),
  };
})();

export const GLOW_REACH: number = glowGeometry.reach;
export const GLOW_ALPHAS: readonly number[] = glowGeometry.alphas;
