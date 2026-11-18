// The list of rows that run elsewhere (elsewhere.ts) names rows, never numbers: every entry is a row of the table, and a row
// that has a unit of shards.ts is never also listed as running elsewhere.
import { describe, expect, test } from "bun:test";
import { PARTS_ELSEWHERE, ROWS_ELSEWHERE } from "./elsewhere";
import { FULL_STEPS } from "./steps";
import { UI_STEPS } from "./ui-steps";
import { unitOf, units } from "./shards";

describe("rows that run elsewhere", () => {
  test("every entry names a row of the table", () => {
    for (const name of ROWS_ELSEWHERE.keys()) expect(FULL_STEPS).toContain(name);
  });

  test("no row that still has a unit is also listed as elsewhere, and a row elsewhere is in no unit", () => {
    for (const name of ROWS_ELSEWHERE.keys()) expect(unitOf(name)).toBeUndefined();
    for (const u of units()) for (const r of u.rows) expect(ROWS_ELSEWHERE.has(r)).toBe(false);
  });

  test("the window rows that draw the avatar plugin's figure and the general point messages run in window-2 (they were marked elsewhere by number, wrongly)", () => {
    for (const start of ["a plugin's point carries messages and files", "a home made by an earlier MOSS with the person's own models", "a third-party renderer for the avatar plugin", "the figure reacts", "a bot's question card (AskUserQuestion)"]) {
      const rows = UI_STEPS.filter((s) => s.startsWith(start));
      expect(rows).toHaveLength(1);
      expect(unitOf(`window: ${rows[0]}`)).toBe("window-2");
    }
  });

  test("a part elsewhere names a unit that exists", () => {
    const ids = units().map((u) => u.id as string);
    for (const p of PARTS_ELSEWHERE) expect(ids).toContain(p.unit);
  });
});
