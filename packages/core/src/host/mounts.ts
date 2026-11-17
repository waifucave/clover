// Whether a background host owns the screen and the pages (spec revision 19, §3.4 "Mount lists", G1; lane HS): MOSS
// Code's window keeps today's whole list (`LEGACY_CODE_MOUNTS`, the screen's points and the browser's pages too) while no
// host owns them, so a computer with no host (a checkout, an app that carries none yet) still has its island, its pill
// and its browser. Once a host owns them, the window mounts only what draws inside it, and the host owns the screen
// layer and the pages: one island, one owner (§5.5 R12). Lane RT's surface door asks this at each hello.
import type { HostState } from "@waifucave/moss-protocol";

/** The host states in which it owns the screen and the pages (it runs, or is on its way and will). */
export function hostOwnsScreen(state: HostState | undefined): boolean {
  return state === "starting" || state === "running" || state === "safe-mode" || state === "restarting";
}
