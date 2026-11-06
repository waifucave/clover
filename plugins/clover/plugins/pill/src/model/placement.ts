// Where the Dispatch pill lives (spec §10, the plan's G-M3 "all three OSes"): bottom centre on every OS, just above
// whatever the OS draws along the bottom (a Mac's Dock, Windows' taskbar, a Linux panel), read from the display's
// work area. Its window is only ever the pill's canvas (the pill, what floats above it, and the shadow's margin), and
// it takes clicks only on the pill itself; every other click passes through. Wayland gives no window always-on-top
// and lets none place itself, so there the pill is a normal window the user moves, without the shadow's margin. Pure:
// the surface host (lane E) supplies the display and applies the window and the regions, as it does the island's.

import type { Rect, SurfaceEnvironment, SurfaceWindowSpec } from "@waifucave/clover-plugin-island";
import { PILL, type Size } from "./metrics";

/** `overlay`: a transparent panel over everything, bottom centre. `window`: a normal window (Linux on Wayland). */
export type PillMode = "overlay" | "window";

export function pillMode(env: SurfaceEnvironment): PillMode {
  return env.os === "linux" && env.session === "wayland" ? "window" : "overlay";
}

/** The pill's canvas before it has measured itself: the compact pill and its shadow's margin. */
export const RESTING_CANVAS: Size = { width: PILL.compactWidth + 2 * PILL.shadowPad, height: PILL.pillHeight + 2 * PILL.shadowPad };

/** How far a window's edge sits from the pill's: the shadow's margin on an overlay, none in a framed window. */
export function pillInset(mode: PillMode): number {
  return mode === "overlay" ? PILL.shadowPad : 0;
}

/** The window for this canvas: centred on the display, its pill's bottom `dockGap` above the work area's bottom. */
export function pillWindow(env: SurfaceEnvironment, canvas: Size): SurfaceWindowSpec {
  const mode = pillMode(env);
  const inset = pillInset(mode);
  const { bounds, workArea } = env.display;
  const width = Math.ceil(canvas.width - 2 * (PILL.shadowPad - inset));
  const height = Math.ceil(canvas.height - 2 * (PILL.shadowPad - inset));
  // The pill's bottom edge, then the window's, which hangs `inset` lower for the shadow.
  const bottom = workArea.y + workArea.height - PILL.dockGap + inset;
  const at: Rect = { x: Math.round(bounds.x + (bounds.width - width) / 2), y: Math.round(bottom - height), width, height };
  if (mode === "window") {
    return { bounds: at, overlay: false, alwaysOnTop: false, transparent: false, frame: true, clickThrough: false, inTaskSwitcher: true, visible: true };
  }
  return { bounds: at, overlay: true, alwaysOnTop: true, transparent: true, frame: false, clickThrough: true, inTaskSwitcher: false, visible: true };
}

/** What the pill draws, for the regions that take clicks: the pill, the menu open above it (its own width, on its
 *  side), and the agents' row above that. */
export interface PillPieces {
  main: Size;
  menu?: { width: number; height: number; side: "leading" | "trailing" } | null;
  agents?: boolean;
}

/** How far the pill grows under the pointer past its resting rect (`hoverScale`), so a click at its edge counts. */
const HOVER_SLACK = 6;

/** Each piece's rect in the canvas, bottom up as the stack lays them out: the pill at the bottom inside the shadow's
 *  margin, then the menu, then the agents' row, `stackGap` apart. */
export function pieceRects(canvas: Size, pieces: PillPieces): Rect[] {
  const { main } = pieces;
  const left = (canvas.width - main.width) / 2;
  let y = canvas.height - PILL.shadowPad - main.height;
  const rects: Rect[] = [{ x: left, y, width: main.width, height: main.height }];
  const menu = pieces.menu;
  if (menu && menu.height > 0) {
    const width = Math.min(main.width, menu.width > 0 ? menu.width : main.width);
    y -= PILL.stackGap + menu.height;
    rects.push({ x: menu.side === "trailing" ? left + main.width - width : left, y, width, height: menu.height });
  }
  if (pieces.agents) {
    y -= PILL.stackGap + PILL.pillHeight;
    rects.push({ x: left, y, width: main.width, height: PILL.pillHeight });
  }
  return rects;
}

/** The parts of the window that take clicks: one region per piece the pill draws, never the shadow's margin or the
 *  empty space beside a menu or a card. Without the pieces, the whole pill and what floats above it. */
export function pillRegions(env: SurfaceEnvironment, canvas: Size, pieces?: PillPieces): Rect[] {
  const spec = pillWindow(env, canvas);
  const inset = pillInset(pillMode(env));
  if (!pieces) return [{ x: inset, y: inset, width: spec.bounds.width - 2 * inset, height: spec.bounds.height - 2 * inset }];
  // Canvas to window: the window drops the shadow's margin it doesn't keep.
  const shift = PILL.shadowPad - inset;
  return pieceRects(canvas, pieces).map((r) => {
    const x = Math.max(0, Math.floor(r.x - shift - HOVER_SLACK));
    const y = Math.max(0, Math.floor(r.y - shift - HOVER_SLACK));
    const right = Math.min(spec.bounds.width, Math.ceil(r.x - shift + r.width + HOVER_SLACK));
    const bottom = Math.min(spec.bounds.height, Math.ceil(r.y - shift + r.height + HOVER_SLACK));
    return { x, y, width: right - x, height: bottom - y };
  });
}
