import { expect, test } from "bun:test";
import { overlayStandsDown, surfacesReport } from "../src/main/host-stacking";

test("R12: while any card is pending every third-party on-screen part stands down, floating or not; the tree's never does", () => {
  expect(overlayStandsDown({ pluginId: "acceptance-hold" }, true)).toBe(true);
  expect(overlayStandsDown({ pluginId: "acceptance-tab" }, true)).toBe(true);
  expect(overlayStandsDown({ pluginId: "acceptance-hold" }, false)).toBe(false);
  expect(overlayStandsDown({ pluginId: "moss" }, true)).toBe(false);
});

test("the surfaces report lists the visible ones only, bounded", () => {
  const wins = Array.from({ length: 70 }, (_, i) => ({ id: `s${i}`, visible: i !== 0, bounds: { x: i, y: 0, width: 10, height: 5 } }));
  const r = surfacesReport(wins);
  expect(r.length).toBe(64);
  expect(r[0]).toEqual({ id: "s1", x: 1, y: 0, width: 10, height: 5 });
});
