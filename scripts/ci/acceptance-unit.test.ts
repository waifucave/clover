import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { units } from "../acceptance/shards";
import { MEASURED_ON_MAC_ONLY } from "../acceptance/measured";
import { judge, parseRows, pressTimings, retryNote, retryRecord, scaleFor } from "./acceptance-unit";

const TABLE = `
MOSS acceptance (source)

| # | step                  | result  |        s | shard  | first failing call / detail
|---|-----------------------|---------|----------|--------|----------------------------
| 1 | first start           | PASS    |     12.3 s | -      | the app paired | and set up
| 2 | a model key           | PASS    |      1.0 s | -      | added

2/2 passed
slowest: 1 (12 s) first start
`;
const OK_PROGRESS = "acceptance: step 1: PASS\nacceptance: sealed presses refused as covered or unchecked: 0\nacceptance: audio: 1 app start(s) muted, none played unmuted\n";

describe("the acceptance unit's verdict", () => {
  test("reads the rows of run.ts's table, a detail with a pipe in it included", () => {
    expect(parseRows(TABLE)).toEqual([
      { n: 1, name: "first start", status: "PASS", detail: "the app paired | and set up" },
      { n: 2, name: "a model key", status: "PASS", detail: "added" },
    ]);
  });

  test("a clean run passes", () => {
    expect(judge({ exit: 0, table: TABLE, progress: OK_PROGRESS, logs: [] })).toEqual({ ok: true, problems: [], rows: 2, passed: 2, macOnly: [], failed: [] });
  });

  test("a row that is not PASS fails it, whatever the exit code says", () => {
    const v = judge({ exit: 0, table: TABLE.replace("| 2 | a model key           | PASS   ", "| 2 | a model key           | BLOCKED"), progress: OK_PROGRESS, logs: [] });
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain('row 2 "a model key" is BLOCKED');
  });

  test("a nonzero exit, an empty table, or no sealed-presses line fails it", () => {
    expect(judge({ exit: 1, table: TABLE, progress: OK_PROGRESS, logs: [] }).problems).toEqual(["run.ts exited 1"]);
    expect(judge({ exit: 2, table: "", progress: OK_PROGRESS, logs: [] }).problems).toEqual(["run.ts exited 2", "the run printed no table rows"]);
    expect(judge({ exit: 0, table: TABLE, progress: "acceptance: step 1: PASS\n", logs: [] }).problems).toEqual(['the run never said "sealed presses refused as covered or unchecked: 0"']);
  });

  test("presses refused as covered or unchecked fail it, with the run's own count", () => {
    const progress = "acceptance: FAIL: 3 of the run's own presses on a sealed button were refused as covered or unchecked, e.g. x\n";
    const v = judge({ exit: 1, table: TABLE, progress, logs: [] });
    expect(v.problems.some((p) => p.startsWith("sealed presses were refused as covered or unchecked: 3 of the run's own presses"))).toBe(true);
  });

  test("a row the unit owns that the table lacks fails it", () => {
    const v = judge({ exit: 0, table: TABLE, progress: OK_PROGRESS, logs: [], expected: ["first start", "a model key", "a row that was dropped"] });
    expect(v.problems).toEqual(['the unit\'s row "a row that was dropped" is not in the table']);
    expect(judge({ exit: 0, table: TABLE, progress: OK_PROGRESS, logs: [], expected: ["first start", "a model key"] }).ok).toBe(true);
  });

  test('a "shown while headless" line in the progress or in any kept log fails it', () => {
    const line = "2026-11-16T10:00:00.000Z [moss-app] window: shown while headless (main)";
    expect(judge({ exit: 0, table: TABLE, progress: `${OK_PROGRESS}${line}\n`, logs: [] }).ok).toBe(false);
    const v = judge({ exit: 0, table: TABLE, progress: OK_PROGRESS, logs: [{ file: "app.log", text: `a\n${line}\nb` }, { file: "daemon-1.log", text: "fine" }] });
    expect(v.problems).toEqual([`a window was shown while headless (app.log): ${line}`]);
  });

  test("a row left to the Mac is listed, not counted as a pass, and only the rows measured.ts names may be", () => {
    const idle = TABLE.replace("| 2 | a model key           | PASS    |      1.0 s | -      | added", `| 2 | window: an idle app with Alpha's tab open stays cheap | PASS | 1.0 s | - | ${MEASURED_ON_MAC_ONLY}: a runner's load moves it`);
    const v = judge({ exit: 0, table: idle, progress: OK_PROGRESS, logs: [] });
    expect(v.ok).toBe(true);
    expect({ rows: v.rows, passed: v.passed, macOnly: v.macOnly.map((m) => m.n) }).toEqual({ rows: 2, passed: 1, macOnly: [2] });
    const other = TABLE.replace("| added", `| ${MEASURED_ON_MAC_ONLY}: no reason`);
    expect(judge({ exit: 0, table: other, progress: OK_PROGRESS, logs: [] }).problems[0]).toContain("is not one of the rows allowed to");
  });

  test("a retry says which rows the first attempt failed on, and a second failure says so", () => {
    const red = judge({ exit: 1, table: TABLE.replace("| 2 | a model key           | PASS   ", "| 2 | a model key           | FAIL   "), progress: OK_PROGRESS, logs: [] });
    const green = judge({ exit: 0, table: TABLE, progress: OK_PROGRESS, logs: [] });
    expect(retryNote(red, green)).toStartWith("### passed on retry: row 2 a model key");
    expect(retryNote(red, red)).toStartWith("### failed twice");
  });

  test("attempt 1 and attempt 2 take their own time scale, else the run's", () => {
    expect(scaleFor(1, { MOSS_ACCEPT_TIME_SCALE_ATTEMPT_1: "1.5", MOSS_ACCEPT_TIME_SCALE_ATTEMPT_2: "3" })).toBe("1.5");
    expect(scaleFor(2, { MOSS_ACCEPT_TIME_SCALE_ATTEMPT_1: "1.5", MOSS_ACCEPT_TIME_SCALE_ATTEMPT_2: "3" })).toBe("3");
    expect(scaleFor(2, { MOSS_ACCEPT_TIME_SCALE: "2" })).toBe("2");
    expect(scaleFor(1, {})).toBeUndefined();
  });

  test("a unit that passed on retry leaves the rows its first attempt failed on for the lane gate's summary", () => {
    const red = judge({ exit: 1, table: TABLE.replace("| 2 | a model key           | PASS   ", "| 2 | a model key           | FAIL   "), progress: OK_PROGRESS, logs: [] });
    expect(retryRecord("window-1", red, { first: "1.5", second: "3" })).toEqual({ unit: "window-1", scales: { first: "1.5", second: "3" }, rows: [{ n: 2, name: "a model key", detail: "added" }], problems: [] });
  });

  test("the units a lane's check runs (ci.yml's matrix) own their rows between them, once each; `main` is the chain and the window's three", () => {
    const matrix = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: { acceptance: { strategy: { matrix: { unit: string[] } } } } }).jobs.acceptance.strategy.matrix.unit;
    const mine = units().filter((u) => matrix.includes(u.id));
    expect(mine.map((u) => u.id as string).sort()).toEqual([...matrix].sort());
    const names = mine.flatMap((u) => u.rows);
    expect(new Set(names).size).toBe(names.length);
    // 57 since lane MC: the rows that need a bot's tab run elsewhere (scripts/acceptance/elsewhere.ts); the cards row is back,
    // on a code session (a plugin's own cards are its own tools' cards).
    expect(names.length).toBeGreaterThan(56);
  });

  test("the moss unit (MOSS, the bots app) owns its 19 rows", () => {
    const moss = units().find((u) => u.id === "moss")!;
    expect(moss.rows.length).toBe(19);
    expect(new Set(moss.rows).size).toBe(19);
  });

  test("the sealed presses' timings: the distribution of the fresh reports that came, the late and covered ones, the presses made again", () => {
    const line = (kind: string, ms: number) => `[moss-app] sealed: press on card_x allow_once in island: fresh report ${kind} after ${ms} ms`;
    const logs = [
      { file: "app.log", text: [line("uncovered", 120), line("uncovered", 130), line("uncovered", 150), line("uncovered", 300), line("none in time", 402), "sealed: press on card_x allow_once in island: late"].join("\n") },
      { file: "moss-app.log", text: [line("covered", 90), "moss: sealed: a press over card_y button:allow_once reached no sealed page; it says press again"].join("\n") },
    ];
    const progress = ["acceptance: sealed press (MOSS): landed first try", "acceptance: sealed press (MOSS): landed first try", "acceptance: sealed press (MOSS): landed on retry (the first press said late)", "acceptance: sealed presses with no fresh report in time, landed on the next press: 2"].join("\n");
    const said = pressTimings(logs, progress);
    expect(said).toContain("n=4 min=120 median=150 p95=300 max=300");
    expect(said).toContain("none in time 1; covered 1;");
    expect(said).toContain('"press again" words 2;');
    expect(said).toContain("landed first try 2; presses landed on a retry 3");
    expect(pressTimings([], "")).toContain("no fresh report logged");
  });
});
