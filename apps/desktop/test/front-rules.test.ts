import { describe, expect, test } from "bun:test";
import { appIsRegular, mainWindowFront, afterTap, afterTray, surfaceShown, type FrontRule, type MainWindowState, type PutAway } from "../src/main/front-rules";

// What the two bundled surfaces' manifests say: the pill steps aside, the island stays; another plugin's surface says its own.
const PILL: FrontRule = { stepsAside: true };
const ISLAND: FrontRule = { stepsAside: false };

const FRONT: MainWindowState = { exists: true, visible: true, minimized: false, focused: true };

describe("the pill steps aside while MOSS's own window is in front", () => {
  test("window focused and visible: the pill is hidden, the island stays", () => {
    expect(mainWindowFront(FRONT)).toBe(true);
    expect(surfaceShown(PILL, true, FRONT)).toBe(false);
    expect(surfaceShown(ISLAND, true, FRONT)).toBe(true);
  });
  test("each way the window stops being in front brings the pill back", () => {
    expect(surfaceShown(PILL, true, { ...FRONT, focused: false })).toBe(true); // another app (or window) in front
    expect(surfaceShown(PILL, true, { ...FRONT, minimized: true })).toBe(true);
    expect(surfaceShown(PILL, true, { ...FRONT, visible: false })).toBe(true); // hidden or closed to the tray
    expect(surfaceShown(PILL, true, { exists: false, visible: false, minimized: false, focused: false })).toBe(true); // closed
  });
  test("a surface that asked to be hidden stays hidden whatever is in front", () => {
    expect(surfaceShown(PILL, false, { ...FRONT, focused: false })).toBe(false);
    expect(surfaceShown(ISLAND, false, FRONT)).toBe(false);
  });
  test("a surface that doesn't say steps-aside is not touched", () => {
    expect(surfaceShown({ stepsAside: false }, true, FRONT)).toBe(true);
  });
});

describe("lane RT: a surface never steps aside while the router has placed a card on it", () => {
  test("a steps-aside surface holding a placed card stays over the focused window; without one it steps aside", () => {
    const front = { exists: true, visible: true, minimized: false, focused: true };
    expect(surfaceShown({ stepsAside: true, holdsPlacedCard: true }, true, front)).toBe(true);
    expect(surfaceShown({ stepsAside: true, holdsPlacedCard: false }, true, front)).toBe(false);
    // Visible but not focused moves nothing.
    expect(surfaceShown({ stepsAside: true }, true, { ...front, focused: false })).toBe(true);
  });
});

describe("the pill: put away, summoned, stepping aside", () => {
  const IN_FRONT: MainWindowState = { exists: true, visible: true, minimized: false, focused: true };
  const BEHIND: MainWindowState = { exists: true, visible: true, minimized: false, focused: false };
  const shown = (mode: PutAway, main: MainWindowState, wants = true) => surfaceShown(PILL, wants, main, mode);

  test("auto: the pill shows when its part asks and steps aside for the window in front; the island never does", () => {
    expect(shown("auto", BEHIND)).toBe(true);
    expect(shown("auto", IN_FRONT)).toBe(false);
    expect(shown("auto", BEHIND, false)).toBe(false);
    expect(surfaceShown(ISLAND, true, IN_FRONT)).toBe(true);
    expect(surfaceShown(ISLAND, true, IN_FRONT, "hidden")).toBe(false); // a surface put away is away, whoever it is
  });
  test("hidden stays away whatever the part asks; summoned shows over the window in front, while its part asks", () => {
    expect(shown("hidden", BEHIND)).toBe(false);
    expect(shown("summoned", IN_FRONT)).toBe(true);
    expect(shown("summoned", BEHIND)).toBe(true);
    expect(shown("summoned", IN_FRONT, false)).toBe(false);
  });
  test("a tap with MOSS's window in front summons the pill over it; the next tap puts it away", () => {
    const first = afterTap("auto", PILL, true, IN_FRONT);
    expect(first).toBe("summoned");
    expect(shown(first, IN_FRONT)).toBe(true);
    const second = afterTap(first, PILL, true, IN_FRONT);
    expect(second).toBe("hidden");
    expect(shown(second, IN_FRONT)).toBe(false);
    expect(afterTap(second, PILL, true, IN_FRONT)).toBe("summoned");
  });
  test("a tap with another app in front: a pill on screen is put away, a put-away pill is summoned", () => {
    expect(afterTap("auto", PILL, true, BEHIND)).toBe("hidden");
    expect(afterTap("hidden", PILL, true, BEHIND)).toBe("summoned");
    expect(afterTap("summoned", PILL, true, BEHIND)).toBe("hidden");
  });
  test("a pill whose part has nothing to show is not on screen, so a tap summons it", () => {
    expect(afterTap("auto", PILL, false, BEHIND)).toBe("summoned");
  });
  test("the tray item: hide from anywhere but hidden, show from hidden back to the usual behaviour (it steps aside again)", () => {
    expect(afterTray("auto")).toBe("hidden");
    expect(afterTray("summoned")).toBe("hidden");
    expect(afterTray("hidden")).toBe("auto");
    expect(shown(afterTray("hidden"), IN_FRONT)).toBe(false);
    expect(shown(afterTray("hidden"), BEHIND)).toBe(true);
  });
});

describe("a press on an overlay surface leaves the app and its main window alone", () => {
  test("the Dock icon (regular) follows ordinary windows only: the island and the pill showing keep the app an accessory", () => {
    expect(appIsRegular([{ visible: true, surface: true }, { visible: true, surface: true }])).toBe(false);
    expect(appIsRegular([{ visible: false, surface: false }, { visible: true, surface: true }])).toBe(false);
    expect(appIsRegular([{ visible: true, surface: false }, { visible: true, surface: true }])).toBe(true);
    expect(appIsRegular([])).toBe(false);
  });
  test("the surfaces' own visibility never reads the main window's: a surface press changes no window's state", () => {
    const behind: MainWindowState = { exists: true, visible: true, minimized: false, focused: false };
    for (const mode of ["auto", "summoned", "hidden"] as const) {
      expect(mainWindowFront(behind)).toBe(false);
      void surfaceShown(ISLAND, true, behind, mode);
      void surfaceShown(PILL, true, behind, mode);
      expect(mainWindowFront(behind)).toBe(false);
    }
  });
});
