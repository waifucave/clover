// The island's fold hands key back to the window it took key from, in order, and never focuses anything else.
import { expect, test } from "bun:test";
import { FocusHandBack, HAND_BACK_WINDOW_MS } from "../src/main/focus-handback";

const MAIN = 1;
const ISLAND = 7;

function tracker() {
  let now = 1_000;
  const t = new FocusHandBack(() => now);
  return { t, tick: (ms: number) => { now += ms; } };
}

test("a press on the island while the window was key, then the fold: key goes back to the window", () => {
  const { t, tick } = tracker();
  t.focused(MAIN, false);
  // The press: the panel becomes key (the window resigns first, as AppKit orders it).
  t.blurred(MAIN, false);
  tick(5);
  t.focused(ISLAND, true);
  tick(800);
  expect(t.hiding(ISLAND, true)).toBe(MAIN);
  // Once: a second fold hands nothing back.
  expect(t.hiding(ISLAND, true)).toBeUndefined();
});

test("nothing is handed back that the person did not have in front", () => {
  // The person was in another app (no window of this program key): the panel took key from nothing.
  const a = tracker();
  a.t.focused(ISLAND, true);
  expect(a.t.hiding(ISLAND, true)).toBeUndefined();
  // The window had lost key long before (the person went to another app, then pressed the panel).
  const b = tracker();
  b.t.focused(MAIN, false);
  b.t.blurred(MAIN, false);
  b.tick(HAND_BACK_WINDOW_MS + 1);
  b.t.focused(ISLAND, true);
  expect(b.t.hiding(ISLAND, true)).toBeUndefined();
  // The island is no longer key when it hides (the person clicked back into the window, or elsewhere): nothing to do.
  const c = tracker();
  c.t.focused(MAIN, false);
  c.t.blurred(MAIN, false);
  c.t.focused(ISLAND, true);
  expect(c.t.hiding(ISLAND, false)).toBeUndefined();
  // The window closed in between: no window to focus.
  const d = tracker();
  d.t.focused(MAIN, false);
  d.t.blurred(MAIN, false);
  d.t.focused(ISLAND, true);
  d.t.closed(MAIN);
  expect(d.t.hiding(ISLAND, true)).toBeUndefined();
});

test("a press focuses nothing by itself: only the fold hands back, and the window becoming key again clears it", () => {
  const { t } = tracker();
  t.focused(MAIN, false);
  t.blurred(MAIN, false);
  t.focused(ISLAND, true);
  // The person clicks back into the window before the fold: the island owes it nothing.
  t.focused(MAIN, false);
  expect(t.hiding(ISLAND, true)).toBeUndefined();
  // Another surface hiding never hands back a key it did not take.
  t.blurred(MAIN, false);
  t.focused(ISLAND, true);
  expect(t.hiding(8, true)).toBeUndefined();
});
