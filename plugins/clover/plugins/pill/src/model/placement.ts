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

/** The part of the window that takes clicks: the pill and what floats above it, never the shadow's margin. */
export function pillRegions(env: SurfaceEnvironment, canvas: Size): Rect[] {
  const spec = pillWindow(env, canvas);
  const inset = pillInset(pillMode(env));
  return [{ x: inset, y: inset, width: spec.bounds.width - 2 * inset, height: spec.bounds.height - 2 * inset }];
}
