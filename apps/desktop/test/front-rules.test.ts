import { describe, expect, test } from "bun:test";
import { mainWindowFront, surfaceShown, type MainWindowState } from "../src/main/front-rules";

const FRONT: MainWindowState = { exists: true, visible: true, minimized: false, focused: true };

describe("the pill steps aside while Clover's own window is in front", () => {
  test("window focused and visible: the pill is hidden, the island stays", () => {
    expect(mainWindowFront(FRONT)).toBe(true);
    expect(surfaceShown("clover/pill", true, FRONT)).toBe(false);
    expect(surfaceShown("clover/island", true, FRONT)).toBe(true);
  });
  test("each way the window stops being in front brings the pill back", () => {
    expect(surfaceShown("clover/pill", true, { ...FRONT, focused: false })).toBe(true); // another app (or window) in front
    expect(surfaceShown("clover/pill", true, { ...FRONT, minimized: true })).toBe(true);
    expect(surfaceShown("clover/pill", true, { ...FRONT, visible: false })).toBe(true); // hidden or closed to the tray
    expect(surfaceShown("clover/pill", true, { exists: false, visible: false, minimized: false, focused: false })).toBe(true); // closed
  });
  test("a surface that asked to be hidden stays hidden whatever is in front", () => {
    expect(surfaceShown("clover/pill", false, { ...FRONT, focused: false })).toBe(false);
    expect(surfaceShown("clover/island", false, FRONT)).toBe(false);
  });
  test("another plugin's surface is not touched", () => {
    expect(surfaceShown("someone/else", true, FRONT)).toBe(true);
  });
});

describe("the pill put away", () => {
  test("a pill the user put away stays away whatever the part asks for, and nothing else is touched", () => {
    expect(surfaceShown("clover/pill", true, { exists: true, visible: false, minimized: false, focused: false }, true)).toBe(false);
    expect(surfaceShown("clover/pill", true, { exists: true, visible: false, minimized: false, focused: false }, false)).toBe(true);
    expect(surfaceShown("clover/island", true, { exists: true, visible: false, minimized: false, focused: false }, true)).toBe(true);
  });
});
