// A floating card's birth as a liquid, ported from the Swift reference's `DesktopIslandFluid`: the housing's whole lower
// edge sags into a body of liquid that falls on a heavy spring; the neck between them pinches in like an
// hourglass and parts; once free, the body spreads into the card on an underdamped spring, overshooting
// and squashing, then settling. Drawn through a blur and an alpha threshold (an SVG "goo" filter here),
// the shapes melt into one surface. Pure: a function of the seconds since the birth began.

import type { CardGeometry, Rect } from "./geometry";
import { easeIn, easeInOut, easeOut, lerp, phase, spring } from "./curves";

export type BlobKind = { kind: "ellipse" } | { kind: "capsule" } | { kind: "roundedRect"; radius: number };

export interface Blob {
  rect: Rect;
  shape: BlobKind;
}

export interface FluidFrame {
  blobs: Blob[];
  /** The melt's blur radius. */
  blur: number;
  /** How much of the crisp shell shows over the melt (0…1). */
  crisp: number;
  /** The shell's rect now. */
  card: Rect;
  /** How much of the content shows (0…1). */
  content: number;
}

export const FLUID = {
  /** The birth is over after this many seconds. */
  settle: 1.35,
  /** The way back up plays the birth backwards this much faster. */
  returnSpeed: 1.8,
  fallStart: 0.04,
  tailFade: { from: 0.16, to: 0.42 },
  spreadStart: 0.42,
  meltEnd: { from: 0.32, to: 0.5 },
  crispIn: { from: 0.44, to: 0.52 },
  contentIn: { from: 0.62, to: 0.92 },
} as const;

export function fluidFrame(g: CardGeometry, seconds: number): FluidFrame {
  const t = Math.max(0, seconds);
  const pillHeight = g.card.height;
  const midX = g.card.x + g.card.width / 2;
  const midY = g.card.y + g.card.height / 2;
  // The mass is born as wide as the housing it comes from: a flat body of liquid sagging out of its edge.
  const massWidth = g.floating ? 120 : g.sourceIsHousing ? g.source.width * 0.86 : 130;
  const massHeight = 26;

  const startY = g.floating ? midY : g.source.y + g.source.height - massHeight * 0.5;
  const fall = spring(t - FLUID.fallStart, 0.5, 0.7);
  const y = lerp(startY, midY, fall);
  const ahead = lerp(startY, midY, spring(t + 0.008 - FLUID.fallStart, 0.5, 0.7));
  const speed = Math.abs(ahead - y) / 0.008;
  const swell = g.floating ? easeOut(phase(t, 0, 0.22)) : 1;

  const spread = spring(t - FLUID.spreadStart, 0.5, 0.55);
  const lift = spring(t - FLUID.spreadStart, 0.34, 0.8);
  let w = lerp(massWidth, g.card.width, spread);
  let h = lerp(massHeight, pillHeight, Math.min(lift, 1));
  // Squash past the rest width, a little stretch before it: the liquid keeps its volume.
  h *= 1 - 0.55 * (spread - 1) * phase(t, FLUID.spreadStart, FLUID.spreadStart + 0.3);
  const stretch = Math.min(speed / 1000, 0.25) * (1 - Math.min(spread, 1));
  h *= 1 + stretch;
  w /= 1 + stretch * 0.4;
  w *= swell;
  h *= swell;
  h = Math.max(h, 0);
  const body: Rect = { x: midX - w / 2, y: y - h / 2, width: w, height: h };

  const blobs: Blob[] = [];
  if (!g.floating) {
    const above = 40;
    if (g.sourceIsHousing) {
      blobs.push({
        rect: { x: g.source.x, y: -above, width: g.source.width, height: g.source.y + g.source.height + above },
        shape: { kind: "roundedRect", radius: 9 },
      });
    } else {
      const band = 16 * (1 - easeInOut(phase(t, 0.3, 0.62)));
      if (band > 0.5) {
        blobs.push({
          rect: { x: g.source.x + g.source.width / 2 - massWidth / 2, y: -above, width: massWidth, height: band + above },
          shape: { kind: "roundedRect", radius: 14 },
        });
      }
    }
    // The neck: slices between the source and the falling mass, pinching in at the middle until it parts.
    const pinch = easeIn(phase(t, FLUID.tailFade.from, FLUID.tailFade.to));
    const top = g.source.y + g.source.height - 6;
    const bottom = y - h / 2 + 6;
    if (pinch < 1 && bottom > top) {
      const slices = 5;
      const step = (bottom - top) / slices;
      for (let i = 0; i < slices; i++) {
        const f = (i + 0.5) / slices;
        const waist = 1 - 0.85 * Math.sin(Math.PI * f) * Math.min(1, pinch * 1.6);
        const width = massWidth * 0.92 * waist * (1 - pinch);
        if (width > 1) {
          blobs.push({ rect: { x: midX - width / 2, y: top + step * i - 5, width, height: step + 10 }, shape: { kind: "ellipse" } });
        }
      }
    }
  }
  const shape: BlobKind =
    h >= w * 0.92
      ? { kind: "ellipse" }
      : g.cornerRadius !== null
        ? { kind: "roundedRect", radius: Math.min(g.cornerRadius, Math.min(w, h) / 2) }
        : { kind: "capsule" };
  if (body.width > 0.5 && body.height > 0.5) blobs.push({ rect: body, shape });

  const blur = 11 * (1 - easeInOut(phase(t, FLUID.meltEnd.from, FLUID.meltEnd.to)));
  return {
    blobs,
    blur,
    crisp: phase(t, FLUID.crispIn.from, FLUID.crispIn.to),
    card: body,
    content: easeOut(phase(t, FLUID.contentIn.from, FLUID.contentIn.to)),
  };
}

/** The birth's clock: forward from `bornAt`, then backwards, faster, from `returningAt` (both in ms). */
export function fluidSeconds(now: number, bornAt: number | null, returningAt: number | null): number {
  if (bornAt === null) return 0;
  const forward = Math.min((now - bornAt) / 1000, FLUID.settle);
  if (returningAt === null) return forward;
  return Math.max(0, forward - ((now - returningAt) / 1000) * FLUID.returnSpeed);
}
