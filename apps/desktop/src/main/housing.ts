// The camera housing (the notch) of each display, for a surface's environment (lane G's ask, spec §5.5): macOS says
// where it is through NSScreen's safe area and the two auxiliary areas either side of it, which the screen add-on
// (native/input/macos/screen.mm) reads. Windows and Linux have none to say, and a Mac without the add-on built reads
// as having none. The housing comes back in the display's own coordinates (top left), in points, as Electron's are.
import { createRequire } from "node:module";
import type { Rect } from "./ui/brokers";

/** One display as the add-on reads it, in AppKit's points (origin at the bottom left of the main display). */
export interface NativeScreen {
  id: number;
  frame: Rect;
  safeTop: number;
  left?: Rect;
  right?: Rect;
}

/** The housing between a display's two auxiliary areas, its height the safe area's top; null when there is none. */
export function housingOf(s: NativeScreen): Rect | null {
  if (s.left === undefined || s.right === undefined || !(s.safeTop > 0)) return null;
  const start = s.left.x + s.left.width;
  const width = s.right.x - start;
  if (!(width > 0)) return null;
  return { x: start - s.frame.x, y: 0, width, height: s.safeTop };
}

/** The add-on, if this OS has one and it was built; undefined otherwise (and the app does without). */
export function loadScreens(path: string, log: (line: string) => void, platform: NodeJS.Platform = process.platform): (() => NativeScreen[]) | undefined {
  if (platform !== "darwin") return undefined;
  try {
    const m = createRequire(import.meta.url)(path) as { screens?: () => NativeScreen[] };
    return typeof m.screens === "function" ? m.screens : undefined;
  } catch (err) {
    log(`screen: no add-on (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); no housing is known`);
    return undefined;
  }
}

/** The housing of the display with Electron's id (CGDirectDisplayID on macOS, as the add-on's), or null. */
export function housingFor(displayId: number, screens: (() => NativeScreen[]) | undefined): Rect | null {
  if (screens === undefined) return null;
  try {
    const s = screens().find((x) => x.id === displayId);
    return s === undefined ? null : housingOf(s);
  } catch {
    return null;
  }
}
