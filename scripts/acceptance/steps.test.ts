import { UI_STEPS } from "./ui-steps";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_STEP, COLD_START_STEP, FULL_STEPS, IDLE_STEP, OUTSIDE_STEP, REOPEN_STEPS, SHELL_STEP, STAGE_STEP, UPGRADE_STEPS, finishTable, parseOnlyUi, stepNumber, uiRowNumbers, type Row } from "./steps";

const run = readFileSync(join(import.meta.dir, "run.ts"), "utf8");
/** Every `stepNo("<prefix>")` run.ts looks a step up by. */
const prefixes = [...run.matchAll(/stepNo\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);

describe("the acceptance table: every row gets exactly one result", () => {
  test("no two steps share a name, so a lookup by name lands on one row", () => {
    for (const steps of [FULL_STEPS, UPGRADE_STEPS]) expect(new Set(steps).size).toBe(steps.length);
  });

  test("the cold start takes its own row, not the last one: the idle row after it keeps its own (try 14b's table)", () => {
    const cold = stepNumber(FULL_STEPS, COLD_START_STEP);
    const idle = stepNumber(FULL_STEPS, IDLE_STEP);
    expect(cold).toBe(FULL_STEPS.indexOf(COLD_START_STEP) + 1);
    expect(idle).toBe(FULL_STEPS.length);
    expect(cold).not.toBe(idle);
  });

  test("run.ts never numbers a step by the table's length", () => {
    expect(run).not.toMatch(/record\(\s*(TOTAL|STEPS\.length)\s*,/);
    expect(run.match(/(?<![A-Z_])STEPS\.length/g) ?? []).toHaveLength(1); // `const TOTAL = STEPS.length` alone
    expect(run).not.toMatch(/const n = TOTAL\b/);
  });

  test("each prefix run.ts looks up names exactly one step of a table", () => {
    expect(prefixes.length).toBeGreaterThan(5);
    for (const prefix of prefixes) {
      const counts = [FULL_STEPS, UPGRADE_STEPS].map((steps) => steps.filter((s) => s.startsWith(prefix)).length);
      expect({ prefix, counts: counts.some((c) => c === 1) && counts.every((c) => c <= 1) }).toEqual({ prefix, counts: true });
    }
  });

  test("the full run's named steps all land on different rows", () => {
    const names = [SHELL_STEP, OUTSIDE_STEP, STAGE_STEP, AGENT_STEP, COLD_START_STEP, IDLE_STEP, ...REOPEN_STEPS.map((s) => s.name)];
    const rows = names.map((name) => stepNumber(FULL_STEPS, name));
    expect(new Set(rows).size).toBe(names.length);
    for (const [i, n] of rows.entries()) expect(FULL_STEPS[n - 1]).toBe(names[i]!);
  });

  test("finishTable: one row per step, in order; a step nothing recorded reads not reached", () => {
    const recorded: Row[] = [{ n: 3, name: FULL_STEPS[2]!, status: "PASS", detail: "ok" }, { n: 1, name: FULL_STEPS[0]!, status: "FAIL", detail: "no" }];
    const table = finishTable(recorded, FULL_STEPS);
    expect(table.map((r) => r.n)).toEqual(FULL_STEPS.map((_, i) => i + 1));
    expect(table.map((r) => r.name)).toEqual([...FULL_STEPS]);
    expect(table[0]!.status).toBe("FAIL");
    expect(table[1]).toEqual({ n: 2, name: FULL_STEPS[1]!, status: "BLOCKED", detail: "not reached" });
    expect(table[2]!.status).toBe("PASS");
  });

  test("finishTable: a step recorded twice reads FAIL and names both results (the clash shows, nothing is overwritten)", () => {
    const last = FULL_STEPS.length;
    const recorded: Row[] = [
      { n: last, name: FULL_STEPS[last - 1]!, status: "PASS", detail: "cold start filled in 3 s" },
      { n: last, name: FULL_STEPS[last - 1]!, status: "PASS", detail: "idle 0.1%" },
    ];
    const row = finishTable(recorded, FULL_STEPS).find((r) => r.n === last)!;
    expect(row.status).toBe("FAIL");
    expect(row.detail).toContain("recorded 2 times");
    expect(row.detail).toContain("cold start filled in 3 s");
    expect(row.detail).toContain("idle 0.1%");
  });

  test("finishTable: a cold-start-only run's table is the cold-start row alone", () => {
    const cold = stepNumber(FULL_STEPS, COLD_START_STEP);
    const table = finishTable([{ n: cold, name: COLD_START_STEP, status: "PASS", detail: "3 cold start(s)" }, { n: 1, name: FULL_STEPS[0]!, status: "PASS", detail: "x" }], FULL_STEPS, cold);
    expect(table).toEqual([{ n: cold, name: COLD_START_STEP, status: "PASS", detail: "3 cold start(s)" }]);
    expect(finishTable([], FULL_STEPS, cold)).toEqual([{ n: cold, name: COLD_START_STEP, status: "BLOCKED", detail: "not reached" }]);
  });
});

describe("--only-ui row selection", () => {
  test("defaults to the Plugins page's step, takes a list, refuses what isn't a step", () => {
    expect(parseOnlyUi(undefined)).toEqual([12]);
    expect(parseOnlyUi("--verbose")).toEqual([12]);
    expect(parseOnlyUi("13,12,12")).toEqual([12, 13]);
    expect(() => parseOnlyUi("999")).toThrow();
    expect(() => parseOnlyUi("x")).toThrow();
  });
  test("its rows are the window steps' own rows, and the table keeps only them", () => {
    expect(uiRowNumbers([12])).toEqual([20]);
    expect(FULL_STEPS[19]).toBe(`window: ${UI_STEPS[12]}`);
    const table = finishTable([{ n: 20, name: "x", status: "PASS", detail: "ok" }], FULL_STEPS, uiRowNumbers([12, 13]));
    expect(table.map((r) => [r.n, r.status])).toEqual([[20, "PASS"], [21, "BLOCKED"]]);
  });
});
