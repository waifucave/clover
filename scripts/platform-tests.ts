// Which machine runs which test files (CI's macOS minutes are the merge queue's bottleneck). A test file named
// `*.darwin.test.ts` needs macOS (Seatbelt, the Keychain, codesign, a macOS app bundle…) and runs only on the macOS
// job; every other test file runs on Linux.
//
//   bun scripts/platform-tests.ts --root <dir> --darwin       run the root's *.darwin.test.ts files (macOS)
//   bun scripts/platform-tests.ts --root <dir> --not-darwin   run the root's other test files (Linux)
//   … --list                                                  print the files instead of running them
//
// The files go to one `bun test` by path (`./<root>/…`, so bun takes each as a file, never a name filter), from the
// repo root. The run fails on bun's own failure, on an empty list, and when bun's "Ran N tests across M files"
// summary is missing or counts fewer files than the list: a file dropped on the way is a failure, not a pass.
import { spawnSync } from "node:child_process";
import { Glob } from "bun";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

export function select(files: readonly string[], darwin: boolean): string[] {
  return files.filter((f) => isDarwinTest(f) === darwin);
}

/**
 * Whether a test file's source gates tests on macOS: `"darwin"` (or `'darwin'`) in a file that also skips or
 * conditions tests (`.skipIf(`, `.if(`, `.todoIf(`, or an early `return` on `process.platform`). Such a test runs
 * nowhere once its file runs on Linux and the macOS job runs only `*.darwin.test.ts`: it belongs in one of those.
 */
export function gatesOnDarwin(source: string): boolean {
  if (!/["']darwin["']/.test(source)) return false;
  return /\.(skipIf|if|todoIf|runIf)\(/.test(source) || /if\s*\(\s*process\.platform\s*[!=]==?\s*["']darwin["']\s*\)\s*\{?\s*return/.test(source);
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

export function parseArgs(argv: readonly string[]): { root: string; darwin: boolean; list: boolean } {
  const i = argv.indexOf("--root");
  const root = i >= 0 ? argv[i + 1] : undefined;
  const darwin = argv.includes("--darwin");
  const notDarwin = argv.includes("--not-darwin");
  if (root === undefined || root.startsWith("--")) throw new Error("platform-tests takes --root <dir>");
  if (darwin === notDarwin) throw new Error("platform-tests takes exactly one of --darwin and --not-darwin");
  return { root, darwin, list: argv.includes("--list") };
}

if (import.meta.main) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const files = select(testFiles(repoRoot, args.root), args.darwin);
  if (args.list) {
    for (const f of files) console.log(f);
  } else {
    console.log(`platform-tests: ${files.length} ${args.darwin ? "macOS-only" : "non-macOS"} test file(s) under ${args.root}`);
    const r = spawnSync(process.execPath, ["test", ...files.map((f) => `./${f}`)], { cwd: repoRoot, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    process.stdout.write(output);
    const problems = runProblems(r.status, output, files.length);
    for (const p of problems) console.error(`platform-tests: ${p}`);
    // exitCode, not exit(): a pipe takes the whole output (and bun's summary) before the process ends.
    process.exitCode = problems.length === 0 ? 0 : 1;
  }
}
