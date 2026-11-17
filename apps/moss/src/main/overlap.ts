// MOSS's own copy of MOSS Code's overlap check (apps/desktop/src/main/overlap.ts, lane RT): the two apps share no code.
// The overlap check's OS-wide half (spec revision 19, §5.5 R12, ruling B; lane RT): a press on a sealed button counts only
// while no window of OUR programs (MOSS, MOSS Code, the background host, where a third-party plugin's on-screen part runs)
// lies over it, read from the OS's own window list, so one of our programs can't cover a sealed button another of them drew.
// A window of any other app is not checked: a native app already running as the person is outside what the sealed button
// defends against, and counting it would let a screen tint, a recorder or an accessibility overlay that stays on top refuse
// every press (Approve doing nothing). Which program owns a window: the bundle identifier of its owning process, one of
// `PROGRAM_IDENTIFIERS` (dist or dev). An app spoofing one of ours only makes more windows count, which gains it nothing.
// The in-page half stays the sealed page's own (IntersectionObserver v2, the fresh reading at the press).
//
//   macOS    the screen add-on's `windowsAbove(id)` (native/input/macos/screen.mm): CGWindowListCopyWindowInfo, on-screen
//            windows above ours, desktop elements left out, bounds / layer / alpha / pid / window number only (never a title
//            or an owner's name, which the Screen Recording permission guards), and `bundleOf(pid)` (NSRunningApplication).
//            Nothing here prompts.
//   Windows  not built: EnumWindows in z-order above the window's HWND (GetWindow(hwnd, GW_HWNDPREV) walked to the top),
//            each visible and not cloaked (DwmGetWindowAttribute DWMWA_CLOAKED), its rect (DWMWA_EXTENDED_FRAME_BOUNDS),
//            WS_EX_LAYERED alpha (GetLayeredWindowAttributes), its pid (GetWindowThreadProcessId) and that process's image
//            (QueryFullProcessImageNameW, matched to our programs' install paths): a small Node-API add-on like this one.
//   Linux    not built: X11 reads _NET_CLIENT_LIST_STACKING above the window and each one's geometry and _NET_WM_PID, the
//            pid's /proc/<pid>/exe matched to our programs; Wayland gives no client the global stacking order, so there the
//            spec's own rule stands (plugin overlays hide while a card is pending).
//
// What counts as over the button: one of our programs' windows above ours whose area meets the 24 by 24 box around the press
// point (the smallest button) and that draws something (alpha above zero). One of our surfaces (the island, the pill:
// transparent, click-through windows) covers only the regions it draws, which the app knows. A press made from the keyboard
// has no point and is not checked here (the page's fresh reading still is).
import { createRequire } from "node:module";
import { PROGRAM_IDENTIFIERS } from "@waifucave/moss-protocol";
/** A rectangle in points. */
export interface Rect { x: number; y: number; width: number; height: number }

/** Whether a bundle identifier is one of MOSS's programs' (dist or dev). */
export function isOurProgram(bundle: string | undefined): boolean {
  return bundle !== undefined && Object.values(PROGRAM_IDENTIFIERS).some((p) => p.dist === bundle || p.dev === bundle);
}

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

/** The OS's windows above the window with that id (front first), and the bundle identifier of a running app by pid. */
export interface WindowList {
  above: (windowId: number) => OsWindow[];
  bundleOf: (pid: number) => string | undefined;
}

/** The add-on's read, if this OS has one and it was built; undefined otherwise (the in-page half then stands alone). */
export function loadWindowList(path: string, log: (line: string) => void, platform: NodeJS.Platform = process.platform): WindowList | undefined {
  if (platform !== "darwin") return undefined;
  try {
    const m = createRequire(import.meta.url)(path) as { windowsAbove?: (id: number) => unknown; bundleOf?: (pid: number) => unknown };
    if (typeof m.windowsAbove !== "function" || typeof m.bundleOf !== "function") return undefined;
    const read = m.windowsAbove;
    const bundle = m.bundleOf;
    return {
      above: (id) => {
        const raw = read(id);
        return Array.isArray(raw) ? raw.filter(isOsWindow) : [];
      },
      bundleOf: (pid) => {
        const b = bundle(pid);
        return typeof b === "string" && b.length <= 255 ? b : undefined;
      },
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

/** The first of our programs' windows above ours that covers the box around `point` (global points), or undefined. `ours`:
 *  whether a pid is one of our programs (another app's window never counts). `own`: this program's own surfaces by window
 *  number with the regions they draw (window coordinates, from the content's top left), so a transparent click-through
 *  surface covers only where it draws. */
export function coverAt(point: { x: number; y: number }, above: readonly OsWindow[], o: {
  ours: (pid: number) => boolean;
  own?: ReadonlyMap<number, { origin: { x: number; y: number }; regions?: readonly Rect[] }>;
  half?: number;
}): OsWindow | undefined {
  const half = o.half ?? PRESS_BOX_HALF;
  const box: Rect = { x: point.x - half, y: point.y - half, width: half * 2, height: half * 2 };
  const known = new Map<number, boolean>();
  const isOurs = (pid: number): boolean => {
    let v = known.get(pid);
    if (v === undefined) known.set(pid, (v = o.ours(pid)));
    return v;
  };
  for (const w of above) {
    if (!(w.alpha > 0) || !(w.width > 0) || !(w.height > 0)) continue;
    const mine = o.own?.get(w.id);
    if (mine?.regions !== undefined) {
      if (mine.regions.some((r) => meets({ x: mine.origin.x + r.x, y: mine.origin.y + r.y, width: r.width, height: r.height }, box))) return w;
      continue;
    }
    if (!meets({ x: w.x, y: w.y, width: w.width, height: w.height }, box)) continue;
    if (isOurs(w.pid)) return w;
  }
  return undefined;
}

/** The whole check for one press: undefined (taken) when it came from the keyboard (no point) or nothing of ours covers it. */
export function pressCover(press: { point: { x: number; y: number } | undefined; above: readonly OsWindow[]; ours: (pid: number) => boolean; own?: ReadonlyMap<number, { origin: { x: number; y: number }; regions?: readonly Rect[] }> }): OsWindow | undefined {
  if (press.point === undefined) return undefined;
  return coverAt(press.point, press.above, { ours: press.ours, ...(press.own !== undefined ? { own: press.own } : {}) });
}

/** One press's whole OS-wide check in a window of this program (`windowNumber`, its content's top left in global points
 *  `content`), named by what covers it, or undefined. It fails OPEN: a window list that throws (the add-on, the OS) is
 *  said once and the press goes on to the page's own fresh reading, never a refusal the person can't do anything about.
 *  `headless`: a test's run counts only this process's own windows (among other runs' windows). */
export function coverOfPress(o: {
  list: WindowList;
  windowNumber: number;
  content: { x: number; y: number };
  point: { x: number; y: number } | undefined;
  pid: number;
  headless: boolean;
  log: (line: string) => void;
  said: { read: boolean; failed: boolean };
}): string | undefined {
  try {
    const above = o.list.above(o.windowNumber);
    const ours = (pid: number): boolean => pid === o.pid || (!o.headless && isOurProgram(o.list.bundleOf(pid)));
    const hit = pressCover({ point: o.point === undefined ? undefined : { x: o.content.x + o.point.x, y: o.content.y + o.point.y }, above, ours });
    if (!o.said.read) { o.said.read = true; o.log(`overlap: the OS window list read for a press (${above.length} above, ${above.filter((w) => w.pid === o.pid).length} of MOSS's own${o.headless ? "; headless: its own only" : ""}${o.point === undefined ? "; no point: a keyboard press" : ""})`); }
    if (hit === undefined) return undefined;
    return hit.pid === o.pid ? `one of MOSS's own windows (layer ${hit.layer})` : `another MOSS program's window (layer ${hit.layer})`;
  } catch (err) {
    if (!o.said.failed) { o.said.failed = true; o.log(`overlap: the OS window list couldn't be read for a press (${err instanceof Error ? err.message.split("\n")[0]!.slice(0, 120) : "it threw"}); the in-page check stands alone`); }
    return undefined;
  }
}
