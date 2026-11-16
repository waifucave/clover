// One acceptance unit on a CI runner (ci.yml's `acceptance` job): scripts/acceptance/run.ts for one unit, headless, with
// its table, its progress and its kept logs written under <out>, and a verdict over them that does not trust the run's
// own exit code alone.
//
//   bun scripts/ci/acceptance-unit.ts <unit> <out dir>      run it and judge it; exits 1 on any problem
//   bun scripts/ci/acceptance-unit.ts --judge <out dir>     judge the files a run left in <out dir> (the tests use this)
//
// A unit passes when: the run exited 0; its table has rows and every row says PASS; the run said "sealed presses refused
// as covered or unchecked: 0"; and no line anywhere says "shown while headless" (the app's own line for a window that
// would have reached a screen). The verdict goes to the job's summary ($GITHUB_STEP_SUMMARY) and to the log.
import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { units } from "../acceptance/shards";

export interface Verdict {
  ok: boolean;
  problems: string[];
  rows: number;
  passed: number;
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
  for (const r of rows) if (r.status !== "PASS") problems.push(`row ${r.n} "${r.name}" is ${r.status}: ${r.detail.slice(0, 300)}`);
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
  return { ok: problems.length === 0, problems, rows: rows.length, passed: rows.filter((r) => r.status === "PASS").length };
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

function report(unit: string, v: Verdict, table: string): string {
  const tail = table.split("\n").filter((l) => /^\d+\/\d+ passed|^slowest:/.test(l)).join("\n");
  return [
    `### acceptance: ${unit} — ${v.ok ? "PASS" : "FAIL"} (${v.passed}/${v.rows} rows)`,
    ...(v.problems.length > 0 ? ["", ...v.problems.map((p) => `- ${p}`)] : []),
    ...(tail !== "" ? ["", "```", tail, "```"] : []),
    "",
  ].join("\n");
}

function finish(unit: string, out: string, exit: number, expected?: readonly string[]): never {
  const table = existsSync(join(out, "table.txt")) ? readFileSync(join(out, "table.txt"), "utf8") : "";
  const progress = existsSync(join(out, "progress.txt")) ? readFileSync(join(out, "progress.txt"), "utf8") : "";
  const v = judge({ exit, table, progress, logs: keptLogs(join(out, "logs")), ...(expected !== undefined ? { expected } : {}) });
  const text = report(unit, v, table);
  console.log(`\n${text}`);
  writeFileSync(join(out, "verdict.md"), text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  process.exit(v.ok ? 0 : 1);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--judge") {
    if (args[1] === undefined) { console.error("usage: acceptance-unit.ts --judge <out dir>"); process.exit(2); }
    finish("(judged)", resolve(args[1]), Number(readFileSync(join(resolve(args[1]), "exit.txt"), "utf8").trim()));
  }
  const [unit, outArg] = args;
  if (unit === undefined || outArg === undefined) { console.error("usage: acceptance-unit.ts <unit> <out dir>"); process.exit(2); }
  const owned = units().find((u) => u.id === unit);
  if (owned === undefined) { console.error(`acceptance-unit: no unit "${unit}" in scripts/acceptance/shards.ts (${units().map((u) => u.id).join(", ")})`); process.exit(2); }
  const out = resolve(outArg);
  mkdirSync(join(out, "logs"), { recursive: true });
  mkdirSync(join(out, "renders"), { recursive: true });
  const repo = resolve(import.meta.dir, "..", "..");
  const table = createWriteStream(join(out, "table.txt"));
  const progress = createWriteStream(join(out, "progress.txt"));
  const child = spawn(process.execPath, [join(repo, "scripts", "acceptance", "run.ts"), "--verbose", "--keep-logs", join(out, "logs"), "--units", unit], {
    cwd: repo,
    env: { ...process.env, MOSS_ACCEPT_RENDERS: join(out, "renders") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // The table and the progress go to the job's log as they come, and to their own files for the verdict and the artifact.
  child.stdout!.on("data", (b: Buffer) => { table.write(b); process.stdout.write(b); });
  child.stderr!.on("data", (b: Buffer) => { progress.write(b); process.stderr.write(b); });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  const exit = await new Promise<number>((done) => child.on("exit", (c, s) => done(c ?? (s === null ? 1 : 128))));
  await Promise.all([new Promise((r) => table.end(r)), new Promise((r) => progress.end(r))]);
  writeFileSync(join(out, "exit.txt"), `${exit}\n`);
  finish(unit, out, exit, owned.rows);
}
