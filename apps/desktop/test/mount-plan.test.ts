// What each program runs from its mount list (lane HS).
import { expect, test } from "bun:test";
import { LEGACY_CODE_MOUNTS, SURFACE_MOUNTS } from "@waifucave/moss-protocol";
import { fallbackHere, fallbackMayDraw, mountPlan } from "../src/main/mount-plan";

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

test("one card in one place: the host draws a fallback only for the island's cards, MOSS Code's window only for its own", () => {
  const host = { drawsIsland: true, hasWindow: false };
  const window = { drawsIsland: false, hasWindow: true };
  const alone = { drawsIsland: true, hasWindow: true };
  const strip = { kind: "strip", program: "code", window: "main" } as const;
  const conversation = { kind: "conversation", program: "code", window: "main" } as const;
  expect([fallbackMayDraw({ kind: "island" }, host), fallbackMayDraw({ kind: "elsewhere" }, host), fallbackMayDraw(strip, host), fallbackMayDraw(conversation, host)]).toEqual([true, true, false, false]);
  expect([fallbackMayDraw({ kind: "island" }, window), fallbackMayDraw(strip, window), fallbackMayDraw(conversation, window)]).toEqual([false, true, true]);
  // MOSS's own window is another program: not this app's to draw.
  expect(fallbackMayDraw({ kind: "strip", program: "moss", window: "main" }, window)).toBe(false);
  // A window with no host draws both, as today; before any placement, either may (the net).
  expect([fallbackMayDraw({ kind: "island" }, alone), fallbackMayDraw(strip, alone), fallbackMayDraw(undefined, host), fallbackMayDraw(undefined, window)]).toEqual([true, true, true, true]);
});

test("a host the engine gave up on: the window takes back all but the island (cards in the window while it is in front)", () => {
  const plan = mountPlan("code", undefined, "absent", true);
  expect(plan).toMatchObject({ mainWindow: true, surfaces: false, background: true, browser: true, drawsCards: true });
  expect(mountPlan("code", undefined, "absent", false).surfaces).toBe(true);
  // The fourth argument decides it (the reviewer's point 3): ignored, the gave-up plan would be today's whole list.
  expect(mountPlan("code", undefined, "absent", true)).not.toEqual(mountPlan("code", undefined, "absent"));
  expect(mountPlan("code", undefined, "absent")).toEqual(mountPlan("code", undefined));
  // The engine names no island then either (its door's `noIsland`): the window keeps everything else, its tray included.
  expect(mountPlan("code", undefined, "absent", true)).toEqual({ ...mountPlan("code", undefined), surfaces: false });
});

test("B2, never nowhere: with the host given up and no window focused, the window keeps the fallback card for a card on the island or with no surface", () => {
  const gaveUp = mountPlan("code", undefined, "absent", true);
  expect(gaveUp.surfaces).toBe(false);
  for (const place of [{ kind: "island" }, { kind: "elsewhere" }] as const) {
    expect(fallbackMayDraw(place, fallbackHere(gaveUp, true))).toBe(true);
    // Today's wiring (the island's drawer only) left it drawn by no program.
    expect(fallbackMayDraw(place, { drawsIsland: gaveUp.surfaces, hasWindow: gaveUp.mainWindow })).toBe(false);
  }
  // A host that owns the screen: the window keeps only its own placements (B1 unchanged); the host draws the island's.
  const owned = mountPlan("code", undefined, "running", false);
  expect(fallbackMayDraw({ kind: "island" }, fallbackHere(owned, false))).toBe(false);
  expect(fallbackMayDraw({ kind: "island" }, fallbackHere(mountPlan("host", undefined), false))).toBe(true);
});
