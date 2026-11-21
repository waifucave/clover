import { expect, test } from "bun:test";
import { linesSince } from "./log-since";

// The joined log is `stdout + "\n" + home app.log`; both grow at their ends.
const joined = (stdout: string[], home: string[]) => `${stdout.join("\n")}\n${home.join("\n")}`;

test("what a growing first file pushes in does not move the cut back over the second file's earlier lines (try 17, row 70)", () => {
  const stdout = ["[moss-app] card: x arrived"];
  const home = ["2026-11-21T02:12:13.018Z surface: island bounds 400x240", "2026-11-21T02:12:14.215Z card: [x] both buttons visible"];
  const before = joined(stdout, home);
  const mark = before.length;
  // 5 s later: the app printed an ipc line to its output, and wrote the same line (stamped) to its app.log.
  const ipc = "ipc: 5 s in 1.2/s (sealed-visible 4, size 1, surface 1) out 0.2/s (child-size 1) cpu Browser 2.6% GPU 2.5% Utility 0.0% Tab 3.1%";
  const after = joined([...stdout, `[moss-app] ${ipc}`], [...home, `2026-11-21T02:12:17.948Z ${ipc}`]);
  // The old way: the cut falls inside app.log, over the bounds line.
  expect(after.slice(mark).split("\n").some((l) => /surface: island bounds/.test(l))).toBe(true);
  // The new way: only what came after.
  const fresh = linesSince(before, after);
  expect(fresh.some((l) => /surface: island bounds/.test(l))).toBe(false);
  expect(fresh).toEqual([`[moss-app] ${ipc}`, `2026-11-21T02:12:17.948Z ${ipc}`]);
});

test("a real resize in the interval is counted, and a line the output repeats is new each time it comes again", () => {
  const before = joined(["[moss-app] surface: island bounds 400x240"], ["2026 a"]);
  const after = joined(["[moss-app] surface: island bounds 400x240", "[moss-app] surface: island bounds 400x240"], ["2026 a", "2027 surface: island bounds 400x280"]);
  expect(linesSince(before, after).filter((l) => /surface: island bounds/.test(l))).toEqual(["[moss-app] surface: island bounds 400x240", "2027 surface: island bounds 400x280"]);
});

test("nothing new gives nothing", () => {
  const t = joined(["a", "b"], ["c"]);
  expect(linesSince(t, t)).toEqual([]);
});
