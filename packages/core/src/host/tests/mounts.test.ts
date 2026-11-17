// Which mount list a hello gets (lane HS over lane RT's door): MOSS Code's window keeps today's whole list only while no
// host owns the screen.
import { expect, test } from "bun:test";
import { LEGACY_CODE_MOUNTS, SURFACE_MOUNTS, type HostState } from "@waifucave/moss-protocol";
import { EngineSurfaceDoor } from "../../surfaces/door";
import { hostOwnsScreen } from "../mounts";

test("a window gets today's whole list with no host, its own once a host runs; the host and MOSS always their own", () => {
  let state: HostState | undefined;
  const door = new EngineSurfaceDoor({ legacy: () => !hostOwnsScreen(state) });
  let id = 1;
  const admit = (surface: "code" | "host" | "moss") => door.admit({ connId: id++, role: "app", surface } as never);
  const mountOf = (r: ReturnType<typeof admit>) => ("mount" in r ? r.mount : undefined);
  for (const s of [undefined, "stopped", "absent"] as const) { state = s; expect(mountOf(admit("code"))).toBe(LEGACY_CODE_MOUNTS); }
  for (const s of ["starting", "running", "safe-mode", "restarting"] as const) { state = s; expect(mountOf(admit("code"))).toBe(SURFACE_MOUNTS.code); }
  expect(mountOf(admit("moss"))).toBe(SURFACE_MOUNTS.moss);
});

// The reviewer's S1: a window's mount at the door follows the host's state after its hello, as the window re-mounts.
test("the surface door re-mounts each code window when the host's state changes, and the island's drawer with it", async () => {
  const { EngineSurfaceDoor } = await import("../../surfaces/door");
  let owns = false;
  const door = new EngineSurfaceDoor({ legacy: () => !owns });
  const heard: boolean[] = [];
  door.watch(() => heard.push(door.islandLive()));
  door.admit({ connId: 1, role: "app", surface: "code" });
  expect(door.islandDrawer(1)).toBe(true);
  // A host starts: the window that connected before it no longer draws the island.
  owns = true;
  door.remount();
  expect([door.islandDrawer(1), door.islandLive()]).toEqual([false, false]);
  // Nothing changed: nobody hears it again.
  const n = heard.length;
  door.remount();
  expect(heard.length).toBe(n);
  // The host is gone for good: the window draws the island again, and the door knows it.
  owns = false;
  door.remount();
  expect([door.islandDrawer(1), door.islandLive()]).toEqual([true, true]);
});

test("a host given up on: the door mounts a code window with no island, so the router has none", async () => {
  const { EngineSurfaceDoor } = await import("../../surfaces/door");
  let gaveUp = true;
  const door = new EngineSurfaceDoor({ legacy: () => true, noIsland: () => gaveUp });
  door.admit({ connId: 7, role: "app", surface: "code" });
  expect([door.islandDrawer(7), door.islandLive()]).toEqual([false, false]);
  gaveUp = false;
  door.remount();
  expect(door.islandLive()).toBe(true);
});
