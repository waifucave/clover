// The list of rows that run elsewhere (elsewhere.ts) names rows, never numbers: every entry is a row of the table, and a row
// that has a unit of shards.ts is never also listed as running elsewhere.
import { describe, expect, test } from "bun:test";
import { PARTS_ELSEWHERE, ROWS_ELSEWHERE } from "./elsewhere";
import { FULL_STEPS } from "./steps";
import { UI_STEPS } from "./ui-steps";
import { readFileSync } from "node:fs";
import { unitOf, units, windowIndexes, windowStepsToRun } from "./shards";

describe("rows that run elsewhere", () => {
  test("every entry names a row of the table", () => {
    for (const name of ROWS_ELSEWHERE.keys()) expect(FULL_STEPS).toContain(name);
  });

  test("no row that still has a unit is also listed as elsewhere, and a row elsewhere is in no unit", () => {
    for (const name of ROWS_ELSEWHERE.keys()) expect(unitOf(name)).toBeUndefined();
    for (const u of units()) for (const r of u.rows) expect(ROWS_ELSEWHERE.has(r)).toBe(false);
  });

  test("the window rows that draw the avatar plugin's figure and the general point messages run in window-2 (they were marked elsewhere by number, wrongly)", () => {
    for (const start of ["a plugin's point carries messages and files", "a home made by an earlier MOSS with the person's own models", "a third-party renderer for the avatar plugin", "the figure reacts"]) {
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

describe("a step with no table row never runs", () => {
  const all = UI_STEPS.map((_, i) => i);
  const dead = all.filter((i) => unitOf(`window: ${UI_STEPS[i]}`) === undefined);

  test("the steps in no unit's table are exactly the rows listed elsewhere, and there are some", () => {
    expect(dead.length).toBeGreaterThan(0);
    for (const i of all) expect([i, unitOf(`window: ${UI_STEPS[i]}`) === undefined]).toEqual([i, ROWS_ELSEWHERE.has(`window: ${UI_STEPS[i]}`)]);
  });

  test("a window unit's run, a run of every unit and a run of all the steps leave out every step whose row is elsewhere or in no table", () => {
    for (const asked of [undefined, new Set(all), ...(["window-1", "window-2", "window-3"] as const).map((id) => new Set(windowIndexes(id)!))]) {
      const run = windowStepsToRun(asked) ?? new Set(all);
      for (const i of dead) expect([i, run.has(i)]).toEqual([i, false]);
      for (const i of all) if (!dead.includes(i) && (asked === undefined || asked.has(i))) expect([i, run.has(i)]).toEqual([i, true]);
    }
  });

  test("a step marked retired has no body in ui-steps.ts (the run's step runner would run it)", () => {
    const source = readFileSync(new URL("./ui-steps.ts", import.meta.url), "utf8");
    const bodies = new Set([...source.matchAll(/^\s*await step\((\d+),/gm)].map((m) => Number(m[1])));
    for (const i of all) {
      if (ROWS_ELSEWHERE.get(`window: ${UI_STEPS[i]}`)?.owner === "retired") expect([i, bodies.has(i)]).toEqual([i, false]);
    }
    // And no body without a row: every step body is a step of the list.
    for (const n of bodies) expect(n).toBeLessThan(UI_STEPS.length);
  });
});
