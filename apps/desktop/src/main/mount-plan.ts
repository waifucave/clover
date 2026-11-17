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
import { SURFACE_MOUNTS, type HostState, type MountList } from "@waifucave/moss-protocol";
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

export function mountPlan(program: DesktopProgram, mount: MountList | undefined, hostState?: HostState): MountPlan {
  let list: Pick<MountList, "points" | "browserPages" | "drawsCards"> = mount ?? (program === "host" ? SURFACE_MOUNTS.host : EVERYTHING);
  // Once the window has heard the host's state, that decides: a host that owns the screen takes it, one that went away
  // (stopped, absent) gives it back.
  if (program === "code" && hostState !== undefined) list = hostOwnsScreen(hostState) ? SURFACE_MOUNTS.code : EVERYTHING;
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
