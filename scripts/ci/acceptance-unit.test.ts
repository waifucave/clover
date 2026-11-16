import { describe, expect, test } from "bun:test";
import { units } from "../acceptance/shards";
import { judge, parseRows } from "./acceptance-unit";

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
    expect(judge({ exit: 0, table: TABLE, progress: OK_PROGRESS, logs: [] })).toEqual({ ok: true, problems: [], rows: 2, passed: 2 });
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

  test("the four units a lane's check runs own their rows between them, once each, 65 of them", () => {
    const four = units().filter((u) => ["main", "workshop", "plugin-app", "browser"].includes(u.id));
    const names = four.flatMap((u) => u.rows);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(65);
  });
});
