// The camera housing (spec §5.5, lane G's ask): where it is from NSScreen's areas, and the screen add-on itself on a
// Mac where the build made it (it reads the displays and nothing else; loading it shows nothing on the screen).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { housingFor, housingOf, loadScreens, type NativeScreen } from "../src/main/housing";

const NOTCHED: NativeScreen = { id: 1, frame: { x: 0, y: 0, width: 1512, height: 982 }, safeTop: 32, left: { x: 0, y: 950, width: 663, height: 32 }, right: { x: 848, y: 950, width: 664, height: 32 } };

describe("the housing", () => {
  test("between the two auxiliary areas, as tall as the safe area's top, in the display's own coordinates", () => {
    expect(housingOf(NOTCHED)).toEqual({ x: 663, y: 0, width: 185, height: 32 });
    // A display placed to the right of the main one: still its own coordinates.
    expect(housingOf({ ...NOTCHED, frame: { ...NOTCHED.frame, x: 1512 }, left: { ...NOTCHED.left!, x: 1512 }, right: { ...NOTCHED.right!, x: 2360 } })).toEqual({ x: 663, y: 0, width: 185, height: 32 });
  });

  test("none without the areas, a safe area, or room between them; none for an unknown display or without the add-on", () => {
    expect(housingOf({ id: 2, frame: NOTCHED.frame, safeTop: 0 })).toBeNull();
    expect(housingOf({ ...NOTCHED, safeTop: 0 })).toBeNull();
    expect(housingOf({ ...NOTCHED, right: { ...NOTCHED.right!, x: 600 } })).toBeNull();
    expect(housingFor(9, () => [NOTCHED])).toBeNull();
    expect(housingFor(1, () => [NOTCHED])).toEqual({ x: 663, y: 0, width: 185, height: 32 });
    expect(housingFor(1, undefined)).toBeNull();
    expect(housingFor(1, () => { throw new Error("gone"); })).toBeNull();
    expect(loadScreens("/nowhere/screen.node", () => {}, "linux")).toBeUndefined();
  });

  const built = join(import.meta.dir, "..", "out", "main", "native", "screen.node");
  test.if(process.platform === "darwin" && existsSync(built))("the add-on reads each display: its id, frame and safe area, and a housing's areas when it has one", () => {
    const screens = loadScreens(built, (l) => { throw new Error(l); })!;
    const list = screens();
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(s.id).toBeGreaterThan(0);
      expect(s.frame.width).toBeGreaterThan(0);
      expect(s.safeTop).toBeGreaterThanOrEqual(0);
      const h = housingOf(s);
      if (h !== null) {
        expect(h.width).toBeGreaterThan(0);
        expect(h.x + h.width).toBeLessThanOrEqual(s.frame.width);
      }
    }
  });
});
