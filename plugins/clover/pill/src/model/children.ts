// The row of small pills above the main one: the agents and side threads working for the pill's bot
// (Winter's child sessions; in Clover, `Agent` delegations and their kin, spec §9.3). Ported from
// `ChildSessionPillsView`'s pure parts. Pure.

import { CHILD_ROW_HEIGHT, PILL } from "./metrics";

export type ChildStatus = "working" | "needsYou" | "failed" | "done";

export interface ChildItem {
  id: string;
  title: string;
  status: ChildStatus;
}

/** A child that can still be stopped: the same stop the main pill offers. */
export function stoppable(status: ChildStatus): boolean {
  return status === "working" || status === "needsYou";
}

/** A wire status as the row draws it; anything unknown is working, the safe reading for a child that exists. */
export function childStatus(wire: string): ChildStatus {
  switch (wire) {
    case "awaiting_approval":
    case "awaiting_input":
      return "needsYou";
    case "error":
      return "failed";
    case "completed":
      return "done";
    default:
      return "working";
  }
}

export interface ChildLayout {
  visible: number;
  pillWidth: number;
  overflow: number;
}

/**
 * One child takes the row's whole width, two split it, and so on while every pill stays at least
 * `minChildPillWidth`; past that, as many as fit beside a "+n" circle keep an even share.
 */
export function childLayout(count: number, rowWidth: number, gap: number = PILL.childPillGap, overflowDiameter: number = CHILD_ROW_HEIGHT, minWidth: number = PILL.minChildPillWidth): ChildLayout {
  if (count <= 0) return { visible: 0, pillWidth: 0, overflow: 0 };
  const fitting = Math.max(1, Math.floor((rowWidth + gap) / (minWidth + gap)));
  if (count <= fitting) return { visible: count, pillWidth: Math.max(0, (rowWidth - gap * (count - 1)) / count), overflow: 0 };
  const visible = Math.max(1, Math.floor((rowWidth - overflowDiameter) / (minWidth + gap)));
  return { visible, pillWidth: Math.max(0, (rowWidth - overflowDiameter - gap * visible) / visible), overflow: count - visible };
}

/**
 * Gives every child without a colour the next one round the wheel, skipping colours a child still on the
 * row wears. A colour, once given, never changes.
 */
export function assignPaletteSlots(roster: readonly string[], assigned: Readonly<Record<string, number>>, cursor: number, count: number): { assigned: Record<string, number>; cursor: number } {
  const out: Record<string, number> = { ...assigned };
  let next = cursor;
  if (count <= 0) return { assigned: out, cursor };
  for (const id of roster) {
    if (out[id] !== undefined) continue;
    const worn = new Set(roster.map((r) => out[r]).filter((s): s is number => s !== undefined));
    let slot = next % count;
    for (let i = 0; i < count; i++) {
      const candidate = (next + i) % count;
      if (!worn.has(candidate)) {
        slot = candidate;
        break;
      }
    }
    out[id] = slot;
    next = (slot + 1) % count;
  }
  return { assigned: out, cursor: next };
}

/** A child pill part-way into the row: it rises out of the main pill, growing, fading and sharpening in. */
export function entrance(progress: number): { scale: number; offsetY: number; opacity: number; blur: number } {
  const p = Math.min(Math.max(progress, 0), 1);
  return { scale: 0.55 + 0.45 * p, offsetY: (1 - p) * 18, opacity: p, blur: (1 - p) * 6 };
}
