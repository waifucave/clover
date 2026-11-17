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
