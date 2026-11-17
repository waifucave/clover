// Which mount list a hello gets (lane HS): MOSS Code's window keeps today's whole list only while no host owns the screen.
import { expect, test } from "bun:test";
import { LEGACY_CODE_MOUNTS, SURFACE_MOUNTS } from "@waifucave/moss-protocol";
import { mountFor } from "../mounts";

test("a window gets today's whole list with no host, its own once a host runs; the host and MOSS always their own", () => {
  for (const s of [undefined, "stopped", "absent"] as const) expect(mountFor("code", s)).toBe(LEGACY_CODE_MOUNTS);
  for (const s of ["starting", "running", "safe-mode", "restarting"] as const) expect(mountFor("code", s)).toBe(SURFACE_MOUNTS.code);
  expect(mountFor("host", undefined)).toBe(SURFACE_MOUNTS.host);
  expect(mountFor("moss", "running")).toBe(SURFACE_MOUNTS.moss);
});
