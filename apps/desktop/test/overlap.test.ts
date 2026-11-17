// The overlap check's OS-wide half (overlap.ts, R12; lane RT): a window of one of OUR programs above a sealed button refuses
// the press, another app's window never does, our own surfaces cover only where they draw, a see-through window covers
// nothing, and a keyboard press isn't checked here. The add-on's read is checked on a Mac where the build made it: windows'
// numbers only, never a title, and nothing here is drawn, focused or printed. The rule's tests run on every OS's CI job; the
// native read only where this test can build the add-on itself (macOS with Xcode's tools: the macOS job and a Mac).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROGRAM_IDENTIFIERS } from "@waifucave/moss-protocol";
import { coverAdvice, coverAt, coverName, isOurProgram, loadWindowList, PRESS_BOX_HALF, pressCover, pressCoverRead, windowIdOfMediaSource, type OsWindow } from "../src/main/overlap";

const OURS = 4242;
const OTHER_APP = 777;
const win = (over: Partial<OsWindow>): OsWindow => ({ id: 7, x: 0, y: 0, width: 100, height: 100, layer: 0, alpha: 1, pid: OURS, ...over });
const bundles = new Map<number, string>([[OURS, PROGRAM_IDENTIFIERS.host.dist], [OTHER_APP, "com.example.screen-tint"]]);
const ours = (pid: number): boolean => isOurProgram(bundles.get(pid));

describe("what lies over a sealed button", () => {
  test("our programs' bundle identifiers, dist and dev, and nothing else", () => {
    for (const p of Object.values(PROGRAM_IDENTIFIERS)) {
      expect(isOurProgram(p.dist)).toBe(true);
      expect(isOurProgram(p.dev)).toBe(true);
    }
    expect(isOurProgram("com.waifucave.moss.core")).toBe(false);
    expect(isOurProgram("com.example.screen-tint")).toBe(false);
    expect(isOurProgram(undefined)).toBe(false);
  });

  test("a window of another app (not ours) over the press point: the press lands", () => {
    expect(coverAt({ x: 50, y: 50 }, [win({ pid: OTHER_APP })], { ours })).toBeUndefined();
    // A full-screen overlay that stays on top (a tint, a recorder) never refuses a press.
    expect(coverAt({ x: 50, y: 50 }, [win({ pid: OTHER_APP, layer: 1000, width: 5000, height: 5000 })], { ours })).toBeUndefined();
  });

  test("a window of another of our programs over the press point: refused; one beside it isn't; the box is the smallest button's", () => {
    expect(PRESS_BOX_HALF).toBe(12);
    expect(coverAt({ x: 50, y: 50 }, [win({})], { ours })?.id).toBe(7);
    expect(coverAt({ x: 50, y: 50 }, [win({ pid: OTHER_APP }), win({ id: 9 })], { ours })?.id).toBe(9);
    expect(coverAt({ x: 150, y: 50 }, [win({})], { ours })).toBeUndefined();
    expect(coverAt({ x: 110, y: 50 }, [win({})], { ours })?.id).toBe(7);
    expect(coverAt({ x: 113, y: 50 }, [win({})], { ours })).toBeUndefined();
  });

  test("a see-through window (alpha 0) or an empty one covers nothing", () => {
    expect(coverAt({ x: 50, y: 50 }, [win({ alpha: 0 }), win({ width: 0 })], { ours })).toBeUndefined();
    expect(coverAt({ x: 50, y: 50 }, [win({ alpha: 0 }), win({ id: 9, alpha: 0.4 })], { ours })?.id).toBe(9);
  });

  test("our own island and pill (transparent, click-through) cover only the regions they draw", () => {
    const own = new Map([[7, { origin: { x: 0, y: 0 }, regions: [{ x: 0, y: 0, width: 40, height: 20 }] }]]);
    expect(coverAt({ x: 80, y: 80 }, [win({})], { ours, own })).toBeUndefined();
    expect(coverAt({ x: 30, y: 25 }, [win({})], { ours, own })?.id).toBe(7);
    // Our own window that isn't a surface (another card window) covers with all of it.
    expect(coverAt({ x: 80, y: 80 }, [win({ id: 8 })], { ours, own })?.id).toBe(8);
  });

  test("a keyboard press has no point: unchanged, not checked here", () => {
    expect(pressCover({ point: undefined, above: [win({})], ours })).toBeUndefined();
    expect(pressCover({ point: { x: 50, y: 50 }, above: [win({})], ours })?.id).toBe(7);
  });

  test("a native read that throws fails OPEN: the press goes on to the page's own fresh reading", () => {
    const point = { x: 50, y: 50 };
    expect(pressCoverRead({ point, read: () => { throw new Error("CGWindowList refused"); }, ours })).toEqual({ failed: "CGWindowList refused" });
    expect(pressCoverRead({ point, read: () => [win({ pid: OTHER_APP })], ours: () => { throw new Error("no bundle"); } })).toEqual({ failed: "no bundle" });
    expect(pressCoverRead({ point, read: () => [win({})], ours }).cover?.id).toBe(7);
    expect(pressCoverRead({ point: undefined, read: () => [win({})], ours }).cover).toBeUndefined();
  });

  test("the refusal names what covers the button and says what works", () => {
    expect(coverName(win({ pid: 1 }), 1, undefined)).toBe("this");
    expect(coverName(win({ pid: 2 }), 1, PROGRAM_IDENTIFIERS.moss.dev)).toBe("moss");
    expect(coverName(win({ pid: 2 }), 1, PROGRAM_IDENTIFIERS.host.dist)).toBe("host");
    expect(coverName(win({ pid: 2 }), 1, undefined)).toBe("ours");
    for (const n of ["this", "moss", "code", "host", "ours"] as const) expect(coverAdvice(n)).toMatch(/press again/);
    expect(coverAdvice("this")).toMatch(/answer or close/);
    expect(coverAdvice("moss")).toMatch(/minimise/);
  });

  test("a headless run counts its own windows only", () => {
    const self = (pid: number) => pid === 2;
    expect(coverAt({ x: 50, y: 50 }, [win({ pid: 1 })], { ours: self })).toBeUndefined();
    expect(coverAt({ x: 50, y: 50 }, [win({ pid: 2 })], { ours: self })?.pid).toBe(2);
  });

  test("an Electron window's media source id gives its window number", () => {
    expect(windowIdOfMediaSource("window:12345:0")).toBe(12345);
    expect(windowIdOfMediaSource("screen:1:0")).toBeUndefined();
    expect(windowIdOfMediaSource("window:0:0")).toBeUndefined();
  });

  test("no window list off macOS: the in-page check stands alone", () => {
    expect(loadWindowList("/nowhere/screen.node", () => {}, "linux")).toBeUndefined();
    expect(loadWindowList("/nowhere/screen.node", () => {}, "win32")).toBeUndefined();
  });

  // The native read, against an add-on this test builds itself from native/input/macos/screen.mm (the app build's own clang
  // line, into a temp folder), never one another run left in out/: on macOS with Xcode's tools (the macOS CI job and a Mac);
  // everywhere else (the Linux and Windows jobs) only the pure rule above runs.
  const clang = process.platform === "darwin" && spawnSync("xcrun", ["--find", "clang++"], { encoding: "utf8" }).status === 0;
  test.if(clang)("the add-on (built here) reads windows' bounds and numbers only, and a bundle id by pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-overlap-addon-"));
    try {
      const built = join(dir, "screen.node");
      const source = join(import.meta.dir, "..", "..", "..", "native", "input", "macos", "screen.mm");
      const r = spawnSync("xcrun", ["clang++", "-x", "objective-c++", "-std=c++17", "-fobjc-arc", "-O2", "-arch", "arm64", "-mmacosx-version-min=14.0", "-shared", "-undefined", "dynamic_lookup", "-framework", "AppKit", "-o", built, source], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const list = loadWindowList(built, (l) => { throw new Error(l); })!;
      expect(list).toBeDefined();
      expect(list.above(0)).toEqual([]);
      for (const w of list.above(2 ** 31 - 2)) expect(Object.keys(w).sort()).toEqual(["alpha", "height", "id", "layer", "pid", "width", "x", "y"]);
      // A pid nobody holds has no bundle.
      expect(list.bundleOf(0)).toBeUndefined();
      expect(list.bundleOf(2 ** 31 - 2)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
