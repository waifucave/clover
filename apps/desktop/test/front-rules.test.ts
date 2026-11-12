import { describe, expect, test } from "bun:test";
import { mainWindowFront, pillAfterTap, pillAfterTray, surfaceShown, type MainWindowState, type PillMode } from "../src/main/front-rules";

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

describe("the pill: put away, summoned, stepping aside", () => {
  const IN_FRONT: MainWindowState = { exists: true, visible: true, minimized: false, focused: true };
  const BEHIND: MainWindowState = { exists: true, visible: true, minimized: false, focused: false };
  const shown = (mode: PillMode, main: MainWindowState, wants = true) => surfaceShown("clover/pill", wants, main, mode);

  test("auto: the pill shows when its part asks and steps aside for the window in front; the island never does", () => {
    expect(shown("auto", BEHIND)).toBe(true);
    expect(shown("auto", IN_FRONT)).toBe(false);
    expect(shown("auto", BEHIND, false)).toBe(false);
    expect(surfaceShown("clover/island", true, IN_FRONT, "hidden")).toBe(true);
  });
  test("hidden stays away whatever the part asks; summoned shows over the window in front, while its part asks", () => {
    expect(shown("hidden", BEHIND)).toBe(false);
    expect(shown("summoned", IN_FRONT)).toBe(true);
    expect(shown("summoned", BEHIND)).toBe(true);
    expect(shown("summoned", IN_FRONT, false)).toBe(false);
  });
  test("a tap with Clover's window in front summons the pill over it; the next tap puts it away", () => {
    const first = pillAfterTap("auto", true, IN_FRONT);
    expect(first).toBe("summoned");
    expect(shown(first, IN_FRONT)).toBe(true);
    const second = pillAfterTap(first, true, IN_FRONT);
    expect(second).toBe("hidden");
    expect(shown(second, IN_FRONT)).toBe(false);
    expect(pillAfterTap(second, true, IN_FRONT)).toBe("summoned");
  });
  test("a tap with another app in front: a pill on screen is put away, a put-away pill is summoned", () => {
    expect(pillAfterTap("auto", true, BEHIND)).toBe("hidden");
    expect(pillAfterTap("hidden", true, BEHIND)).toBe("summoned");
    expect(pillAfterTap("summoned", true, BEHIND)).toBe("hidden");
  });
  test("a pill whose part has nothing to show is not on screen, so a tap summons it", () => {
    expect(pillAfterTap("auto", false, BEHIND)).toBe("summoned");
  });
  test("the tray item: hide from anywhere but hidden, show from hidden back to the usual behaviour (it steps aside again)", () => {
    expect(pillAfterTray("auto")).toBe("hidden");
    expect(pillAfterTray("summoned")).toBe("hidden");
    expect(pillAfterTray("hidden")).toBe("auto");
    expect(shown(pillAfterTray("hidden"), IN_FRONT)).toBe(false);
    expect(shown(pillAfterTray("hidden"), BEHIND)).toBe(true);
  });
});
