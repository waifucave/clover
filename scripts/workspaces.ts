// The workspace packages, as CI and the root scripts see them (docs/clover-layout.md).
//
//   bun scripts/workspaces.ts list [--json]                       every package the root `workspaces` globs find
//   bun scripts/workspaces.ts run <script> [--os macos|linux|windows] [--skip <name>[,<name>…]]
//                                                                 run `bun run <script>` in each package that has it
//
// `run` goes through the packages in path order, one at a time, every one even after a failure, and exits 1 if any
// failed. For `test`, a package's `cloverCi` field in its package.json decides where CI runs it:
//   "cloverCi": { "os": ["macos", "linux", "windows"] }   the OSes its tests support (default: all three)
//   "cloverCi": { "ownJob": true }                         ci.yml runs its tests in a job of its own, never here
// Every other script runs wherever it is asked to.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Glob } from "bun";

export type CiOs = "macos" | "linux" | "windows";
export const CI_OSES: readonly CiOs[] = ["macos", "linux", "windows"];

export interface WorkspacePackage {
  name: string;
  /** Relative to the repo root, with `/`. */
  dir: string;
  scripts: Record<string, string>;
  /** Where CI runs its tests. */
  testOs: readonly CiOs[];
  /** ci.yml runs its tests in a job of its own. */
  ownJob: boolean;
}

export function currentOs(platform: NodeJS.Platform = process.platform): CiOs {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** The packages the root package.json's `workspaces` globs find: each directory matched that holds a package.json. */
export function workspacePackages(root: string): WorkspacePackage[] {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces?: string[] | { packages?: string[] } };
  const globs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages ?? [];
  const seen = new Map<string, WorkspacePackage>();
  for (const pattern of globs) {
    for (const match of new Glob(`${pattern.replace(/\/$/, "")}/package.json`).scanSync({ cwd: root, onlyFiles: true })) {
      const dir = toPosix(dirname(match));
      if (dir.split("/").includes("node_modules") || seen.has(dir)) continue;
      const pkg = JSON.parse(readFileSync(join(root, match), "utf8")) as {
        name?: string;
        scripts?: Record<string, string>;
        cloverCi?: { os?: unknown; ownJob?: unknown };
      };
      if (typeof pkg.name !== "string" || pkg.name === "") throw new Error(`${dir}/package.json has no name`);
      const os = pkg.cloverCi?.os;
      if (os !== undefined && (!Array.isArray(os) || os.some((o) => !CI_OSES.includes(o as CiOs)))) {
        throw new Error(`${dir}/package.json: cloverCi.os must list some of ${CI_OSES.join(", ")}`);
      }
      seen.set(dir, {
        name: pkg.name,
        dir,
        scripts: pkg.scripts ?? {},
        testOs: (os as CiOs[] | undefined) ?? CI_OSES,
        ownJob: pkg.cloverCi?.ownJob === true,
      });
    }
  }
  return [...seen.values()].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/** The packages `run <script>` would run, in order. */
export function plan(packages: readonly WorkspacePackage[], script: string, opts: { os: CiOs; skip?: readonly string[] }): WorkspacePackage[] {
  return packages.filter((p) => {
    if (p.scripts[script] === undefined || opts.skip?.includes(p.name)) return false;
    if (script === "test") return !p.ownJob && p.testOs.includes(opts.os);
    return true;
  });
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

export function main(argv: readonly string[], root: string): number {
  const [command, script] = argv;
  const packages = workspacePackages(root);
  if (command === "list") {
    if (argv.includes("--json")) console.log(JSON.stringify(packages, null, 2));
    else for (const p of packages) console.log(`${p.dir}  ${p.name}  test on ${p.ownJob ? "its own job" : p.testOs.join(", ")}`);
    return 0;
  }
  if (command !== "run" || script === undefined) {
    console.error("usage: bun scripts/workspaces.ts list [--json] | run <script> [--os macos|linux|windows] [--skip <name>,...]");
    return 2;
  }
  const osArg = flag(argv, "--os");
  if (osArg !== undefined && !CI_OSES.includes(osArg as CiOs)) {
    console.error(`--os must be one of ${CI_OSES.join(", ")}`);
    return 2;
  }
  const os = (osArg as CiOs | undefined) ?? currentOs();
  const skip = flag(argv, "--skip")?.split(",").filter(Boolean) ?? [];
  const chosen = plan(packages, script, { os, skip });
  if (chosen.length === 0) {
    console.log(`workspaces: no package has a \`${script}\` script to run on ${os}`);
    return 0;
  }
  const failed: string[] = [];
  for (const p of chosen) {
    console.log(`\n── ${p.name} (${p.dir}): bun run ${script}`);
    const r = spawnSync("bun", ["run", script], { cwd: join(root, p.dir), stdio: "inherit", env: process.env, shell: process.platform === "win32" });
    if (r.status !== 0) failed.push(`${p.name} (exit ${r.status ?? r.signal ?? "unknown"})`);
  }
  console.log(`\nworkspaces: ${script} on ${os}: ${chosen.length - failed.length} of ${chosen.length} passed${failed.length > 0 ? `; failed: ${failed.join(", ")}` : ""}`);
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (!existsSync(join(root, "package.json"))) throw new Error(`no package.json at ${relative(process.cwd(), root)}`);
  process.exit(main(process.argv.slice(2), root));
}
