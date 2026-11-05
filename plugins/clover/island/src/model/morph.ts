// The open island's morph, ported from the Swift reference's `IslandOpenMorph` and `IslandEdgeShape`: the black mass
// grows out of the strip into the open island as ONE shape whose width, height, bottom corners and top
// shoulders reshape on critically damped springs (no overshoot), its top flush with the screen's edge on
// every frame, flaring into it through two concave shoulders. The contents fade and un-blur in once the
// shape has mostly grown; closing plays it backwards, faster. Pure.

import type { Rect, Size } from "./geometry";
import { ISLAND, morphBlur, LIQUID } from "./geometry";
import { criticalSpring, easeOut, lerp, phase } from "./curves";

export interface MorphFrame {
  rect: Rect;
  /** The bottom corners now (the top is the screen's edge: square). */
  corner: number;
  /** The concave shoulders, outside the rect. */
  shoulder: number;
  content: number;
  blur: number;
}

export const MORPH = {
  settle: 0.5,
  closeSpeed: 1.6,
  widthResponse: 0.3,
  heightResponse: 0.36,
  contentIn: { from: 0.2, to: 0.45 },
} as const;

export interface Morph {
  source: Rect;
  target: Rect;
  sourceCorner: number;
  targetCorner: number;
  sourceShoulder?: number;
  targetShoulder?: number;
}

/** A shoulder never deeper than the side it flares from, nor than half the height. */
export function clampedShoulder(shoulder: number, height: number, corner: number): number {
  return Math.max(0, Math.min(shoulder, height - corner, height / 2));
}

export function restingFrame(rect: Rect): MorphFrame {
  return { rect, corner: ISLAND.islandCorner, shoulder: ISLAND.islandShoulder, content: 1, blur: 0 };
}

export function morphFrame(m: Morph, seconds: number): MorphFrame {
  const t = Math.min(Math.max(seconds, 0), MORPH.settle);
  const kw = t >= MORPH.settle ? 1 : criticalSpring(t, MORPH.widthResponse);
  const kh = t >= MORPH.settle ? 1 : criticalSpring(t, MORPH.heightResponse);
  const width = lerp(m.source.width, m.target.width, kw);
  const height = lerp(m.source.height, m.target.height, kh);
  const midX = lerp(m.source.x + m.source.width / 2, m.target.x + m.target.width / 2, kw);
  const minY = lerp(m.source.y, m.target.y, kh);
  const rect = { x: midX - width / 2, y: minY, width, height };
  const corner = Math.min(lerp(m.sourceCorner, m.targetCorner, kh), Math.min(width, height) / 2);
  const shoulder = clampedShoulder(lerp(m.sourceShoulder ?? 0, m.targetShoulder ?? ISLAND.islandShoulder, kw), height, corner);
  const content = t >= MORPH.settle ? 1 : easeOut(phase(t, MORPH.contentIn.from, MORPH.contentIn.to));
  const target: Size = { width: m.target.width, height: m.target.height };
  const blur = content >= 1 ? 0 : morphBlur({ width, height }, target) + LIQUID.maxMorphBlur * (1 - content);
  return { rect, corner: Math.max(0, corner), shoulder, content, blur };
}

/** The circle's control-point ratio for a quarter arc drawn as one cubic. */
const KAPPA = 0.55228475;

/**
 * The open island's outline as an SVG path, in a box `shoulder` wider on each side than `rect` (so the
 * shoulders, which lie outside the body, fit): a flat top flush with the box's top edge, a concave
 * shoulder at each top corner flaring out into that edge, straight sides and rounded bottom corners.
 * One path, so a fill has no seam.
 */
export function edgeShapePath(width: number, height: number, corner: number, shoulder: number): string {
  const s = clampedShoulder(shoulder, height, corner);
  const r = Math.max(0, Math.min(corner, width / 2, height));
  const k = KAPPA * s;
  const kr = KAPPA * r;
  const x0 = s;
  const x1 = s + width;
  const f = (n: number) => Number(n.toFixed(3));
  const d: string[] = [];
  // The body: top edge, right side, bottom-right corner, bottom, bottom-left corner, left side.
  d.push(`M ${f(x0)} 0`, `L ${f(x1)} 0`, `L ${f(x1)} ${f(height - r)}`);
  d.push(`C ${f(x1)} ${f(height - r + kr)} ${f(x1 - r + kr)} ${f(height)} ${f(x1 - r)} ${f(height)}`);
  d.push(`L ${f(x0 + r)} ${f(height)}`);
  d.push(`C ${f(x0 + r - kr)} ${f(height)} ${f(x0)} ${f(height - r + kr)} ${f(x0)} ${f(height - r)}`, "Z");
  if (s > 0.01) {
    // Left shoulder: along the edge from `s` out to the body's corner, down its side, and back up along
    // the quarter circle centred `s` out and `s` down — concave, flaring into the edge.
    d.push(`M 0 0`, `L ${f(x0)} 0`, `L ${f(x0)} ${f(s)}`, `C ${f(x0)} ${f(s - k)} ${f(k)} 0 0 0`, "Z");
    d.push(`M ${f(x1 + s)} 0`, `L ${f(x1)} 0`, `L ${f(x1)} ${f(s)}`, `C ${f(x1)} ${f(s - k)} ${f(x1 + s - k)} 0 ${f(x1 + s)} 0`, "Z");
  }
  return d.join(" ");
}

/** The open island's clock (ms): opening forward from `openedAt`, closing backwards from where it was. */
export interface MorphClock {
  openedAt: number | null;
  closing: { at: number; from: number } | null;
}

export function morphSeconds(clock: MorphClock, now: number): number {
  if (clock.closing) return Math.max(0, clock.closing.from - ((now - clock.closing.at) / 1000) * MORPH.closeSpeed);
  if (clock.openedAt === null) return 0;
  return Math.min((now - clock.openedAt) / 1000, MORPH.settle);
}

/** Starts opening — from wherever a closing had got to, so a quick reopen never jumps. */
export function beginOpening(clock: MorphClock, now: number, instant = false): MorphClock {
  const from = instant ? MORPH.settle : clock.closing ? morphSeconds(clock, now) : 0;
  return { openedAt: now - from * 1000, closing: null };
}

/** Starts closing from wherever the opening is; also says how long the way back takes (ms). */
export function beginClosing(clock: MorphClock, now: number): { clock: MorphClock; durationMs: number } {
  const from = morphSeconds(clock, now);
  return { clock: { openedAt: clock.openedAt, closing: { at: now, from } }, durationMs: (from / MORPH.closeSpeed) * 1000 };
}
