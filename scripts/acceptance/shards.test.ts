// The sharded acceptance run's split and merge (shards.ts): every row in exactly one unit, the rows that share a home
// and an order kept together in one unit, the measuring units alone after the parallel phase, the merged table in row
// order with each row's shard and seconds, and one shard's red (or crash) never hiding another's result.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLD_START_STEP, FULL_STEPS, IDLE_STEP, REOPEN_STEPS, STAGE_STEP, finishTable, stepNumber } from "./steps";
import { ROWS_ELSEWHERE } from "./elsewhere";
import { UI_STEPS } from "./ui-steps";
import { TAB_FLASH_STEP } from "./tab-flash-step";
import { WORKSHOP_STEP } from "./workshop-step";
import { EXAMPLE_NOTES_STEP, EXAMPLE_WEATHER_STEP } from "./example-steps";
import { MOSS_STEPS } from "./moss-step";
import { MAIN_PARTS, expandUnitIds, homePlan, mergeShards, planShards, serialUnits, slowest, unitOf, units, windowIndexes, type TimedRow } from "./shards";

const row = (name: string, status: TimedRow["status"] = "PASS", seconds = 1): TimedRow => ({ n: stepNumber(FULL_STEPS, name), name, status, detail: status === "PASS" ? "ok" : "red", seconds });

describe("the split", () => {
  test("every row of the table is in exactly one unit, but a row another lane runs, which is in none; the chain has the rest", () => {
    const all = units();
    const named = all.flatMap((u) => u.rows);
    expect(new Set(named).size).toBe(named.length);
    expect([...named].sort()).toEqual(FULL_STEPS.filter((s) => !ROWS_ELSEWHERE.has(s)).sort());
    for (const s of FULL_STEPS) expect([s.slice(0, 60), unitOf(s) === undefined]).toEqual([s.slice(0, 60), ROWS_ELSEWHERE.has(s)]);
    // Each names a row of the table, and a full table reads it BLOCKED with who runs it.
    for (const name of ROWS_ELSEWHERE.keys()) expect(FULL_STEPS as readonly string[]).toContain(name);
    const table = finishTable([], FULL_STEPS);
    for (const name of ROWS_ELSEWHERE.keys()) expect(table.find((r) => r.name === name)).toMatchObject({ status: "BLOCKED", detail: expect.stringMatching(/^runs elsewhere \((retired|lane MA's moss unit|lane MC2)\): /) });
  });

  test("the rows that share a home and an order stay together: main's chain, the reopen steps in order, the examples in order", () => {
    const main = units().find((u) => u.id === "chain")!.rows;
    // The first start, the key, the turns and the restart are the chain's, in the table's order; the window's steps are not.
    for (const s of [FULL_STEPS[0], FULL_STEPS[1], FULL_STEPS[2], FULL_STEPS[3], FULL_STEPS[4], FULL_STEPS[5]]) expect(main).toContain(s);
    for (const u of UI_STEPS) expect(main).not.toContain(`window: ${u}`);
    expect(main).toEqual(FULL_STEPS.filter((s) => main.includes(s)));
    expect(units().find((u) => u.id === "reopen")!.rows).toEqual(REOPEN_STEPS.map((s) => s.name));
    // The reopen shard installs step 4's plugin first (its mid-tool-call step calls the Echo tool).
    expect(readFileSync(join(import.meta.dir, "run.ts"), "utf8")).toContain("try { await installEcho(c); }");
    // The notes example's row is the MOSS unit's (its child bot): weather alone here.
    expect(units().find((u) => u.id === "examples")!.rows).toEqual([EXAMPLE_WEATHER_STEP]);
    expect(ROWS_ELSEWHERE.has(EXAMPLE_NOTES_STEP)).toBe(true);
  });

  test("`main` names the chain and the window's three units; the window's steps are dealt out once each, in order", () => {
    expect(MAIN_PARTS).toEqual(["chain", "window-1", "window-2", "window-3"]);
    expect(expandUnitIds(["main"])).toEqual(["chain", "window-1", "window-2", "window-3"]);
    expect(expandUnitIds(["cards", "main", "chain"])).toEqual(["cards", "chain", "window-1", "window-2", "window-3"]);
    expect(MAIN_PARTS.flatMap((id) => windowIndexes(id) ?? [])).toEqual(UI_STEPS.map((_, i) => i));
    expect(windowIndexes("chain")).toBeUndefined();
    for (const id of ["window-1", "window-2", "window-3"] as const) expect(units().find((u) => u.id === id)!.rows).toEqual(windowIndexes(id)!.map((i) => `window: ${UI_STEPS[i]}`).filter((r) => !ROWS_ELSEWHERE.has(r)));
  });

  test("the rows that measure run alone after the parallel phase: the cold start, idle (the stage and the tab flash run elsewhere)", () => {
    // lane HS: and the host's row, alone too (its own daemon starts the host, so it shares no shard's home).
    expect(serialUnits()).toEqual(["cold", "idle", "host", "browser-host", "surface-copy-host"]);
    for (const s of [COLD_START_STEP, IDLE_STEP]) expect(units().find((u) => u.rows.includes(s))!.phase).toBe("serial");
    for (const s of [STAGE_STEP, TAB_FLASH_STEP]) expect(unitOf(s)).toBeUndefined();
    for (const n of [1, 2, 3, 4]) expect(planShards(n).flat()).not.toEqual(expect.arrayContaining(["stage"]));
  });

  test("N shards: each parallel unit in one shard, the chain first in its own, the load spread", () => {
    expect(planShards(1)).toEqual([["chain", "window-1", "window-2", "window-3", "examples", "bundled-tools", "cards", "workshop", "reopen", "arrivals", "addons", "archive", "acp", "builder-examples", "workshop-points", "release", "plugin-app", "browser", "models", "moss"]]);
    for (const n of [2, 3, 4, 8]) {
      const plan = planShards(n);
      expect(plan.length).toBeLessThanOrEqual(n);
      expect(plan.flat().sort()).toEqual(["acp", "addons", "archive", "arrivals", "browser", "builder-examples", "bundled-tools", "cards", "chain", "examples", "models", "moss", "plugin-app", "release", "reopen", "window-1", "window-2", "window-3", "workshop", "workshop-points"]);
      // The chain, the long pole, alone in the first from 2 shards (anything beside it lengthens the run).
      expect(plan[0]).toEqual(["chain"]);
    }
    // With 2 shards the chain runs alone and the rest share the other.
    expect(planShards(2)).toEqual([["chain"], ["window-1", "window-2", "window-3", "examples", "bundled-tools", "cards", "workshop", "reopen", "arrivals", "addons", "archive", "acp", "builder-examples", "workshop-points", "release", "plugin-app", "browser", "models", "moss"]]);
    expect(() => planShards(0)).toThrow();
  });

  test("the moss unit owns MOSS's rows, in their order, and none of them falls to the chain", () => {
    const moss = units().find((u) => u.id === "moss")!;
    expect(moss.rows).toEqual([...MOSS_STEPS]);
    expect(moss.phase).toBe("parallel");
    for (const name of MOSS_STEPS) expect(unitOf(name)).toBe("moss");
    // Alone it is its home's first daemon; beside other units it runs after them (run.ts unitsRun).
    const run = readFileSync(join(import.meta.dir, "run.ts"), "utf8");
    expect(run).toContain('if (allIds.length === 1 && allIds[0] === "moss") return mossRun(true);');
    expect(run).toContain('if (runs("moss"))');
  });

  test("the moss unit's rows are never scheduled into a home another unit uses", () => {
    const all = units();
    const ids = all.map((u) => u.id).filter((id) => id !== "moss");
    expect(all.find((u) => u.id === "moss")!.ownHome).toBe(true);
    // Alone, the run's home is its own; beside any other unit, or all of them (the full run's list), a run of its own.
    expect(homePlan(["moss"])).toEqual({ shared: ["moss"], ownRuns: [] });
    for (const other of ids) {
      expect(homePlan([other, "moss"])).toEqual({ shared: [other], ownRuns: ["moss"] });
      expect(homePlan(["moss", other]).shared).not.toContain("moss");
    }
    expect(homePlan(["main", "workshop", "plugin-app", "browser", "cards", "bundled-tools", "moss"]).ownRuns).toEqual(["moss"]);
    // Every shard plan: a shard holding moss and anything else runs moss as its own run (unitsRun uses homePlan).
    for (const n of [1, 2, 3, 4]) for (const shard of planShards(n)) if (shard.includes("moss") && shard.length > 1) expect(homePlan(shard).ownRuns).toEqual(["moss"]);
    // run.ts: moss's rows run on the run's home only when moss is the run's one unit; the full run and unitsRun hand it to
    // a run of its own (`--units moss`), never to the shared home's daemon.
    const run = readFileSync(join(import.meta.dir, "run.ts"), "utf8");
    expect(run).toContain("const plan = homePlan(allIds);");
    expect(run).toContain("await otherUnitsRun(app, plan.shared);");
    expect(run).toContain("for (const id of plan.ownRuns) await ownHomeRun(id);");
    expect(run).toContain('else await ownHomeRun("moss");');
    expect(run).toContain('"--units", id, "--rows-out", out');
    const calls = [...run.matchAll(/mossRun\((true|false)\)/g)].map((m) => m[0]);
    expect(calls).toEqual(["mossRun(true)", "mossRun(false)"]);
    // The one `mossRun(false)` left is a target with no MOSS bundle, where it only records the rows BLOCKED.
    expect(run).toContain('if (id === "moss" && target !== "source") return mossRun(false);');
  });

  test("run.ts runs a unit's rows only where the unit is its own, and every unit has a runner", () => {
    const run = readFileSync(join(import.meta.dir, "run.ts"), "utf8");
    for (const id of ["stage", "cold", "reopen", "idle"]) expect(run).toContain(`if (runs("${id}"))`);
    for (const id of ["examples", "bundled-tools", "cards", "workshop", "arrivals", "tab-flash", "cold", "reopen", "stage", "idle"]) expect(run).toContain(`"${id}"`);
    // The rows an app over Alpha's conversation drives (uiRowRunners) start that app when their unit runs alone: a unit
    // left out of the list runs nothing (the first --units arrivals run: "not reached").
    const windowed = run.match(/const windowed = ids\.filter\(\(id\) => (.*)\);/)?.[1] ?? "";
    for (const id of ["examples", "bundled-tools", "cards", "workshop", "arrivals", "addons", "archive", "acp", "builder-examples", "workshop-points", "tab-flash", "browser", "plugin-app"]) expect(windowed).toContain(`id === "${id}"`);
    // The appless rows run on the shard's daemon with no app, each its own clause.
    expect(run).toContain('if (ids.includes("models"))');
    // …answered over RPC only, as under their own --only-* (no app of the shard is up yet: the first 14f table's reds).
    const models = run.slice(run.indexOf('if (ids.includes("models"))'), run.indexOf('if (ids.includes("models"))') + 2000);
    expect(models).toContain("appless = true;");
    expect(models).toContain("appless = wasAppless;");
    expect(run).toContain('if (runs("models"))');
    expect(run).toContain("if (!runs(unitOf(name))) continue;");
  });
});

describe("the merge", () => {
  test("one table in row order, each row with its shard and seconds, whatever order the shards finished in", () => {
    const s2 = { shard: "s2", rows: [row(WORKSHOP_STEP, "PASS", 140), row(EXAMPLE_NOTES_STEP, "PASS", 60)] };
    const s1 = { shard: "s1", rows: FULL_STEPS.filter((s) => unitOf(s) === "chain").map((s) => row(s)) };
    const alone = { shard: "serial", rows: [row(IDLE_STEP, "PASS", 30)] };
    const merged = mergeShards([s2, alone, s1]);
    expect(merged.map((r) => r.n)).toEqual(FULL_STEPS.map((_, i) => i + 1));
    const w = merged.find((r) => r.name === WORKSHOP_STEP)!;
    expect({ shard: w.shard, seconds: w.seconds, status: w.status }).toEqual({ shard: "s2", seconds: 140, status: "PASS" });
    expect(merged.find((r) => r.name === IDLE_STEP)!.shard).toBe("serial");
  });

  test("a red in one shard doesn't hide another's result; a shard that crashed leaves its rows not reached", () => {
    const merged = mergeShards([
      { shard: "s1", rows: [row(FULL_STEPS[0]!, "FAIL")] },
      { shard: "s2", rows: [row(WORKSHOP_STEP, "PASS", 100)] },
      { shard: "s3", rows: [] },
    ]);
    expect(merged[0]).toMatchObject({ status: "FAIL", shard: "s1" });
    expect(merged.find((r) => r.name === WORKSHOP_STEP)).toMatchObject({ status: "PASS", shard: "s2" });
    expect(merged.find((r) => r.name === COLD_START_STEP)).toMatchObject({ status: "BLOCKED", detail: "not reached" });
  });

  test("a row two shards reported is a harness red naming both", () => {
    const merged = mergeShards([{ shard: "s1", rows: [row(WORKSHOP_STEP)] }, { shard: "s2", rows: [row(WORKSHOP_STEP, "FAIL")] }]);
    const w = merged.find((r) => r.name === WORKSHOP_STEP)!;
    expect(w.status).toBe("FAIL");
    expect(w.detail).toContain("recorded 2 times");
    expect(w.shard).toBe("s1+s2");
  });

  test("the slowest rows, slowest first", () => {
    const rows = [row(FULL_STEPS[0]!, "PASS", 5), row(WORKSHOP_STEP, "PASS", 140), row(IDLE_STEP, "PASS", 30), row(FULL_STEPS[1]!, "PASS", 2)];
    expect(slowest(rows, 2).map((r) => r.seconds)).toEqual([140, 30]);
  });
});
