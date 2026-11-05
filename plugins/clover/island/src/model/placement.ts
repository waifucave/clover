// Where the island lives (spec §4's surfaces table, §10, and the owner's decision 82): the same top-centre island on
// macOS, Windows and Linux, coloured by the theme. It grows from the camera housing on a Mac that has one, and from the
// top edge everywhere else. Wayland gives no window always-on-top and lets none place itself, so there the island is a
// normal window the user moves, always open. Pure: the surface host (lane E's runtime and its small native add-on for
// the housing) supplies the display, and applies the window and the regions that take clicks.

import { ISLAND, LIQUID, topInset, type Rect, type ScreenShape } from "./geometry";

export type SurfaceOs = "macos" | "windows" | "linux";

/** One display, in screen CSS pixels (top-left origin), as the surface host reads it. */
export interface SurfaceDisplay {
  bounds: Rect;
  /** The part of the display ordinary windows may use: below a menu bar, above a taskbar or a dock. */
  workArea: Rect;
  /** The camera housing, in the display's own coordinates; null on a display without one. */
  notch: Rect | null;
}

export interface SurfaceEnvironment {
  os: SurfaceOs;
  /** Linux only: the session's display server. */
  session?: "wayland" | "x11";
  display: SurfaceDisplay;
}

/**
 * - `notch`: at a Mac's camera housing, which the strip extends.
 * - `top`: a short tab hanging from the top centre (a Mac without a housing, Windows, Linux on X11).
 * - `window`: a normal window, open, that the user places (Linux on Wayland).
 */
export type IslandMode = "notch" | "top" | "window";

/** What the surface host opens: a frameless transparent overlay on top of everything, or a normal framed window. */
export interface SurfaceWindowSpec {
  /** Screen CSS pixels. A normal window's `x` and `y` are a first suggestion its compositor may ignore. */
  bounds: Rect;
  overlay: boolean;
  alwaysOnTop: boolean;
  transparent: boolean;
  frame: boolean;
  /** An overlay takes clicks only inside the regions the island reports (`interactiveRegions`); outside them they
   *  pass through to whatever lies below. */
  clickThrough: boolean;
  /** Shown in the task switcher and the taskbar: a normal window is, an overlay isn't. */
  inTaskSwitcher: boolean;
}

export interface IslandPlacement {
  mode: IslandMode;
  /** What the island's geometry reads: its housing, and the top band it hangs below. */
  shape: ScreenShape;
  window: SurfaceWindowSpec;
}

/** The overlay's room: the open island, or the tallest resting card with the newcomer waiting under it, plus the
 *  shadows' margins. Cards taller than this scroll their sealed fields inside their own frames. */
export const OVERLAY = {
  width: ISLAND.islandWidth + 2 * LIQUID.margin,
  /** Below the top band. */
  height: 420,
  /** Never more of the display's height than this. */
  maxScreenFraction: 0.6,
} as const;

/** The normal window on Wayland: the open island and its header, and the window's own frame around it. */
export const ISLAND_WINDOW = {
  width: ISLAND.islandWidth,
  height: ISLAND.islandHeight + ISLAND.headerHeight + 120,
} as const;

/** The smallest housing the island takes as one: anything less is a display that reports a sliver. */
const MIN_HOUSING = { width: 60, height: 12 } as const;

/** The housing the native add-on reports, if it is a real one at the display's top centre. */
export function housingOf(display: SurfaceDisplay): { width: number; height: number } | null {
  const n = display.notch;
  if (!n || n.width < MIN_HOUSING.width || n.height < MIN_HOUSING.height) return null;
  // The housing hangs from the top edge, centred: one reported anywhere else is not the camera's.
  const centre = display.bounds.width / 2;
  if (n.y > 1 || Math.abs(n.x + n.width / 2 - centre) > 2) return null;
  return { width: Math.round(n.width), height: Math.round(n.height) };
}

/** The island's mode on this display: the same island on every OS, only the way it hangs differs. */
export function islandMode(env: SurfaceEnvironment): IslandMode {
  if (env.os === "linux" && env.session === "wayland") return "window";
  if (env.os === "macos" && housingOf(env.display)) return "notch";
  return "top";
}

/** The menu bar's height a Mac reports (the work area starts below it); 0 where nothing sits along the top edge. */
function topBand(env: SurfaceEnvironment): number {
  const { bounds, workArea } = env.display;
  const band = Math.max(0, workArea.y - bounds.y);
  // A taskbar or panel along the top (Windows, GNOME's top bar) counts too: the island hangs below what is drawn there.
  return Math.min(band, 64);
}

export function islandPlacement(env: SurfaceEnvironment): IslandPlacement {
  const mode = islandMode(env);
  const { bounds } = env.display;
  if (mode === "window") {
    const shape: ScreenShape = { housing: null, menuBarHeight: 0 };
    return {
      mode,
      shape,
      window: {
        bounds: {
          x: Math.round(bounds.x + (bounds.width - ISLAND_WINDOW.width) / 2),
          y: Math.round(bounds.y + env.display.workArea.y - bounds.y + 24),
          width: ISLAND_WINDOW.width,
          height: ISLAND_WINDOW.height,
        },
        overlay: false,
        alwaysOnTop: false,
        transparent: false,
        frame: true,
        clickThrough: false,
        inTaskSwitcher: true,
      },
    };
  }
  const housing = mode === "notch" ? housingOf(env.display) : null;
  const shape: ScreenShape = { housing, menuBarHeight: topBand(env) };
  const top = topInset(shape);
  const height = Math.min(top + OVERLAY.height, Math.floor(bounds.height * OVERLAY.maxScreenFraction));
  return {
    mode,
    shape,
    window: {
      bounds: { x: Math.round(bounds.x + (bounds.width - OVERLAY.width) / 2), y: bounds.y, width: OVERLAY.width, height },
      overlay: true,
      alwaysOnTop: true,
      transparent: true,
      frame: false,
      clickThrough: true,
      inTaskSwitcher: false,
    },
  };
}

/** A rect in the island's own space (x from its centre) as one in the overlay window's space. */
export function toWindowRect(rect: Rect, placement: IslandPlacement): Rect {
  const centre = placement.window.bounds.width / 2;
  return { x: Math.round(centre + rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}
