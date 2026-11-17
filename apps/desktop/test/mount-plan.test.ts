// What each program runs from its mount list (lane HS).
import { expect, test } from "bun:test";
import { LEGACY_CODE_MOUNTS, SURFACE_MOUNTS } from "@waifucave/moss-protocol";
import { mountPlan } from "../src/main/mount-plan";

test("the host: no window, the screen's parts, the pages and the one menu-bar icon", () => {
  expect(mountPlan("host", SURFACE_MOUNTS.host)).toEqual({ mainWindow: false, surfaces: true, background: true, tray: "host", browser: true, drawsCards: true });
});

test("MOSS Code's window: everything while no host runs; only its window once one owns the screen, and back if it goes", () => {
  expect(mountPlan("code", LEGACY_CODE_MOUNTS)).toEqual({ mainWindow: true, surfaces: true, background: true, tray: "app", browser: true, drawsCards: true });
  expect(mountPlan("code", SURFACE_MOUNTS.code)).toEqual({ mainWindow: true, surfaces: false, background: false, tray: "none", browser: false, drawsCards: true });
  expect(mountPlan("code", LEGACY_CODE_MOUNTS, "running")).toEqual(mountPlan("code", SURFACE_MOUNTS.code));
  expect(mountPlan("code", LEGACY_CODE_MOUNTS, "absent").surfaces).toBe(true);
  // A window that said hello while a host ran takes the screen back once it hears the host went away.
  expect(mountPlan("code", SURFACE_MOUNTS.code, undefined).surfaces).toBe(false);
  expect(mountPlan("code", SURFACE_MOUNTS.code, "stopped")).toEqual(mountPlan("code", LEGACY_CODE_MOUNTS));
  // An engine from before the split names no mount: today's app, whole.
  expect(mountPlan("code", undefined).surfaces).toBe(true);
});
