#!/usr/bin/env bun
// The upgrade pair in one command: an earlier build makes a home and a keychain (a full acceptance run with
// --keep-state), then this build starts on them (--upgrade-from), as the owner's install of a new try over the last one.
//
//   scripts/pinned-bun scripts/acceptance/upgrade.ts [--from <commit>]       source: tree <commit> (default: the newest
//                                                                            try-* tag) built in a temp worktree, then
//                                                                            this checkout
//   scripts/pinned-bun scripts/acceptance/upgrade.ts --from-app <old.app> --app <new.app>
//                                                                            the test-marked packaged twins (run them
//                                                                            under lane M's watchdog)
//   --keep-logs <dir>   each run's logs in <dir>/old and <dir>/upgrade
//   --verbose           each run's progress
//   --keep              leave the state dir (and the old tree's worktree) for a look; the paths are printed
//
// The old tree runs with THIS checkout's harness (scripts/acceptance, all but daemon.ts, which is the old core's own
// seam), so it can keep its state; a tree whose daemon has no fake web seam runs with --skip-web-turns, so nothing
// reaches the real web. Both tables are printed; the exit code is the upgrade run's.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const HARNESS = join(REPO, "scripts", "acceptance");
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fromApp = flag("--from-app");
const toApp = flag("--app");
const keepLogs = flag("--keep-logs");
const verbose = argv.includes("--verbose");
const keep = argv.includes("--keep");
if ((fromApp === undefined) !== (toApp === undefined)) {
  console.error("upgrade: the packaged pair takes both --from-app <old.app> and --app <new.app>");
  process.exit(2);
}
const packaged = fromApp !== undefined;

const git = (args: string[], cwd = REPO): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr ?? "").trim().slice(0, 300)}`);
  return (r.stdout ?? "").trim();
};
/** The newest try tag, by its date: the build the owner has installed. */
function lastTry(): string {
  const tag = git(["for-each-ref", "--sort=-creatordate", "--count=1", "--format=%(refname:short)", "refs/tags/try-*"]);
  if (tag === "") throw new Error("no try-* tag: pass --from <commit>");
  return tag;
}

const pinnedBun = join(REPO, "scripts", "pinned-bun");
/** One acceptance run; its table (stdout) comes back, its progress goes to stderr. */
function run(label: string, script: string, args: string[], cwd: string): { code: number; table: string } {
  console.error(`upgrade: ${label}: ${[script, ...args].join(" ")}`);
  const r = spawnSync(pinnedBun, [script, ...args, ...(verbose ? ["--verbose"] : [])], { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 2, table: (r.stdout ?? "").trim() };
}

// The state dir under the temp folder, short: the daemon's socket goes under it (state.ts SOCKET_PATH_MAX).
const state = mkdtempSync(join(tmpdir(), "clv-up-"));
let tree: string | undefined;
let fromLabel = "";
let code = 2;
const tables: string[] = [];
try {
  let oldScript = join(HARNESS, "run.ts");
  let oldCwd = REPO;
  const oldArgs: string[] = ["--keep-state", state];
  if (packaged) {
    fromLabel = fromApp!;
    oldArgs.unshift("--app", fromApp!);
  } else {
    const from = flag("--from") ?? lastTry();
    const commit = git(["rev-parse", "--short=9", `${from}^{commit}`]);
    fromLabel = `${from}${from.startsWith(commit) ? "" : ` (${commit})`}`;
    // The old tree, as it was: a detached worktree, its own dependencies.
    tree = mkdtempSync(join(tmpdir(), "clv-up-tree-"));
    rmSync(tree, { recursive: true, force: true });
    git(["worktree", "add", "--detach", tree, commit]);
    console.error(`upgrade: the old tree ${fromLabel} in ${tree}; installing its dependencies`);
    const installed = spawnSync(pinnedBun, ["install", "--frozen-lockfile"], { cwd: tree, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 900_000 });
    if (installed.status !== 0) throw new Error(`bun install in the old tree failed: ${(installed.stderr ?? "").trim().split("\n").pop()?.slice(0, 300)}`);
    // This checkout's harness over the old tree's, but the old core's own daemon seam.
    const into = join(tree, "scripts", "acceptance");
    for (const f of readdirSync(HARNESS)) if (f !== "daemon.ts") cpSync(join(HARNESS, f), join(into, f), { recursive: true });
    if (!readFileSync(join(into, "daemon.ts"), "utf8").includes("pluginFetch")) {
      console.error("upgrade: the old tree's daemon has no fake web seam: its run skips the web turns");
      oldArgs.push("--skip-web-turns");
    }
    oldScript = join(into, "run.ts");
    oldCwd = tree;
  }
  if (keepLogs !== undefined) oldArgs.push("--keep-logs", join(keepLogs, "old"));
  const old = run(`the old build (${fromLabel}) keeps its state`, oldScript, oldArgs, oldCwd);
  tables.push(`== the old build: ${fromLabel}, --keep-state (exit ${old.code})\n${old.table}`);
  if (!existsSync(join(state, "state.json"))) throw new Error("the old run left no state.json (its table above says why)");

  const newArgs = ["--upgrade-from", state, ...(packaged ? ["--app", toApp!] : []), ...(keepLogs !== undefined ? ["--keep-logs", join(keepLogs, "upgrade")] : [])];
  const head = packaged ? toApp! : git(["rev-parse", "--short=9", "HEAD"]);
  const up = run(`this build (${head}) over it`, join(HARNESS, "run.ts"), newArgs, REPO);
  tables.push(`== the upgrade: ${head} over ${fromLabel}, --upgrade-from (exit ${up.code})\n${up.table}`);
  code = up.code;
} catch (err) {
  console.error(`upgrade: ${err instanceof Error ? err.message : String(err)}`);
  code = 2;
} finally {
  console.log(tables.join("\n\n"));
  if (keep) {
    console.error(`upgrade: kept the state dir ${state}${tree !== undefined ? ` and the old tree ${tree}` : ""}`);
  } else {
    // The state dir holds the run's throwaway keychain file (never in the search list) and the temp homes.
    rmSync(state, { recursive: true, force: true });
    if (tree !== undefined) {
      try { git(["worktree", "remove", "--force", tree]); } catch { rmSync(tree, { recursive: true, force: true }); }
    }
  }
}
process.exit(code);
