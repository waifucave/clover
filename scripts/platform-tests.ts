// Which machine runs which test files (CI's macOS minutes are the merge queue's bottleneck). Linux runs every test file
// but those that need macOS; the macOS job runs only what needs it:
//   *.darwin.test.ts   macOS through and through (Seatbelt, the Keychain, codesign, a macOS app bundle, Apple's VZ…):
//                      the macOS job only
//   a file importing packages/core/test/helpers/darwin-only.ts   mixed: its macOS tests are `darwinTest(…)` /
//                      `darwinDescribe(…)`, skipping on Linux; it runs on Linux AND on the macOS job
//   every other file   Linux only
//
//   bun scripts/platform-tests.ts --root <dir> [--cwd <dir>] --darwin | --not-darwin [--shard K/N] [--config <json>]
//                                 [--check-known-failures] [--list]
//
//   --root    where the test files are (relative to the repo root)
//   --cwd     where bun runs (default: the repo root; the core runs in packages/core, for its bunfig and its paths)
//   --shard   Linux's K-th of N even parts of the list (by file, in path order)
//   --config  the root's reviewed lists (packages/core/test/platform-ci.json), paths relative to --root:
//               linuxKnownFailures   file → { owner, cause }: Linux product bugs, skipped by the Linux shards until fixed
//               linuxSkips           file → reason: a Linux file whose tests may skip (an opt-in fixture, another OS…)
//               darwinGateAllowed    file → reason: a Linux file that names "darwin" near a test gate without gating
//   --check-known-failures   runs each known failure alone and fails if one now passes (the list only shrinks)
//
// The files go to one `bun test` by path (`./…`, so bun takes each as a file, never a name filter). The run fails on
// bun's failure, an empty list, a missing or short "Ran N tests across M files" summary (a dropped file is a failure),
// and, with --config on Linux, on a skipped test or an empty file it can't account for (a macOS test left unmarked
// would otherwise run nowhere). A clear Bun crash (exit 133 or a signal, no summary) is re-run once.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";

export const DARWIN_SUFFIX = ".darwin.test.ts";
const TEST_GLOB = "**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";

export function isDarwinTest(path: string): boolean {
  return path.endsWith(DARWIN_SUFFIX);
}

/** The test files under `root` (relative to the repo root, with `/`), sorted, outside node_modules. */
export function testFiles(repoRoot: string, root: string): string[] {
  const out: string[] = [];
  for (const f of new Glob(TEST_GLOB).scanSync({ cwd: join(repoRoot, root), onlyFiles: true })) {
    const rel = `${root.replace(/\/$/, "")}/${f.split("\\").join("/")}`;
    if (rel.split("/").includes("node_modules")) continue;
    out.push(rel);
  }
  return out.sort();
}

/** Split by the file name alone: `darwin` the *.darwin.test.ts files, else the rest. */
export function select(files: readonly string[], darwin: boolean): string[] {
  return files.filter((f) => isDarwinTest(f) === darwin);
}

/**
 * Whether a test file's source gates tests on macOS: `"darwin"` (or `'darwin'`) in a file that also skips or
 * conditions tests (`.skipIf(`, `.if(`, `… ? test : …`, or an early `return` on `process.platform`). Such a test runs
 * nowhere once its file runs on Linux and the macOS job runs only marked files.
 */
export function gatesOnDarwin(source: string): boolean {
  if (!/["']darwin["']/.test(source)) return false;
  return /\.(skipIf|if|todoIf|runIf)\(/.test(source) || /\?\s*(test|describe|it)\s*:/.test(source) ||
    /if\s*\(\s*process\.platform\s*[!=]==?\s*["']darwin["']\s*\)\s*\{?\s*return/.test(source);
}

/** Whether a test file marks its macOS-only tests with the core's helper (packages/core/test/helpers/darwin-only.ts):
 *  such a file runs on Linux, its marked tests skipping there, and on the macOS job too. */
export function usesDarwinOnly(source: string): boolean {
  return /from\s+["'][^"']*helpers\/darwin-only["']/.test(source);
}

/** The macOS job's files: the *.darwin.test.ts ones and the mixed ones (`usesDarwinOnly`). */
export function macosFiles(files: readonly string[], read: (f: string) => string): string[] {
  return files.filter((f) => isDarwinTest(f) || usesDarwinOnly(read(f)));
}

/** The K-th (1-based) of N parts of `files`, dealt round-robin in path order. */
export function shardOf(files: readonly string[], k: number, n: number): string[] {
  return files.filter((_, i) => i % n === k - 1);
}

export interface PlatformCi {
  linuxKnownFailures: Record<string, { owner: string; cause: string }>;
  linuxSkips: Record<string, string>;
  darwinGateAllowed: Record<string, string>;
}

export function parseConfig(text: string): PlatformCi {
  const c = JSON.parse(text) as Partial<PlatformCi>;
  const known = c.linuxKnownFailures ?? {};
  for (const [f, e] of Object.entries(known)) {
    if (typeof e?.owner !== "string" || e.owner === "" || typeof e.cause !== "string" || e.cause === "") throw new Error(`linuxKnownFailures["${f}"] needs an owner and a cause`);
  }
  for (const [k, v] of [["linuxSkips", c.linuxSkips ?? {}], ["darwinGateAllowed", c.darwinGateAllowed ?? {}]] as const) {
    for (const [f, why] of Object.entries(v)) if (typeof why !== "string" || why === "") throw new Error(`${k}["${f}"] needs a reason`);
  }
  return { linuxKnownFailures: known, linuxSkips: c.linuxSkips ?? {}, darwinGateAllowed: c.darwinGateAllowed ?? {} };
}

/**
 * The reviewed lists against the tree (paths relative to the root): every listed file exists and runs on Linux, a
 * Linux file that gates on darwin is marked or reviewed, and no review is stale.
 */
export function configProblems(cfg: PlatformCi, linuxFiles: readonly string[], read: (f: string) => string): string[] {
  const problems: string[] = [];
  const linux = new Set(linuxFiles);
  for (const [k, list] of [["linuxKnownFailures", cfg.linuxKnownFailures], ["linuxSkips", cfg.linuxSkips], ["darwinGateAllowed", cfg.darwinGateAllowed]] as const) {
    for (const f of Object.keys(list)) if (!linux.has(f)) problems.push(`${k} lists ${f}, which is not a test file Linux runs (moved, renamed or marked .darwin?)`);
  }
  for (const f of linuxFiles) {
    const src = read(f);
    const gates = gatesOnDarwin(src) && !usesDarwinOnly(src);
    if (gates && !(f in cfg.darwinGateAllowed)) problems.push(`${f} gates tests on darwin but runs on Linux: name it *.darwin.test.ts, or mark its macOS tests with darwinTest/darwinDescribe (test/helpers/darwin-only.ts)`);
    if (!gates && f in cfg.darwinGateAllowed) problems.push(`darwinGateAllowed lists ${f}, which no longer looks like a darwin gate: remove the entry`);
  }
  return problems;
}

export interface FileResult { tests: number; skipped: number; failures: number }

/** Per file, from bun's JUnit report: its top-level <testsuite> (two-space indent) totals. */
export function parseJunit(xml: string): Map<string, FileResult> {
  const out = new Map<string, FileResult>();
  for (const m of xml.matchAll(/^ {2}<testsuite ([^>]*)>/gm)) {
    const attr = (name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1]!)?.[1];
    const file = attr("file");
    if (file === undefined) continue;
    const prev = out.get(file) ?? { tests: 0, skipped: 0, failures: 0 };
    out.set(file, { tests: prev.tests + Number(attr("tests") ?? 0), skipped: prev.skipped + Number(attr("skipped") ?? 0), failures: prev.failures + Number(attr("failures") ?? 0) });
  }
  return out;
}

/**
 * Linux's skips and empty files against the reviewed lists: a file whose tests skipped (or that ran none) must mark its
 * macOS tests (`usesDarwinOnly`) or be in linuxSkips; a linuxSkips file in this run that skipped nothing is stale.
 * `ran` is per file relative to the root; `selected` the files given to bun.
 */
export function skipProblems(selected: readonly string[], ran: Map<string, FileResult>, cfg: PlatformCi, read: (f: string) => string): string[] {
  const problems: string[] = [];
  for (const f of selected) {
    const r = ran.get(f);
    const skipped = r === undefined || r.tests === 0 ? "ran no tests" : r.skipped > 0 ? `skipped ${r.skipped} of ${r.tests} tests` : undefined;
    const allowed = f in cfg.linuxSkips || usesDarwinOnly(read(f));
    if (skipped !== undefined && !allowed) problems.push(`${f} ${skipped} on Linux: mark its macOS tests (darwinTest/darwinDescribe or *.darwin.test.ts), or review the skip in linuxSkips`);
    if (skipped === undefined && f in cfg.linuxSkips) problems.push(`linuxSkips lists ${f}, which skipped nothing on Linux: remove the entry`);
  }
  return problems;
}

export function parseSummary(output: string): { tests: number; files: number } | null {
  const m = [...output.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gm)].pop();
  return m ? { tests: Number(m[1]), files: Number(m[2]) } : null;
}

/** What is wrong with a run of `expected` files (none means it passed). */
export function runProblems(exitCode: number | null, output: string, expected: number): string[] {
  const problems: string[] = [];
  if (expected === 0) problems.push("no test files were selected");
  if (exitCode !== 0) problems.push(`bun test exited ${exitCode ?? "on a signal"}`);
  const s = parseSummary(output);
  if (s === null) problems.push('bun printed no "Ran N tests across M files" summary');
  else if (s.files < expected) problems.push(`bun ran ${s.files} files, fewer than the ${expected} selected: files were dropped`);
  return problems;
}

/** A clear Bun crash: exit 133 or death by signal, and the summary line never appeared. */
export function isClearCrash(exitCode: number | null, output: string): boolean {
  return (exitCode === 133 || exitCode === null) && parseSummary(output) === null;
}

export interface Args {
  root: string;
  cwd: string | undefined;
  darwin: boolean;
  shard: { k: number; n: number } | undefined;
  config: string | undefined;
  checkKnownFailures: boolean;
  list: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} takes a value`);
    return v;
  };
  const root = value("--root");
  const darwin = argv.includes("--darwin");
  const notDarwin = argv.includes("--not-darwin");
  if (root === undefined) throw new Error("platform-tests takes --root <dir>");
  if (darwin === notDarwin) throw new Error("platform-tests takes exactly one of --darwin and --not-darwin");
  const s = value("--shard");
  let shard: Args["shard"];
  if (s !== undefined) {
    const m = /^(\d+)\/(\d+)$/.exec(s);
    const k = Number(m?.[1]), n = Number(m?.[2]);
    if (!m || n < 1 || k < 1 || k > n) throw new Error(`--shard takes K/N with 1 <= K <= N, not ${s}`);
    if (darwin) throw new Error("--shard is Linux's (--not-darwin)");
    shard = { k, n };
  }
  return { root, cwd: value("--cwd"), darwin, shard, config: value("--config"), checkKnownFailures: argv.includes("--check-known-failures"), list: argv.includes("--list") };
}

interface Run { exitCode: number | null; output: string }

function runBun(cwd: string, files: readonly string[], junit?: string): Run {
  const args = ["test", ...(junit ? ["--reporter=junit", `--reporter-outfile=${junit}`] : []), ...files.map((f) => `./${f}`)];
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  return { exitCode: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function main(): number {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const cwd = join(repoRoot, args.cwd ?? ".");
  const rootAbs = join(repoRoot, args.root);
  // Every path below is relative to the root; bun is handed them relative to cwd.
  const fromRoot = (f: string): string => relative(rootAbs, join(repoRoot, f)).split("\\").join("/");
  const toCwd = (f: string): string => relative(cwd, join(rootAbs, f)).split("\\").join("/");
  const read = (f: string): string => readFileSync(join(rootAbs, f), "utf8");
  const all = testFiles(repoRoot, args.root).map(fromRoot);
  const cfg = args.config ? parseConfig(readFileSync(join(repoRoot, args.config), "utf8")) : undefined;
  const linuxAll = select(all, false);
  const problems: string[] = [];

  let files = args.darwin ? macosFiles(all, read) : linuxAll.filter((f) => !(cfg && f in cfg.linuxKnownFailures));
  if (!args.darwin && cfg) problems.push(...configProblems(cfg, linuxAll, read));
  if (args.shard) files = shardOf(files, args.shard.k, args.shard.n);
  if (args.list) {
    for (const f of files) console.log(f);
    return problems.length === 0 ? 0 : 1;
  }

  if (args.checkKnownFailures && cfg) {
    for (const [f, e] of Object.entries(cfg.linuxKnownFailures)) {
      if (!existsSync(join(rootAbs, f))) continue; // configProblems names it
      const r = runBun(cwd, [toCwd(f)]);
      if (r.exitCode === 0) problems.push(`${f} now passes on Linux: remove it from linuxKnownFailures (owner ${e.owner})`);
      else console.log(`platform-tests: known Linux failure, still failing as listed: ${f} (owner ${e.owner}: ${e.cause})`);
    }
  }

  const side = args.darwin ? "macOS" : `Linux${args.shard ? ` shard ${args.shard.k}/${args.shard.n}` : ""}`;
  console.log(`platform-tests: ${files.length} test file(s) under ${args.root} for ${side}`);
  const tmp = mkdtempSync(join(tmpdir(), "platform-tests-"));
  try {
    const junit = !args.darwin && cfg ? join(tmp, "junit.xml") : undefined;
    let r = runBun(cwd, files.map(toCwd), junit);
    process.stdout.write(r.output);
    if (isClearCrash(r.exitCode, r.output)) {
      console.log(`::warning::bun crashed (${r.exitCode === null ? "a signal" : `exit ${r.exitCode}`}, no summary): re-running once`);
      r = runBun(cwd, files.map(toCwd), junit);
      process.stdout.write(r.output);
    }
    problems.push(...runProblems(r.exitCode, r.output, files.length));
    if (junit && cfg) {
      if (!existsSync(junit)) problems.push("bun wrote no JUnit report");
      else {
        // JUnit names files relative to where bun ran; the lists name them relative to the root.
        const ran = new Map([...parseJunit(readFileSync(junit, "utf8"))].map(([f, v]) => [relative(rootAbs, join(cwd, f)).split("\\").join("/"), v]));
        problems.push(...skipProblems(files, ran, cfg, read));
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const p of problems) console.error(`platform-tests: ${p}`);
  return problems.length === 0 ? 0 : 1;
}

// exitCode, not exit(): a pipe takes the whole output (bun's report and summary) before the process ends.
if (import.meta.main) process.exitCode = main();
