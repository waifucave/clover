// What this process runs, from the engine's mount list (spec revision 19, §3.4 "Mount lists", G1, item 121; lane HS).
// The plugin runtime is one library in both programs; the engine says what each mounts, and this turns that into the
// parts the main process starts: the main window, the screen's surfaces (`app.surface`), the background parts
// (`app.background`), the menu-bar icon, and the browser's pages.
//
// * The host: no window ever; the screen's points, the background parts and the pages as its list says; the one
//   menu-bar icon (item 112) whatever plugins add to it.
// * MOSS Code's window: its window, and the rest only as its list says. A window that connected while no host ran got
//   today's whole list; once a host owns the screen (`host_changed`), it lets the screen's parts and the pages go, and it
//   takes them back if the host goes away for good (stopped or absent), so there is never a second island.
// Pure: no Electron import (test/mount-plan.test.ts).
import { SURFACE_MOUNTS, type CardPlacement, type HostState, type MountList } from "@waifucave/moss-protocol";
import type { DesktopProgram } from "./host-program";

export interface MountPlan {
  mainWindow: boolean;
  surfaces: boolean;
  background: boolean;
  /** Whose menu-bar icon this process shows: the host's (open MOSS, open MOSS Code, stop everything), today's app's,
   *  or none (a window while the host owns the icon). */
  tray: "host" | "app" | "none";
  browser: boolean;
  drawsCards: boolean;
}

/** The host states in which it owns the screen and the pages (the engine's own rule, `packages/core/src/host/mounts.ts`). */
export function hostOwnsScreen(state: HostState | undefined): boolean {
  return state === "starting" || state === "running" || state === "safe-mode" || state === "restarting";
}

/** Today's whole list, for an engine whose hello names no mount (older than the split). */
const EVERYTHING: Pick<MountList, "points" | "browserPages" | "drawsCards"> = { points: ["themes", "locales", "app.root", "app.surface", "app.background", "app.tray"], browserPages: true, drawsCards: true };

/** Today's list without the screen's surfaces: a host the engine gave up on (`gaveUp`) leaves no island anywhere (the
 *  engine's door says the same), and the window draws its cards when it is focused. */
const NO_ISLAND: Pick<MountList, "points" | "browserPages" | "drawsCards"> = { ...EVERYTHING, points: EVERYTHING.points.filter((p) => p !== "app.surface") };

export function mountPlan(program: DesktopProgram, mount: MountList | undefined, hostState?: HostState, gaveUp = false): MountPlan {
  let list: Pick<MountList, "points" | "browserPages" | "drawsCards"> = mount ?? (program === "host" ? SURFACE_MOUNTS.host : EVERYTHING);
  // Once the window has heard the host's state, that decides: a host that owns the screen takes it, one that went away
  // (stopped, absent) gives it back, one the engine gave up on gives back all but the island.
  if (program === "code" && hostState !== undefined) list = hostOwnsScreen(hostState) ? SURFACE_MOUNTS.code : gaveUp ? NO_ISLAND : EVERYTHING;
  const has = (p: string) => list.points.includes(p);
  return {
    mainWindow: program === "code",
    surfaces: has("app.surface"),
    background: has("app.background"),
    tray: program === "host" ? "host" : has("app.tray") ? "app" : "none",
    browser: list.browserPages,
    drawsCards: list.drawsCards,
  };
}

/** What this process is for `fallbackMayDraw` (the reviewer's B2, "never nowhere"): it draws the island's cards when it mounts
 *  the screen's surfaces, and a window does too when the engine gave up on the host (no island anywhere: the router still
 *  places a card `island` or `elsewhere` with no window focused, and the window's fallback card is then the one place). */
export function fallbackHere(plan: Pick<MountPlan, "surfaces" | "mainWindow">, gaveUp: boolean): { drawsIsland: boolean; hasWindow: boolean } {
  return { drawsIsland: plan.surfaces || (plan.mainWindow && gaveUp), hasWindow: plan.mainWindow };
}

/** Whether this process may arm and draw its own fallback card for a card the router placed so (the reviewer's B1): one
 *  card is drawn in one place. The program that draws the island (the host, or a window with no host) for a card on the
 *  island or with no surface; MOSS Code's window for a card in its conversation or its strip; either while no placement
 *  has come yet (the safety net, re-decided when it comes). */
export function fallbackMayDraw(placed: CardPlacement | undefined, here: { drawsIsland: boolean; hasWindow: boolean }): boolean {
  if (placed === undefined) return true;
  if (placed.kind === "island" || placed.kind === "elsewhere") return here.drawsIsland;
  return here.hasWindow && placed.program === "code";
}
