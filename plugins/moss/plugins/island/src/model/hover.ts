// Every floating island panel grows under the pointer by the SAME few points as the compact Dispatch
// pill (the Swift reference's `HoverGrowth`): its width by 316 × 3 % = 9.48, the height in proportion, from its top
// edge. The open island itself never grows. Pure.

import type { Rect, Size } from "./geometry";

export const HOVER = {
  referenceWidth: 316,
  referenceScale: 1.03,
  get points(): number {
    return this.referenceWidth * (this.referenceScale - 1);
  },
} as const;

/** The uniform scale for a panel this wide. */
export function hoverScale(width: number): number {
  return width > 0 ? 1 + HOVER.points / width : 1;
}

/** `rect` grown about its top edge's middle: what a hovered panel covers, and so its hit area. */
export function grownFromTop(rect: Rect): Rect {
  const s = hoverScale(rect.width);
  const pivotX = rect.x + rect.width / 2;
  return { x: pivotX + (rect.x - pivotX) * s, y: rect.y, width: rect.width * s, height: rect.height * s };
}

/** Hovering with hysteresis: inside the shape, or inside the grown one while already hovered. */
export function isOver(point: { x: number; y: number } | null, rect: Rect, wasHovered: boolean): boolean {
  if (!point || rect.width <= 0 || rect.height <= 0) return false;
  const r = wasHovered ? grownFromTop(rect) : rect;
  return point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
}

/** A point over a panel resting at `rect` (grown when `grown`) → the panel's own unscaled space. */
export function unscaled(point: { x: number; y: number }, rect: Rect, grown: boolean): { x: number; y: number } {
  const s = grown ? hoverScale(rect.width) : 1;
  const midX = rect.x + rect.width / 2;
  return { x: (point.x - midX) / s + rect.width / 2, y: (point.y - rect.y) / s };
}

export function sizeOf(rect: Rect): Size {
  return { width: rect.width, height: rect.height };
}
