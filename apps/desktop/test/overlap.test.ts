// The overlap check's OS-wide half (overlap.ts, R12; lane RT): a window of any app above a sealed button refuses the press, our
// own surfaces cover only where they draw, a see-through window covers nothing, and a headless run reads its own windows
// only. The add-on's read is checked on a Mac where the build made it: it gives windows' numbers only, never a title, and
// nothing here is drawn, focused or printed.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { coverAt, loadWindowsAbove, PRESS_BOX_HALF, windowIdOfMediaSource, type OsWindow } from "../src/main/overlap";

const win = (over: Partial<OsWindow>): OsWindow => ({ id: 7, x: 0, y: 0, width: 100, height: 100, layer: 0, alpha: 1, pid: 4242, ...over });

describe("what lies over a sealed button", () => {
  test("another app's window over the press point covers it; one beside it doesn't; the box is the smallest button's", () => {
    expect(PRESS_BOX_HALF).toBe(12);
    expect(coverAt({ x: 50, y: 50 }, [win({})])?.id).toBe(7);
    expect(coverAt({ x: 150, y: 50 }, [win({})])).toBeUndefined();
    // A window whose edge reaches into the 24 by 24 box covers part of the button: refused.
    expect(coverAt({ x: 110, y: 50 }, [win({})])?.id).toBe(7);
    expect(coverAt({ x: 113, y: 50 }, [win({})])).toBeUndefined();
  });

  test("a see-through window (alpha 0) or an empty one covers nothing; the first that covers is named", () => {
    expect(coverAt({ x: 50, y: 50 }, [win({ alpha: 0 }), win({ width: 0 })])).toBeUndefined();
    expect(coverAt({ x: 50, y: 50 }, [win({ alpha: 0 }), win({ id: 9, alpha: 0.4 })])?.id).toBe(9);
  });

  test("one of our own surfaces (transparent, click-through) covers only the regions it draws", () => {
    const own = new Map([[7, { origin: { x: 0, y: 0 }, regions: [{ x: 0, y: 0, width: 40, height: 20 }] }]]);
    expect(coverAt({ x: 80, y: 80 }, [win({})], { own })).toBeUndefined();
    expect(coverAt({ x: 30, y: 25 }, [win({})], { own })?.id).toBe(7);
    // Our own window that isn't a surface (another card window) covers with all of it.
    expect(coverAt({ x: 80, y: 80 }, [win({ id: 8, pid: process.pid })], { own })?.id).toBe(8);
  });

  test("a headless run reads its own windows only (the person's own apps lie above a test's invisible windows)", () => {
    expect(coverAt({ x: 50, y: 50 }, [win({ pid: 1 })], { onlyPid: 2 })).toBeUndefined();
    expect(coverAt({ x: 50, y: 50 }, [win({ pid: 2 })], { onlyPid: 2 })?.pid).toBe(2);
  });

  test("an Electron window's media source id gives its window number", () => {
    expect(windowIdOfMediaSource("window:12345:0")).toBe(12345);
    expect(windowIdOfMediaSource("screen:1:0")).toBeUndefined();
    expect(windowIdOfMediaSource("window:0:0")).toBeUndefined();
  });

  test("no window list off macOS: the in-page check stands alone", () => {
    expect(loadWindowsAbove("/nowhere/screen.node", () => {}, "linux")).toBeUndefined();
    expect(loadWindowsAbove("/nowhere/screen.node", () => {}, "win32")).toBeUndefined();
  });

  const built = process.env.MOSS_TEST_SCREEN_NODE ?? join(import.meta.dir, "..", "out", "main", "native", "screen.node");
  test.if(process.platform === "darwin" && existsSync(built))("the add-on reads windows' bounds and numbers only, and nothing for no window", () => {
    const read = loadWindowsAbove(built, (l) => { throw new Error(l); })!;
    expect(read).toBeFunction();
    expect(read(0)).toEqual([]);
    // A window number nobody holds: whatever the OS gives, each entry has the eight numbers and nothing else (no title, no name).
    for (const w of read(2 ** 31 - 2)) expect(Object.keys(w).sort()).toEqual(["alpha", "height", "id", "layer", "pid", "width", "x", "y"]);
  });
});
