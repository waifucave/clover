// The turns clause's own checks: spans read from a fixture's lines, and two that cross found.
import { expect, test } from "bun:test";
import { overlaps, spansOf } from "./turns-step";

test("spans come from start/end pairs (a held line is not one); a span that begins before the one before it ended is found", () => {
  const a = spansOf("a", ["start 100", "end 400", "held 900", "start 1000", "end 1300"]);
  expect(a).toEqual([{ who: "a", start: 100, end: 400 }, { who: "a", start: 1000, end: 1300 }]);
  const b = spansOf("b", ["start 400", "end 700"]);
  expect(overlaps([...a, ...b])).toEqual([]);
  expect(overlaps([...a, { who: "b", start: 350, end: 600 }])).toEqual(["b began at 350 before a's span ended at 400"]);
});
