// The daemon binary, `clover-core`, for each of the four targets CI builds (plan §3): one `bun build --compile` per
// target, from `packages/cli`'s own `compile:core` script with only the target and the output changed, so it is the
// same three-step, three-entrypoint build (`cli/test/compile-core.test.ts` pins its shape) and cannot drift from it.
//
//   bun run build:daemon                                  this machine's target
//   bun run build:daemon --target linux-x64[,…] | --all   cross-compile (Bun fetches the other targets' runtimes)
//   bun run build:daemon --smoke                          also run the host binary's `--version` on a temp home, its
//                                                         `__ffi-probe` (bun:ffi, and the bridge's peer-pid check) and
//                                                         `bridge` (an MCP initialize, K-M1's dispatch), and
//                                                         `__verify-feed` (the update feed's check refuses a bad file)
//   bun run build:daemon --dry-run                        print the commands, build nothing
//   bun run build:daemon --plugins-manifest <file>        embed the bundled plugins' manifest (#259: the release
//                                                         builds measure the staged tree; packages/core/src/
//                                                         bundled-plugins-dir.ts). Without one the core bundles none
//
// Every `bun build` step gets `--define __CLOVER_DIST__=true` (packages/core/src/build-kind.ts: a dist build ignores
// the environment's choice of programs to run), and the compiled binary is sealed (scripts/seal-bun-doors.ts: Bun's
// BUN_BE_BUN, BUN_OPTIONS, BUN_INSPECT*, BUN_CONFIG_VERBOSE_FETCH and NODE_PATH made unsettable on macOS and Linux,
// then the byte check; a Windows binary is left unsealed) before anything signs it.
//
// Beside it go the binaries that run code not the core's own (scripts/bundled-binaries.ts): `clover-plugin-bun`, the
// pinned Bun's release build for the target (checked against its pinned SHA-256), and on macOS `clover-process-holder`,
// built from the installed agent runtime's source. Each is signed ad hoc under its own identifier here.
//
// Output: dist/daemon/<target>/clover-core (clover-core.exe on Windows), with its size and SHA-256 printed. The
// binary is unsigned on every OS: the dev daemon signs its own copy on macOS (scripts/dev-daemon.ts), and release
// signing is M2's. `--smoke` never starts a daemon: `--version` prints and exits before anything else runs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIST_BUILD_DEFINE } from "../packages/core/src/build-kind";
import { BUNDLED_MANIFEST_FILE, parseBundledManifest } from "../packages/core/src/bundled-plugins-dir";
import { bunPinProblem, thisBunFirst } from "./bun-pin";
import { bundledFiles, buildHolder, HOLDER_FILE, stagePluginBun } from "./bundled-binaries";
import { sealFile } from "./seal-bun-doors";

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
/** A release's TLS trusts the OS's certificate store (Bun's bundled roots plus what the OS trusts: a corporate CA its
 *  IT installs there), never a CA from the environment (`build-kind.ts`'s refusal). Adding to the OS store takes the
 *  user's authentication on macOS and root on Linux. Baked into the binary's execArgv, so nothing at run time sets it. */
export const DIST_EXEC_ARGV = "--compile-exec-argv=--use-system-ca";
const COMPILE_CORE_OUTFILE = "--outfile ../../dist/clover-core";
/** Where `--plugins-manifest`'s file is copied for the compile (relative to packages/cli, beside the worker bundles):
 *  the compile step embeds it as a file (Bun.embeddedFiles), which the core reads as its bundled-plugins manifest. */
export const MANIFEST_EMBED = `.build/${BUNDLED_MANIFEST_FILE}`;

/**
 * `compile:core` for `target`: its compile step gets `--target`, and its output moves to `daemonOutput(target)`
 * (relative to `packages/cli`, where the script runs). The two pre-bundle steps are plain JavaScript bundles, the
 * same for every target. Throws when the script no longer has the shape this relies on: update this file, don't
 * guess around it.
 */
export function daemonCompileCommand(compileCoreScript: string, target: DaemonTarget, embedManifest = false): string {
  if (compileCoreScript.split(COMPILE).length !== 2) throw new Error(`compile:core no longer has exactly one \`${COMPILE}\` — update scripts/build-daemon.ts`);
  if (compileCoreScript.split(COMPILE_CORE_OUTFILE).length !== 2) throw new Error(`compile:core no longer writes ${COMPILE_CORE_OUTFILE} — update scripts/build-daemon.ts`);
  return compileCoreScript
    .replace(COMPILE, `${COMPILE} --target=${DAEMON_TARGETS[target]} ${DIST_EXEC_ARGV}`)
    .replace(COMPILE_CORE_OUTFILE, `${embedManifest ? `${MANIFEST_EMBED} ` : ""}--outfile ../../${daemonOutput(target)}`)
    .replaceAll("bun build ", `bun build --define ${DIST_BUILD_DEFINE} `);
}

export interface BuildDaemonArgs {
  targets: DaemonTarget[];
  smoke: boolean;
  dryRun: boolean;
  /** The bundled plugins' manifest to embed (a path), when the build ships bundled plugins. */
  pluginsManifest?: string;
}

/** `host` is this machine's target (`hostTarget()`), passed in so the parse stays pure. */
export function parseBuildDaemonArgs(argv: readonly string[], host: DaemonTarget | undefined): BuildDaemonArgs {
  let targets: DaemonTarget[] | undefined;
  let smoke = false;
  let dryRun = false;
  let pluginsManifest: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--smoke") smoke = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--plugins-manifest" || a.startsWith("--plugins-manifest=")) {
      pluginsManifest = a === "--plugins-manifest" ? argv[++i] : a.slice("--plugins-manifest=".length);
      if (!pluginsManifest) throw new Error("--plugins-manifest takes a file");
    } else if (a === "--all") targets = Object.keys(DAEMON_TARGETS) as DaemonTarget[];
    else if (a === "--target" || a.startsWith("--target=")) {
      const value = a === "--target" ? argv[++i] : a.slice("--target=".length);
      const list = (value ?? "").split(",").filter(Boolean);
      const unknown = list.filter((t) => !(t in DAEMON_TARGETS));
      if (list.length === 0 || unknown.length > 0) throw new Error(`--target takes some of ${Object.keys(DAEMON_TARGETS).join(", ")}${unknown.length > 0 ? ` (not ${unknown.join(", ")})` : ""}`);
      targets = [...new Set(list as DaemonTarget[])];
    } else throw new Error(`unknown argument ${a} (usage: build:daemon [--target <t>[,<t>…] | --all] [--smoke] [--dry-run] [--plugins-manifest <file>])`);
  }
  if (targets === undefined) {
    if (host === undefined) throw new Error(`this machine runs none of the targets (${Object.keys(DAEMON_TARGETS).join(", ")}): name one with --target`);
    targets = [host];
  }
  if (smoke && (host === undefined || !targets.includes(host))) throw new Error("--smoke runs the host's own binary: include this machine's target");
  return { targets, smoke, dryRun, ...(pluginsManifest === undefined ? {} : { pluginsManifest }) };
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

/**
 * `clover-core bridge` (K-M1) answers an MCP `initialize` on stdio. Started with no session, as here, it reaches no
 * daemon (it says so on stderr) but still serves the handshake, which shows the dispatch reaches the bridge. Returns
 * the server's name and protocol version.
 */
async function smokeBridge(binary: string, env: NodeJS.ProcessEnv): Promise<string> {
  const bridgeEnv = { ...env };
  for (const k of ["CLOVER_BRIDGE_TOKEN", "CLOVER_BRIDGE_SESSION", "CLOVER_BRIDGE_SOCKET"]) delete bridgeEnv[k];
  const proc = Bun.spawn([binary, "bridge"], { env: bridgeEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 60_000);
  try {
    const request = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "build-daemon", version: "0" } } };
    proc.stdin.write(`${JSON.stringify(request)}\n`);
    await proc.stdin.flush();
    const reader = proc.stdout.getReader();
    let out = "";
    while (!out.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    await proc.stdin.end();
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    let answer: { id?: number; result?: { protocolVersion?: string; serverInfo?: { name?: string } } } = {};
    try { answer = JSON.parse(out.split("\n")[0] ?? ""); } catch { /* below */ }
    if (answer.id !== 1 || answer.result?.serverInfo?.name !== "clover" || code !== 0) {
      throw new Error(`${binary} bridge: exit ${code}, answered ${JSON.stringify(out.slice(0, 300))}${stderr ? `\n${stderr.slice(0, 2000)}` : ""}`);
    }
    return `bridge: ok (serverInfo ${answer.result.serverInfo.name}, MCP ${answer.result.protocolVersion})`;
  } finally {
    clearTimeout(timer);
  }
}

/** The environment a built binary's probes run with: a temp home, and none of a test's keychain variables (a release
 *  refuses them at startup, startup-guard.ts). */
function probeEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLOVER_HOME: home };
  for (const k of ["CLOVER_PROFILE", "CLOVER_KEYCHAIN_SERVICE", "CLOVER_TEST_KEYCHAIN", "WINTER_TEST_KEYCHAIN"]) delete env[k];
  return env;
}

/** `--version`, `__ffi-probe`, `bridge` and `__verify-feed` from the host binary, on a temp home. None reads a Keychain
 *  item, and a release refuses a test's keychain variables at startup (startup-guard.ts), so none is set. */
async function smoke(binary: string, version: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "clover-build-daemon-smoke-"));
  try {
    const env = probeEnv(home);
    const r = spawnSync(binary, ["--version"], { env, encoding: "utf8", timeout: 60_000 });
    const out = (r.stdout ?? "").trim();
    if (r.status !== 0 || out !== `clover ${version}`) {
      throw new Error(`${binary} --version: exit ${r.status ?? r.signal}, printed ${JSON.stringify(out)} (expected "clover ${version}")${r.stderr ? `\n${r.stderr.slice(0, 2000)}` : ""}`);
    }
    console.log(`build:daemon: smoke: ${out}`);
    // bun:ffi inside the compiled binary (the bridge's peer-pid check, the Keychain): the C library's pid is this one.
    const ffi = spawnSync(binary, ["__ffi-probe"], { env, encoding: "utf8", timeout: 60_000 });
    const ffiOut = (ffi.stdout ?? "").trim();
    if (ffi.status !== 0 || !/^ffi: ok/m.test(ffiOut) || !/^peer-pid: (ok|none on Windows)/m.test(ffiOut)) {
      throw new Error(`${binary} __ffi-probe: exit ${ffi.status ?? ffi.signal}, printed ${JSON.stringify(ffiOut)}${ffi.stderr ? `\n${ffi.stderr.slice(0, 2000)}` : ""}`);
    }
    for (const line of ffiOut.split("\n")) console.log(`build:daemon: smoke: ${line}`);
    console.log(`build:daemon: smoke: ${await smokeBridge(binary, env)}`);
    // The update feed's check is in the binary, and refuses a file whose signature isn't the feed key's.
    const feed = join(home, "latest.yml");
    writeFileSync(feed, "version: 0.0.0\nfiles: []\n");
    writeFileSync(`${feed}.sig`, Buffer.alloc(64).toString("base64"));
    const verified = spawnSync(binary, ["__verify-feed", feed], { env, encoding: "utf8", timeout: 60_000 });
    const verifiedOut = (verified.stdout ?? "").trim();
    if (verified.status !== 1 || !/^feed: refused \((no key|bad signature)\)$/.test(verifiedOut)) {
      throw new Error(`${binary} __verify-feed: exit ${verified.status ?? verified.signal}, printed ${JSON.stringify(verifiedOut)} (expected a refusal)`);
    }
    console.log(`build:daemon: smoke: ${verifiedOut} for a file the feed key didn't sign`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export async function main(argv: readonly string[], root: string): Promise<number> {
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
  // The bundled plugins' manifest: parsed (a bad one never ships), copied where the compile step embeds it, and
  // removed however the build ends.
  const embed = join(cliDir, ...MANIFEST_EMBED.split("/"));
  let expected = "0 files, sha256 none";
  let manifestBytes: Uint8Array | undefined;
  if (args.pluginsManifest !== undefined && !args.dryRun) {
    try {
      const text = readFileSync(args.pluginsManifest, "utf8");
      manifestBytes = new TextEncoder().encode(text);
      expected = `${Object.keys(parseBundledManifest(text).files).length} files, sha256 ${createHash("sha256").update(text).digest("hex")}`;
      mkdirSync(dirname(embed), { recursive: true });
      writeFileSync(embed, text);
    } catch (err) {
      console.error(`build:daemon: --plugins-manifest ${args.pluginsManifest}: ${(err as Error).message}`);
      return 1;
    }
  }
  try {
    return await buildTargets(args, root, cliDir, script, version, host, expected, manifestBytes);
  } finally {
    rmSync(embed, { force: true });
  }
}

/** The bundled-plugins manifest a built core carries, as its `__bundled-manifest` prints it ("<n> files, sha256 <hex>"). */
export function embeddedManifestLine(binary: string): string {
  const home = mkdtempSync(join(tmpdir(), "clover-build-daemon-manifest-"));
  try {
    const r = spawnSync(binary, ["__bundled-manifest"], { env: probeEnv(home), encoding: "utf8", timeout: 60_000 });
    const out = (r.stdout ?? "").trim();
    const m = /^bundled-manifest: (.*)$/.exec(out);
    if (r.status !== 0 || m === null) throw new Error(`${binary} __bundled-manifest: exit ${r.status ?? r.signal}, printed ${JSON.stringify(out)}${r.stderr ? `\n${r.stderr.slice(0, 2000)}` : ""}`);
    return m[1]!;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The fd-receiver Worker's probe (`__fd-receiver-probe`, no home, Keychain or daemon) on a built core: it starts
 *  only if the compiled entry `./fd-receiver-worker.ts` resolves, as the embedded chat Worker's does. Throws when not. */
export function workerEntryLine(binary: string): string {
  const home = mkdtempSync(join(tmpdir(), "clover-build-daemon-worker-"));
  try {
    const r = spawnSync(binary, ["__fd-receiver-probe"], { env: probeEnv(home), encoding: "utf8", timeout: 60_000 });
    const out = (r.stdout ?? "").trim().split("\n").at(-1) ?? "";
    let ok = false;
    try { ok = (JSON.parse(out) as { ok?: unknown }).ok === true; } catch { ok = false; }
    if (r.status !== 0 || !ok) throw new Error(`${binary} __fd-receiver-probe: exit ${r.status ?? r.signal}, printed ${JSON.stringify(out.slice(0, 300))}: a compiled Worker entry doesn't resolve (is compile:core's \`--root src\` still there?)`);
    return "Worker entries resolve (the fd-receiver probe's line came back)";
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** How many times `needle` occurs in `binary`: a cross-built core (which this machine can't run) must hold the
 *  manifest's exact bytes once (Bun stores an embedded file as it is). */
export function occurrences(binary: Uint8Array, needle: Uint8Array): number {
  const hay = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) n++;
  return n;
}

async function buildTargets(args: BuildDaemonArgs, root: string, cliDir: string, script: string, version: string, host: DaemonTarget | undefined, expected: string, manifestBytes: Uint8Array | undefined): Promise<number> {
  for (const target of args.targets) {
    const command = daemonCompileCommand(script, target, args.pluginsManifest !== undefined);
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
    // The seal (seal-bun-doors.ts): Bun's own doors to foreign code, closed before anything signs the binary.
    try {
      const sealed = sealFile(output);
      console.log(`build:daemon: ${target}: ${sealed === undefined ? "not sealed (Windows: no store there trusts a binary, scripts/seal-bun-doors.ts)" : `sealed ${Object.entries(sealed.sealed).map(([n, c]) => `${n}×${c}`).join(" ")}`}`);
    } catch (err) {
      console.error(`build:daemon: ${target}: ${(err as Error).message}`);
      return 1;
    }
    // The binaries that ship beside the core (scripts/bundled-binaries.ts): plain Bun for plugins, and on macOS lane
    // A's process holder, each under its own identifier.
    try {
      await stagePluginBun(target, join(dirname(output), bundledFiles(target)[0]!));
      if (target === "darwin-arm64") {
        if (process.platform !== "darwin") throw new Error(`${HOLDER_FILE} builds on macOS only`);
        buildHolder(root, join(dirname(output), HOLDER_FILE));
      }
      console.log(`build:daemon: ${target}: beside it ${bundledFiles(target).join(", ")}`);
    } catch (err) {
      console.error(`build:daemon: ${target}: ${(err as Error).message}`);
      return 1;
    }
    console.log(`build:daemon: ${target}: ${daemonOutput(target)} (${(statSync(output).size / 1_048_576).toFixed(1)} MB, sha256 ${sha256(output)})`);
    // The manifest the binary carries is the one given: the host's binary is asked (`__bundled-manifest`, which reads
    // it as the daemon does); a cross-built one, which this machine can't run, must hold the manifest's exact bytes
    // once.
    if (target !== host && manifestBytes !== undefined) {
      const n = occurrences(new Uint8Array(readFileSync(output)), manifestBytes);
      if (n !== 1) {
        console.error(`build:daemon: ${target}: the binary holds the bundled-plugins manifest ${n} times, not once`);
        return 1;
      }
      console.log(`build:daemon: ${target}: bundled-plugins manifest embedded (cross build: its ${manifestBytes.length} bytes found once; ${expected})`);
    }
    if (target === host) {
      try {
        const line = embeddedManifestLine(output);
        if (line !== expected) throw new Error(`the binary carries ${line}, not the bundled-plugins manifest given (${expected})`);
        console.log(`build:daemon: ${target}: bundled-plugins manifest: ${line}`);
        // The core's Worker entries resolve inside the binary that ships: an embedded file outside src/ once moved
        // every entry's name (Bun names entries by their common root; compile:core pins `--root src`).
        console.log(`build:daemon: ${target}: ${workerEntryLine(output)}`);
      } catch (err) {
        console.error(`build:daemon: ${target}: ${(err as Error).message}`);
        return 1;
      }
    }
    if (args.smoke && target === host) {
      try {
        await smoke(output, version);
      } catch (err) {
        console.error(`build:daemon: smoke failed: ${(err as Error).message}`);
        return 1;
      }
    }
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), join(dirname(fileURLToPath(import.meta.url)), "..")));
