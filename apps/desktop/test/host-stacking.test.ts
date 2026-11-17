import { expect, test } from "bun:test";
import { overlayStandsDown, surfacesReport } from "../src/main/host-stacking";

test("R12: while a card is pending here a plugin's overlay stands down; the tree's surfaces and plain parts never do", () => {
  const overlay = { pluginId: "acceptance-hold", floats: true };
  expect(overlayStandsDown(overlay, true)).toBe(true);
  expect(overlayStandsDown(overlay, false)).toBe(false);
  expect(overlayStandsDown({ pluginId: "moss", floats: true }, true)).toBe(false);
  expect(overlayStandsDown({ pluginId: "acceptance-tab", floats: false }, true)).toBe(false);
});

test("the surfaces report lists the visible ones only, bounded", () => {
  const wins = Array.from({ length: 70 }, (_, i) => ({ id: `s${i}`, visible: i !== 0, bounds: { x: i, y: 0, width: 10, height: 5 } }));
  const r = surfacesReport(wins);
  expect(r.length).toBe(64);
  expect(r[0]).toEqual({ id: "s1", x: 1, y: 0, width: 10, height: 5 });
});
