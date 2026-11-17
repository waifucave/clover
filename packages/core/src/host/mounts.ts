// Which mount list an `app` hello gets (spec revision 19, §3.4 "Mount lists", G1; lane HS): the surface's own
// (`SURFACE_MOUNTS`), except that MOSS Code's window keeps today's whole list (`LEGACY_CODE_MOUNTS`, the screen's points
// and the browser's pages too) while no background host runs for the home, so a computer with no host (a checkout, an
// app that carries none yet) still has its island, its pill and its browser. Once a host is live, the window mounts only
// what draws inside it and the host owns the screen layer and the pages: one island, one owner (§5.5 R12).
import { LEGACY_CODE_MOUNTS, SURFACE_MOUNTS, type HostState, type MountList, type Surface } from "@waifucave/moss-protocol";

/** The host states in which it owns the screen and the pages (it runs, or is on its way and will). */
const HOST_OWNS: ReadonlySet<HostState> = new Set<HostState>(["starting", "running", "safe-mode", "restarting"]);

export function hostOwnsScreen(state: HostState | undefined): boolean {
  return state !== undefined && HOST_OWNS.has(state);
}

/** The mount list for a hello of `surface`, given the host's state now. */
export function mountFor(surface: Surface, hostState: HostState | undefined): MountList {
  if (surface === "code" && !hostOwnsScreen(hostState)) return LEGACY_CODE_MOUNTS;
  return SURFACE_MOUNTS[surface];
}
