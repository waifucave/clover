// The overlap check's OS-wide half (spec revision 19, §5.5 R12, ruling B; lane RT): a press on a sealed button counts only
// while no window lies over it, read from the OS's own window list, not one program's windows, so a window of ANY app above
// the button refuses the press. The in-page half stays the sealed page's own (IntersectionObserver v2, the fresh reading at
// the press), which sees only what is drawn inside this window's document; this half sees what lies over the window.
//
//   macOS    the screen add-on's `windowsAbove(id)` (native/input/macos/screen.mm): CGWindowListCopyWindowInfo, on-screen
//            windows above ours, desktop elements left out, bounds / layer / alpha / pid / window number only (never a title
//            or an owner's name, which the Screen Recording permission guards; nothing here prompts).
//   Windows  not built: the same read is EnumWindows in z-order above the window's HWND (GetWindow(hwnd, GW_HWNDPREV) walked
//            to the top), each visible, not cloaked (DwmGetWindowAttribute DWMWA_CLOAKED), its rect (DwmGetWindowAttribute
//            DWMWA_EXTENDED_FRAME_BOUNDS), WS_EX_LAYERED alpha (GetLayeredWindowAttributes) and owning pid
//            (GetWindowThreadProcessId): a small Node-API add-on like the screen one.
//   Linux    not built: X11 reads _NET_CLIENT_LIST_STACKING (or XQueryTree's stacking order) above the window and each one's
//            geometry and _NET_WM_PID; Wayland gives no client the global stacking order, so there the spec's own rule stands
//            (plugin overlays hide while a card is pending, and only the focused window of the product takes clicks).
//
// What counts as over the button: a window above ours whose area meets the box around the press point (the button is at
// least 24 by 24, so the box is 24 by 24 around where the person pressed) and that draws something: alpha above zero. Our
// own windows count too (another of the product's windows over a sealed button is a cover like any other), but one of our
// surfaces (the island, the pill: transparent, click-through windows) covers only the regions it draws, which the app
// knows. A headless run (a test's: its windows are invisible and the person's own apps lie above them) reads its own
// windows only.
import { createRequire } from "node:module";
import type { Rect } from "./ui/brokers";

/** One window above ours, as the add-on reads it: global points (top left of the main display), its CGWindowID. */
export interface OsWindow {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  alpha: number;
  pid: number;
}

/** The OS's windows above the window with that id (front first), or undefined where the OS has no read here. */
export type WindowsAbove = (windowId: number) => OsWindow[];

/** The add-on's read, if this OS has one and it was built; undefined otherwise (the in-page half then stands alone). */
export function loadWindowsAbove(path: string, log: (line: string) => void, platform: NodeJS.Platform = process.platform): WindowsAbove | undefined {
  if (platform !== "darwin") return undefined;
  try {
    const m = createRequire(import.meta.url)(path) as { windowsAbove?: (id: number) => unknown };
    if (typeof m.windowsAbove !== "function") return undefined;
    const read = m.windowsAbove;
    return (id) => {
      const raw = read(id);
      return Array.isArray(raw) ? raw.filter(isOsWindow) : [];
    };
  } catch (err) {
    log(`overlap: no window list (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); the in-page check stands alone`);
    return undefined;
  }
}

function isOsWindow(v: unknown): v is OsWindow {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return ["id", "x", "y", "width", "height", "layer", "alpha", "pid"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k] as number));
}

/** The CGWindowID in an Electron window's media source id (`window:<id>:0`), or undefined. */
export function windowIdOfMediaSource(source: string): number | undefined {
  const m = /^window:(\d+):/.exec(source);
  const n = m === null ? NaN : Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Half the side of the box around the press point that must lie clear (the smallest button is 24 by 24). */
export const PRESS_BOX_HALF = 12;

const meets = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The first window above ours that covers the box around `point` (global points), or undefined. `own`: our own windows by
 *  their window number, a surface with the regions it draws (window coordinates, its content's top left given), so a
 *  transparent click-through surface covers only where it draws. `onlyPid`: read only that process's windows (a headless
 *  run's own). */
export function coverAt(point: { x: number; y: number }, above: readonly OsWindow[], o: {
  own?: ReadonlyMap<number, { origin: { x: number; y: number }; regions?: readonly Rect[] }>;
  onlyPid?: number;
  half?: number;
} = {}): OsWindow | undefined {
  const half = o.half ?? PRESS_BOX_HALF;
  const box: Rect = { x: point.x - half, y: point.y - half, width: half * 2, height: half * 2 };
  for (const w of above) {
    if (o.onlyPid !== undefined && w.pid !== o.onlyPid) continue;
    if (!(w.alpha > 0) || !(w.width > 0) || !(w.height > 0)) continue;
    const mine = o.own?.get(w.id);
    if (mine?.regions !== undefined) {
      if (mine.regions.some((r) => meets({ x: mine.origin.x + r.x, y: mine.origin.y + r.y, width: r.width, height: r.height }, box))) return w;
      continue;
    }
    if (meets({ x: w.x, y: w.y, width: w.width, height: w.height }, box)) return w;
  }
  return undefined;
}
