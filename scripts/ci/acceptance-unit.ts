// One acceptance unit on a CI runner (ci.yml's `acceptance` job): scripts/acceptance/run.ts for one unit, headless, with
// its table, its progress and its kept logs written under <out>, and a verdict over them that does not trust the run's
// own exit code alone.
//
//   bun scripts/ci/acceptance-unit.ts <unit> <out dir>      run it and judge it; exits 1 on any problem
//   bun scripts/ci/acceptance-unit.ts --judge <out dir>     judge the files one attempt left in <out dir> (the tests use this)
//
// A unit passes when: the run exited 0; its table has rows and every row says PASS (a row the Mac alone measures says so,
// measured.ts, and is listed as such); the run said "sealed presses refused as covered or unchecked: 0"; and no line anywhere
// says "shown while headless" (the app's own line for a window that would have reached a screen).
//
// A unit that fails is run once more, in the same job, in a home of its own: the files of the two attempts stay apart
// (<out>/attempt-1, <out>/attempt-2). If the second passes the job passes and its summary says "passed on retry" with the
// rows the first one failed on, so a flake stays visible; if it fails too, the job fails. `--no-retry` runs once.
// The two attempts differ in patience: attempt 1 runs with MOSS_ACCEPT_TIME_SCALE_ATTEMPT_1 as the time scale (ci.yml: 1.5),
// attempt 2 with MOSS_ACCEPT_TIME_SCALE_ATTEMPT_2 (3), so a first attempt that is going to fail fails fast and a slow runner
// still gets a patient second chance; either variable unset, the run's own MOSS_ACCEPT_TIME_SCALE is used. A unit that passed on
// retry writes `retry.json` (the rows, what each failed on): the lane gate's summary lists every one of a run in one table.
// The verdict goes to the job's summary ($GITHUB_STEP_SUMMARY) and to the log.
import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MEASURED_ON_MAC_ONLY, MEASURED_ROWS } from "../acceptance/measured";
import { expandUnitIds, units, type UnitId } from "../acceptance/shards";

export interface Verdict {
  ok: boolean;
  problems: string[];
  rows: number;
  /** Rows that passed (a row left to the Mac is not one of them). */
  passed: number;
  /** The rows left to the Mac (their names), each with the reason its detail gave. */
  macOnly: { n: number; name: string; reason: string }[];
  /** The rows that were not PASS: where a retry says what the first attempt failed on. */
  failed: { n: number; name: string; detail: string }[];
}

/** One table row of run.ts's output: `| 12 | the step's name | PASS | 3.1 s | main | detail`. */
export function parseRows(table: string): { n: number; name: string; status: string; detail: string }[] {
  const out: { n: number; name: string; status: string; detail: string }[] = [];
  for (const line of table.split("\n")) {
    const m = /^\| (\d+) \| (.*?)\s* \| (\S+)\s* \|[^|]*\|[^|]*\| ?(.*)$/.exec(line);
    if (m !== null) out.push({ n: Number(m[1]), name: m[2]!, status: m[3]!, detail: m[4]!.trim() });
  }
  return out;
}

/** The verdict over a finished run: its exit code, its table (stdout), its progress (stderr) and the kept logs' text. */
export function judge(input: { exit: number; table: string; progress: string; logs: readonly { file: string; text: string }[]; expected?: readonly string[] }): Verdict {
  const problems: string[] = [];
  const rows = parseRows(input.table);
  // A row the unit owns (shards.ts) and the table lacks was dropped, not passed.
  for (const name of input.expected ?? []) if (!rows.some((r) => r.name === name)) problems.push(`the unit's row "${name.slice(0, 120)}" is not in the table`);
  if (input.exit !== 0) problems.push(`run.ts exited ${input.exit}`);
  if (rows.length === 0) problems.push("the run printed no table rows");
  const macOnly: Verdict["macOnly"] = [];
  const failed: Verdict["failed"] = [];
  for (const r of rows) {
    if (r.status === "PASS" && r.detail.startsWith(MEASURED_ON_MAC_ONLY)) {
      // Only the rows measured.ts names may leave their bar to the Mac; the marker on any other row is a problem.
      if (MEASURED_ROWS.some((m) => r.name.startsWith(m.prefix))) macOnly.push({ n: r.n, name: r.name, reason: r.detail.slice(MEASURED_ON_MAC_ONLY.length).replace(/^: /, "") });
      else problems.push(`row ${r.n} "${r.name}" says it is measured on the Mac only, and is not one of the rows allowed to (scripts/acceptance/measured.ts)`);
    } else if (r.status !== "PASS") {
      problems.push(`row ${r.n} "${r.name}" is ${r.status}: ${r.detail.slice(0, 300)}`);
      failed.push({ n: r.n, name: r.name, detail: r.detail.slice(0, 300) });
    }
  }
  if (!/acceptance: sealed presses refused as covered or unchecked: 0\b/.test(input.progress)) {
    const said = /acceptance: (?:FAIL: )?(\d+ of the run's own presses on a sealed button were refused[^\n]*)/.exec(input.progress)?.[1];
    problems.push(said !== undefined ? `sealed presses were refused as covered or unchecked: ${said.slice(0, 200)}` : 'the run never said "sealed presses refused as covered or unchecked: 0"');
  }
  const shown = (text: string): string | undefined => text.split("\n").find((l) => /shown while headless/.test(l));
  const fromProgress = shown(input.progress);
  if (fromProgress !== undefined) problems.push(`a window was shown while headless (progress): ${fromProgress.slice(0, 200)}`);
  for (const f of input.logs) {
    const line = shown(f.text);
    if (line !== undefined) problems.push(`a window was shown while headless (${f.file}): ${line.slice(0, 200)}`);
  }
  return { ok: problems.length === 0, problems, rows: rows.length, passed: rows.filter((r) => r.status === "PASS").length - macOnly.length, macOnly, failed };
}

/** The text of every `*.log` file under `dir` (kept logs: the daemons', the app's), at most 20 MiB each. */
function keptLogs(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.log(\.\d+)?$/.test(e.name)) out.push({ file: p.slice(dir.length + 1), text: readFileSync(p, "utf8").slice(0, 20 * 1024 * 1024) });
    }
  };
  walk(dir);
  return out;
}

function report(unit: string, v: Verdict, table: string, label = ""): string {
  const tail = table.split("\n").filter((l) => /^\d+\/\d+ passed|^slowest:/.test(l)).join("\n");
  return [
    `### acceptance: ${unit}${label} — ${v.ok ? "PASS" : "FAIL"} (${v.passed}/${v.rows} rows${v.macOnly.length > 0 ? `, ${v.macOnly.length} left to the Mac` : ""})`,
    ...(v.problems.length > 0 ? ["", ...v.problems.map((p) => `- ${p}`)] : []),
    ...(v.macOnly.length > 0 ? ["", ...v.macOnly.map((m) => `- measured on the Mac only: row ${m.n} "${m.name.slice(0, 100)}": ${m.reason}`)] : []),
    ...(tail !== "" ? ["", "```", tail, "```"] : []),
    "",
  ].join("\n");
}

/** The sealed presses of an attempt, from the apps' kept logs and the run's progress: how long the page took for the reading each
 *  press asked for ("fresh report uncovered after 140 ms", min / median / p95 / max), how many had none in time or read as covered, how many
 *  times a card said "press again", and how many presses the run made again (what the harness printed). One line, so a limit that is too short
 *  or a press that needed a second go shows up in every run's log, not only in a failing one. */
export function pressTimings(logs: readonly { file: string; text: string }[], progress: string): string {
  const ms: number[] = [];
  let none = 0;
  let covered = 0;
  let again = 0;
  for (const l of logs) {
    for (const m of l.text.matchAll(/fresh report (uncovered|covered|none in time) after (\d+) ms/g)) {
      if (m[1] === "uncovered") ms.push(Number(m[2]));
      else if (m[1] === "none in time") none++;
      else covered++;
    }
    again += (l.text.match(/sealed: press on [^\n]*: late\b/g) ?? []).length + (l.text.match(/reached no sealed page/g) ?? []).length;
  }
  const retries = (progress.match(/sealed press \(MOSS\): landed on retry/g) ?? []).length + (progress.match(/sealed presses with no fresh report in time, landed on the next press: (\d+)/g) ?? []).reduce((n, x) => n + Number(/: (\d+)$/.exec(x)![1]), 0);
  const first = (progress.match(/sealed press \(MOSS\): landed first try/g) ?? []).length;
  ms.sort((a, b) => a - b);
  const at = (q: number): number => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]!;
  const dist = ms.length === 0 ? "no fresh report logged" : `fresh report ms: n=${ms.length} min=${ms[0]} median=${at(0.5)} p95=${at(0.95)} max=${ms[ms.length - 1]}`;
  return `sealed presses: ${dist}; none in time ${none}; covered ${covered}; "press again" words ${again}; MOSS presses landed first try ${first}; presses landed on a retry ${retries}`;
}

/** One attempt's files judged: its verdict and its report. */
function judgeAttempt(unit: string, out: string, exit: number, expected: readonly string[] | undefined, label: string): { v: Verdict; text: string } {
  const table = existsSync(join(out, "table.txt")) ? readFileSync(join(out, "table.txt"), "utf8") : "";
  const progress = existsSync(join(out, "progress.txt")) ? readFileSync(join(out, "progress.txt"), "utf8") : "";
  const logs = keptLogs(join(out, "logs"));
  const v = judge({ exit, table, progress, logs, ...(expected !== undefined ? { expected } : {}) });
  if (unit !== "(judged)") console.log(`acceptance-unit: ${unit}${label}: ${pressTimings(logs, progress)}`);
  const text = report(unit, v, table, label);
  writeFileSync(join(out, "verdict.md"), text);
  return { v, text };
}

/** What the job says when its second attempt decided it: which rows (or problems) the first failed on, honestly. */
export function retryNote(first: Verdict, second: Verdict): string {
  const what = first.failed.length > 0 ? first.failed.map((f) => `row ${f.n} ${f.name.slice(0, 100)}: ${f.detail.slice(0, 160)}`) : first.problems.map((p) => p.slice(0, 200));
  return second.ok
    ? `### passed on retry: ${what.join("; ")}\n\nThe first attempt failed and the second (a fresh home) passed; both attempts' tables and logs are in the artifact (attempt-1, attempt-2).\n`
    : `### failed twice\n\nFirst attempt: ${what.join("; ")}\nSecond attempt: ${(second.failed.length > 0 ? second.failed.map((f) => `row ${f.n} ${f.name.slice(0, 100)}`) : second.problems.map((p) => p.slice(0, 200))).join("; ")}\n`;
}

function finish(text: string, ok: boolean, out: string): never {
  console.log(`\n${text}`);
  writeFileSync(join(out, "verdict.md"), text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  process.exit(ok ? 0 : 1);
}

/** The record a unit that passed on retry leaves for the lane gate's summary. */
export function retryRecord(unit: string, first: Verdict, scales: { first?: string; second?: string }): { unit: string; scales: { first?: string; second?: string }; rows: { n: number; name: string; detail: string }[]; problems: string[] } {
  return { unit, scales, rows: first.failed.map((f) => ({ n: f.n, name: f.name, detail: f.detail })), problems: first.failed.length === 0 ? first.problems.map((p) => p.slice(0, 300)) : [] };
}

/** The time scale an attempt runs with: its own variable, else the run's. */
export function scaleFor(attempt: 1 | 2, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`MOSS_ACCEPT_TIME_SCALE_ATTEMPT_${attempt}`] ?? env.MOSS_ACCEPT_TIME_SCALE;
}

/** run.ts for one unit into `out`: its table, its progress, its kept logs and renders; the exit code. */
async function runAttempt(unit: string, out: string, attempt: 1 | 2): Promise<number> {
  mkdirSync(join(out, "logs"), { recursive: true });
  mkdirSync(join(out, "renders"), { recursive: true });
  const repo = resolve(import.meta.dir, "..", "..");
  const table = createWriteStream(join(out, "table.txt"));
  const progress = createWriteStream(join(out, "progress.txt"));
  const child = spawn(process.execPath, [join(repo, "scripts", "acceptance", "run.ts"), "--verbose", "--keep-logs", join(out, "logs"), "--units", unit], {
    cwd: repo,
    env: { ...process.env, MOSS_ACCEPT_RENDERS: join(out, "renders"), ...(scaleFor(attempt) !== undefined ? { MOSS_ACCEPT_TIME_SCALE: scaleFor(attempt)! } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // The table and the progress go to the job's log as they come, and to their own files for the verdict and the artifact.
  child.stdout!.on("data", (b: Buffer) => { table.write(b); process.stdout.write(b); });
  child.stderr!.on("data", (b: Buffer) => { progress.write(b); process.stderr.write(b); });
  const relay = (sig: NodeJS.Signals) => child.kill(sig);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => relay(sig));
  const exit = await new Promise<number>((done) => child.on("exit", (c, s) => done(c ?? (s === null ? 1 : 128))));
  await Promise.all([new Promise((r) => table.end(r)), new Promise((r) => progress.end(r))]);
  writeFileSync(join(out, "exit.txt"), `${exit}\n`);
  return exit;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--judge") {
    if (args[1] === undefined) { console.error("usage: acceptance-unit.ts --judge <out dir>"); process.exit(2); }
    const dir = resolve(args[1]);
    const { v, text } = judgeAttempt("(judged)", dir, Number(readFileSync(join(dir, "exit.txt"), "utf8").trim()), undefined, "");
    finish(text, v.ok, dir);
  }
  const retry = !args.includes("--no-retry");
  const [unit, outArg] = args.filter((a) => !a.startsWith("--"));
  if (unit === undefined || outArg === undefined) { console.error("usage: acceptance-unit.ts <unit> [--no-retry] <out dir>"); process.exit(2); }
  const known = units();
  const parts = expandUnitIds([unit as UnitId]);
  if (parts.some((id) => !known.some((u) => u.id === id))) { console.error(`acceptance-unit: no unit "${unit}" in scripts/acceptance/shards.ts (${known.map((u) => u.id).join(", ")}, main)`); process.exit(2); }
  const expected = known.filter((u) => parts.includes(u.id)).flatMap((u) => u.rows);
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  const dir1 = join(out, "attempt-1");
  const exit1 = await runAttempt(unit, dir1, 1);
  const first = judgeAttempt(unit, dir1, exit1, expected, " (attempt 1)");
  if (first.v.ok || !retry) finish(first.text, first.v.ok, out);
  console.log(`\nacceptance-unit: attempt 1 failed; running ${unit} once more in a fresh home\n${first.text}`);
  const dir2 = join(out, "attempt-2");
  const exit2 = await runAttempt(unit, dir2, 2);
  const second = judgeAttempt(unit, dir2, exit2, expected, " (attempt 2)");
  if (second.v.ok) writeFileSync(join(out, "retry.json"), JSON.stringify(retryRecord(unit, first.v, { ...(scaleFor(1) !== undefined ? { first: scaleFor(1)! } : {}), ...(scaleFor(2) !== undefined ? { second: scaleFor(2)! } : {}) }), null, 2));
  finish(`${retryNote(first.v, second.v)}\n${first.text}\n${second.text}`, second.v.ok, out);
}
