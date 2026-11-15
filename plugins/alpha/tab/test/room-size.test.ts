// Her room sizes itself by her tab's width, the window's less the window's own sidebar beside it (its measured width, else the
// stock one for its fold): the same steps her layout's container queries take on the scene, so the room and the layout agree
// on wide, mid and narrow. Her controls start clear of the window's own buttons only where they reach into her tab.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { controlsInset, EDGE_PX, NARROW_MAX_PX, roomSize, safeLeft, SIDEBAR_FOLDED_PX, SIDEBAR_OPEN_PX, sidebarWidth, tabWidth, WIDE_MIN_PX, type WindowSides } from "../../client/room-size";

const win = (collapsed: boolean, width?: number, safe = 80): WindowSides => ({ sidebar: { collapsed, ...(width !== undefined ? { width } : {}) }, safeArea: { left: safe } });

describe("her room's size", () => {
  test("the tab is the window less the sidebar: its measured width, else the stock one for its fold (open until the window says)", () => {
    expect(tabWidth(1280, undefined)).toBe(1280 - SIDEBAR_OPEN_PX);
    expect(tabWidth(1280, win(false))).toBe(1280 - SIDEBAR_OPEN_PX);
    expect(tabWidth(1280, win(true))).toBe(1280 - SIDEBAR_FOLDED_PX);
    // A measured width wins (a narrower rail on another system, or a sidebar plugin's own width).
    expect(tabWidth(1280, win(true, 65))).toBe(1215);
    expect(tabWidth(1280, win(false, 320))).toBe(960);
    expect(sidebarWidth(win(false, 0))).toBe(0);
  });

  test("the window the app opens (1280, the sidebar open) is her wide room, folded too; a 700 one is narrow either way", () => {
    expect(roomSize(tabWidth(1280, win(false, 248)))).toBe("wide");
    expect(roomSize(tabWidth(1280, win(true, 81)))).toBe("wide");
    expect(roomSize(tabWidth(1060, win(false, 248)))).toBe("mid");
    expect(roomSize(tabWidth(1060, win(true, 81)))).toBe("mid");
    expect(roomSize(tabWidth(700, win(false, 248)))).toBe("narrow");
    expect(roomSize(tabWidth(700, win(true, 81)))).toBe("narrow");
  });

  test("the steps are her layout's container queries: 800 and below narrow, to 999 mid, 1000 and wider wide", () => {
    expect([800, 801, 999, 1000].map(roomSize)).toEqual(["narrow", "mid", "mid", "wide"]);
    const css = readFileSync(join(import.meta.dir, "../layout.css"), "utf8");
    const steps = [...css.matchAll(/@container alpha-scene \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    expect(steps).toContain(WIDE_MIN_PX - 1);
    expect(steps).toContain(NARROW_MAX_PX);
    // The wide room's closer step stays inside the wide room.
    expect(steps.filter((n) => n >= WIDE_MIN_PX).every((n) => n > WIDE_MIN_PX)).toBe(true);
  });
});

describe("where her controls start", () => {
  test("beside the sidebar, open or folded to its rail, the window's own buttons don't reach her tab: her own margin only", () => {
    expect(safeLeft(win(false, 248))).toBe(0);
    expect(safeLeft(win(true, 81))).toBe(0);
    expect(controlsInset(win(false, 248))).toBe(EDGE_PX);
    expect(controlsInset(win(true, 81))).toBe(EDGE_PX);
    expect(controlsInset(undefined)).toBe(EDGE_PX);
  });

  test("with nothing (or something narrower than the buttons) beside her tab, her controls start clear of them", () => {
    expect(safeLeft(win(false, 0))).toBe(80);
    expect(controlsInset(win(false, 0))).toBe(EDGE_PX + 80);
    expect(controlsInset(win(true, 50))).toBe(EDGE_PX + 30);
    // A system that draws its buttons at the other end reaches nothing at the left.
    expect(controlsInset(win(false, 0, 0))).toBe(EDGE_PX);
  });
});
