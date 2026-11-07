// The identity scan of a Clover release's BUILT ARTIFACTS, on every OS: the whole of apps/desktop/out/dist/ — the
// unpacked app (resources/daemon/ with the core, the sidecar, plugin Bun and the process holder included), the
// installers (dmg, zip, NSIS, deb, rpm, AppImage), the update files and the core's own release files. Git hooks can't
// see these (a built app never enters the repo), and the leaks that happened before lived exactly here (absolute build
// paths in a Mach-O's debug stabs, 0.2.001).
//
// It is the Winter release's gate (scripts/release.ts §11b), reused: the patterns live OUTSIDE this repo, in the
// owner's local-only guard (`~/norma-private/git-hooks/name-guard.sh`, or CLOVER_NAME_GUARD), because a tracked list
// would publish the very strings it keeps out; the walk is release-lib.ts's `nameScanPlan`, with its partition
// asserted against the filesystem (every regular file under exactly one of the scanned targets or an exclusion) so a
// bug in it can't under-scan a release; and any hit fails the release. A signed release FAILS CLOSED without the
// guard. An unsigned build (CI's) scans when the guard is there and says it skipped when it isn't.
//
// Exclusions: none yet. Widening the list is a security decision, not a build fix (release-lib.ts's
// NAME_SCAN_EXCLUSIONS says why the Winter app has its one); a Chromium locale pack colliding here is investigated and
// named in CLOVER_NAME_SCAN_EXCLUSIONS below with the file it matched, never appended to blind.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { nameScanPlan } from "../release-lib";

/** Subtrees of the built output the scan leaves out: empty, see the header. */
export const CLOVER_NAME_SCAN_EXCLUSIONS: readonly RegExp[] = [];

/** The owner's local-only guard. */
export function nameGuardPath(env: Record<string, string | undefined> = process.env): string {
  return env.CLOVER_NAME_GUARD ?? join(env.HOME ?? homedir(), "norma-private", "git-hooks", "name-guard.sh");
}

/** Every regular file under `paths` (lstat: a symlink is neither counted nor followed, like `find -type f`). */
export function countFiles(paths: readonly string[]): number {
  let n = 0;
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else if (st.isFile()) n++;
  };
  for (const p of paths) walk(p);
  return n;
}

export type NameScanResult = { ran: true; targets: string[]; scanned: number; total: number } | { ran: false; reason: string };

/**
 * Scans `outDir` with the guard. Throws on a hit (the guard's own exit), on a partition that doesn't cover every
 * file, and — when `required` (a signed release) — on a missing guard.
 */
export function runNameScan(outDir: string, opts: { required: boolean; guard?: string; exclusions?: readonly RegExp[]; quiet?: boolean } = { required: false }): NameScanResult {
  const guard = opts.guard ?? nameGuardPath();
  if (!existsSync(guard)) {
    if (opts.required) throw new Error(`the identity scan can't run: ${guard} is missing, and a signed release never ships unscanned (CLOVER_NAME_GUARD names another)`);
    return { ran: false, reason: `no name guard at ${guard}` };
  }
  const exclusions = opts.exclusions ?? CLOVER_NAME_SCAN_EXCLUSIONS;
  const plan = nameScanPlan({
    root: outDir,
    listDir: (p) => readdirSync(p, { withFileTypes: true }).filter((e) => !e.isSymbolicLink()).map((e) => e.name),
    isDir: (p) => lstatSync(p).isDirectory(),
    isExcluded: (rel) => exclusions.some((re) => re.test(rel)),
  });
  const total = countFiles([outDir]);
  const scanned = countFiles(plan.targets);
  const skipped = plan.excluded.length === 0 ? 0 : countFiles(plan.excluded);
  if (scanned + skipped !== total) throw new Error(`the identity scan's partition is wrong (${scanned} scanned + ${skipped} excluded ≠ ${total} files): refusing a gate that may not cover the release`);
  // The guard's own output goes straight to the terminal, as the Winter release's does: never into an error message
  // or anything this process keeps.
  const r = spawnSync("bash", [guard, "artifacts", ...plan.targets], { stdio: opts.quiet ? "ignore" : "inherit" });
  if (r.status !== 0) throw new Error(`the identity scan found a hit in the built release (the guard exited ${r.status ?? "on a signal"}; it named the file above)`);
  return { ran: true, targets: plan.targets.map((t) => relative(outDir, t) || "."), scanned, total };
}
