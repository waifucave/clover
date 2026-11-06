// The daemon binary, `clover-core`, for each of the four targets CI builds (plan §3): one `bun build --compile` per
// target, from `packages/cli`'s own `compile:core` script with only the target and the output changed, so it is the
// same three-step, three-entrypoint build (`cli/test/compile-core.test.ts` pins its shape) and cannot drift from it.
//
//   bun run build:daemon                                  this machine's target
//   bun run build:daemon --target linux-x64[,…] | --all   cross-compile (Bun fetches the other targets' runtimes)
//   bun run build:daemon --smoke                          also run the host binary's `--version` on a temp home, and
//                                                         its `__ffi-probe` (bun:ffi in the compiled binary)
//   bun run build:daemon --dry-run                        print the commands, build nothing
//
// Output: dist/daemon/<target>/clover-core (clover-core.exe on Windows), with its size and SHA-256 printed. The
// binary is unsigned on every OS: the dev daemon signs its own copy on macOS (scripts/dev-daemon.ts), and release
// signing is M2's. `--smoke` never starts a daemon: `--version` prints and exits before anything else runs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bunPinProblem, thisBunFirst } from "./bun-pin";

export type DaemonTarget = "darwin-arm64" | "linux-x64" | "linux-arm64" | "windows-x64";

/** The four targets and Bun's name for each. */
export const DAEMON_TARGETS: Readonly<Record<DaemonTarget, string>> = {
  "darwin-arm64": "bun-darwin-arm64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "windows-x64": "bun-windows-x64",
};

/** This machine's target, or undefined where none of the four runs (an Intel Mac, Windows on Arm). */
export function hostTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): DaemonTarget | undefined {
  const os = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : undefined;
  const target = os === undefined ? undefined : `${os}-${arch}`;
  return target !== undefined && target in DAEMON_TARGETS ? (target as DaemonTarget) : undefined;
}

/** The binary's file name on the target: Windows needs the `.exe`. */
export function daemonFileName(target: DaemonTarget): string {
  return target.startsWith("windows-") ? "clover-core.exe" : "clover-core";
}

/** Where the target's binary lands, relative to the repo root, with `/`. */
export function daemonOutput(target: DaemonTarget): string {
  return `dist/daemon/${target}/${daemonFileName(target)}`;
}

const COMPILE = "bun build --compile";
const COMPILE_CORE_OUTFILE = "--outfile ../../dist/clover-core";

/**
 * `compile:core` for `target`: its compile step gets `--target`, and its output moves to `daemonOutput(target)`
 * (relative to `packages/cli`, where the script runs). The two pre-bundle steps are plain JavaScript bundles, the
 * same for every target. Throws when the script no longer has the shape this relies on: update this file, don't
 * guess around it.
 */
export function daemonCompileCommand(compileCoreScript: string, target: DaemonTarget): string {
  if (compileCoreScript.split(COMPILE).length !== 2) throw new Error(`compile:core no longer has exactly one \`${COMPILE}\` — update scripts/build-daemon.ts`);
  if (compileCoreScript.split(COMPILE_CORE_OUTFILE).length !== 2) throw new Error(`compile:core no longer writes ${COMPILE_CORE_OUTFILE} — update scripts/build-daemon.ts`);
  return compileCoreScript
    .replace(COMPILE, `${COMPILE} --target=${DAEMON_TARGETS[target]}`)
    .replace(COMPILE_CORE_OUTFILE, `--outfile ../../${daemonOutput(target)}`);
}

export interface BuildDaemonArgs {
  targets: DaemonTarget[];
  smoke: boolean;
  dryRun: boolean;
}

/** `host` is this machine's target (`hostTarget()`), passed in so the parse stays pure. */
export function parseBuildDaemonArgs(argv: readonly string[], host: DaemonTarget | undefined): BuildDaemonArgs {
  let targets: DaemonTarget[] | undefined;
  let smoke = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--smoke") smoke = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--all") targets = Object.keys(DAEMON_TARGETS) as DaemonTarget[];
    else if (a === "--target" || a.startsWith("--target=")) {
      const value = a === "--target" ? argv[++i] : a.slice("--target=".length);
      const list = (value ?? "").split(",").filter(Boolean);
      const unknown = list.filter((t) => !(t in DAEMON_TARGETS));
      if (list.length === 0 || unknown.length > 0) throw new Error(`--target takes some of ${Object.keys(DAEMON_TARGETS).join(", ")}${unknown.length > 0 ? ` (not ${unknown.join(", ")})` : ""}`);
      targets = [...new Set(list as DaemonTarget[])];
    } else throw new Error(`unknown argument ${a} (usage: build:daemon [--target <t>[,<t>…] | --all] [--smoke] [--dry-run])`);
  }
  if (targets === undefined) {
    if (host === undefined) throw new Error(`this machine runs none of the targets (${Object.keys(DAEMON_TARGETS).join(", ")}): name one with --target`);
    targets = [host];
  }
  if (smoke && (host === undefined || !targets.includes(host))) throw new Error("--smoke runs the host's own binary: include this machine's target");
  return { targets, smoke, dryRun };
}

/**
 * Runs a package script's `a && b && c` line in `cwd`: `/bin/sh` on macOS and Linux, `cmd.exe` on Windows. The
 * running Bun's folder goes first on PATH, so the line's `bun build` is this Bun, the one `main` checked.
 */
export function runScriptLine(line: string, cwd: string): number {
  const env = thisBunFirst(process.env);
  const r = process.platform === "win32"
    ? spawnSync(line, { cwd, stdio: "inherit", shell: true, env })
    : spawnSync("/bin/sh", ["-c", line], { cwd, stdio: "inherit", env });
  return r.status ?? 1;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** `--version` and `__ffi-probe` from the host binary, on a temp home with a throwaway secret service, so nothing real is near it. */
function smoke(binary: string, version: string): void {
  const home = mkdtempSync(join(tmpdir(), "clover-build-daemon-smoke-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, CLOVER_HOME: home, CLOVER_KEYCHAIN_SERVICE: "com.waifucave.clover.core.test.build-daemon" };
    delete env.CLOVER_PROFILE;
    const r = spawnSync(binary, ["--version"], { env, encoding: "utf8", timeout: 60_000 });
    const out = (r.stdout ?? "").trim();
    if (r.status !== 0 || out !== `clover ${version}`) {
      throw new Error(`${binary} --version: exit ${r.status ?? r.signal}, printed ${JSON.stringify(out)} (expected "clover ${version}")${r.stderr ? `\n${r.stderr.slice(0, 2000)}` : ""}`);
    }
    console.log(`build:daemon: smoke: ${out}`);
    // bun:ffi inside the compiled binary (the bridge's peer-pid check, the Keychain): the C library's pid is this one.
    const ffi = spawnSync(binary, ["__ffi-probe"], { env, encoding: "utf8", timeout: 60_000 });
    const ffiOut = (ffi.stdout ?? "").trim();
    if (ffi.status !== 0 || !ffiOut.startsWith("ffi: ok")) {
      throw new Error(`${binary} __ffi-probe: exit ${ffi.status ?? ffi.signal}, printed ${JSON.stringify(ffiOut)}${ffi.stderr ? `\n${ffi.stderr.slice(0, 2000)}` : ""}`);
    }
    console.log(`build:daemon: smoke: ${ffiOut}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function main(argv: readonly string[], root: string): number {
  let args: BuildDaemonArgs;
  try {
    args = parseBuildDaemonArgs(argv, hostTarget());
  } catch (err) {
    console.error(`build:daemon: ${(err as Error).message}`);
    return 2;
  }
  // release.ts's check: CI tests the Bun `.bun-version` pins, so the binary must be compiled by that one.
  const pin = args.dryRun ? null : bunPinProblem(root);
  if (pin !== null) {
    console.error(`build:daemon: ${pin} — build with the pinned Bun: scripts/pinned-bun run build:daemon`);
    return 1;
  }
  const cliDir = join(root, "packages", "cli");
  const script = (JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["compile:core"] ?? "";
  const version = readFileSync(join(root, "VERSION"), "utf8").trim();
  const host = hostTarget();
  for (const target of args.targets) {
    const command = daemonCompileCommand(script, target);
    const output = join(root, ...daemonOutput(target).split("/"));
    if (args.dryRun) {
      console.log(`build:daemon: ${target}: (in packages/cli) ${command}`);
      continue;
    }
    console.log(`build:daemon: ${target}: compiling…`);
    mkdirSync(dirname(output), { recursive: true });
    rmSync(output, { force: true });
    const status = runScriptLine(command, cliDir);
    if (status !== 0 || !existsSync(output)) {
      console.error(`build:daemon: ${target}: the compile failed (exit ${status})`);
      return 1;
    }
    console.log(`build:daemon: ${target}: ${daemonOutput(target)} (${(statSync(output).size / 1_048_576).toFixed(1)} MB, sha256 ${sha256(output)})`);
    if (args.smoke && target === host) {
      try {
        smoke(output, version);
      } catch (err) {
        console.error(`build:daemon: smoke failed: ${(err as Error).message}`);
        return 1;
      }
    }
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..")));
