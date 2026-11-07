/**
 * The DEV daemon: a compiled `clover-core` on the dev profile (`~/.clover-dev`, secret service
 * `com.waifucave.clover.core.dev`), on macOS, Linux and Windows.
 *
 *   bun run dev:daemon                     build, then `daemon run` on ~/.clover-dev (dev profile)
 *   bun run dev:daemon --dry-run [...]     print what the other flags would do, and stop: nothing built or started
 *
 * Every run but --dry-run also makes `dist/dev/clover-plugin-bun` when it's missing or the pinned Bun changed: a copy
 * of that Bun, ad-hoc signed on macOS as `com.waifucave.clover.plugin-bun.dev` (hardened runtime, bun-jit.entitlements),
 * which the dev daemon runs plugin code on, never on its own binary (#234's check 5).
 *   bun run dev:daemon --no-build          reuse dist/dev/clover-core (clover-core.exe on Windows) as it is
 *   bun run dev:daemon --transition        macOS: build, sign, then the ONE-TIME Keychain transition, then exit
 *   bun run dev:daemon <clover args>       run any other verb through the dev binary (e.g. `credentials list`)
 *   bun scripts/dev-daemon.ts --no-build --cli [args]   exactly `clover-core [args]` (no args = the TUI) —
 *                                          what the `clover-dev` wrapper runs, so it gets the pre-start check
 *
 * Build, every OS: `packages/cli`'s own `compile:core`, output redirected to a temp file beside the binary
 * (`dev-daemon-lib.ts`'s `devCompileCommand`), then an atomic rename to `dist/dev/` — never over the running dev
 * daemon's file in place, and never at `dist/clover-core`, which the `verify:*` gates rebuild. Linux and Windows
 * stop there: the binary is unsigned, and its secrets go to the Secret Service or Credential Manager under the dev
 * service, which no partition list guards.
 *
 * macOS also signs it (WS-27). Keychain items take their partition list from their CREATOR
 * (`auth/app-token-acl.ts`'s header). A dev daemon run as Homebrew `bun` creates its items as bun's team, so
 * Clover Dev is asked once per pairing token. A `clover-core` signed by Clover's team (`CLOVER_TEAM_ID`) under the
 * stable identifier `com.waifucave.clover.core.dev` creates them as Clover's team — Clover Dev (same team) reads
 * them silently — and its designated requirement, STATED at signing (`identifier "com.waifucave.clover.core.dev"
 * and anchor apple generic and certificate leaf[subject.OU] = "<team>"`, `dev-daemon-lib.ts`), survives every
 * rebuild and any Clover-team certificate. The signing is `codesign --identifier com.waifucave.clover.core.dev
 * --options runtime --entitlements scripts/clover-core.entitlements -r=<the stated requirement>` (the dist
 * posture: the hardened runtime needs allow-unsigned-executable-memory for bun:ffi), then a check of the
 * signature's team and the binary's own `__keychain-ffi-probe`, before the rename.
 *
 * Identity (macOS): `security find-identity -v -p codesigning`, the one whose certificate's OU is Clover's team
 * (Apple Development preferred over Developer ID Application), by hash. `CLOVER_DEV_SIGN_IDENTITY` overrides.
 *
 * Environment handed to the binary: `CLOVER_PROFILE=dev`, `CLOVER_HOME` (default `~/.clover-dev`; the dist
 * home and every other install's are refused), and — because a compiled binary can neither `require` its way to
 * the npm platform package nor search `$PATH` for `ant` — `CLOVER_RUNTIME_EXECUTABLE` and `CLOVER_ANT_EXECUTABLE`
 * resolved here under bun, unless already set.
 *
 * THE TRANSITION (macOS, `--transition`, once, with the dev daemon stopped): the existing dev items were created by
 * `bun`, and the compiled binary's first read of each would prompt. This script — running under `bun`, their
 * creator — reads each value and hands it over a pipe to `dist/dev/clover-core __dev-keychain-adopt`, which
 * re-creates the item as itself (shadow, delete, add, read back; `auth/dev-keychain-transition.ts`). It is
 * crash-safe and idempotent: if interrupted, run it again; until it has run, this script refuses to start the
 * signed binary on the default dev home. It is ONE-WAY: afterwards a `bun`-run dev CLI or
 * daemon is prompted for every item, so dev-profile commands go through the signed binary from then on.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOVER_TEAM_ID } from "../packages/core/src/auth/app-token-acl";
import { DEV_KEYCHAIN_SERVICE, oldCreatorStillOwnsItems, transitionDevKeychain } from "../packages/core/src/auth/dev-keychain-transition";
import { keychainUnlocked } from "../packages/core/src/auth/keychain-ffi";
import { isDefaultCloverHome } from "../packages/core/src/clover-dir";
import { resolvePlatformPackageWinter } from "../packages/core/src/runtime-sdk/executable";
import { runScriptLine } from "./build-daemon";
import { bunPinProblem } from "./bun-pin";
import { describeDevDaemonPlan, designatedRequirementOf, DEV_DAEMON_IDENTIFIER, DEV_PLUGIN_BUN_IDENTIFIER, devDaemonPlan, devDaemonRequirement, devPluginBunPath, devPluginBunSignArgs, devPluginBunStale, resolveDevSigningIdentity, signedFacts, type DevDaemonPlan } from "./dev-daemon-lib";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_DIR = join(REPO_ROOT, "packages", "cli");
const ENTITLEMENTS = join(REPO_ROOT, "scripts", "clover-core.entitlements");
const BUN_JIT_ENTITLEMENTS = join(REPO_ROOT, "scripts", "bun-jit.entitlements");

function die(message: string): never {
  console.error(`dev:daemon: ${message}`);
  process.exit(1);
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** macOS: sign the freshly compiled `tmp` as the dev daemon, and check it before it is moved into place. */
function signForKeychain(tmp: string): void {
  const identity = resolveDevSigningIdentity({
    identitiesOutput: run("security", ["find-identity", "-v", "-p", "codesigning"]).stdout,
    teamId: CLOVER_TEAM_ID,
    override: process.env.CLOVER_DEV_SIGN_IDENTITY,
    subjectOf: (name) => {
      const pem = run("security", ["find-certificate", "-c", name, "-p"]).stdout;
      if (pem === "") return undefined;
      const r = spawnSync("openssl", ["x509", "-noout", "-subject"], { input: pem, encoding: "utf8" });
      return r.status === 0 ? r.stdout : undefined;
    },
  });
  console.error(`dev:daemon: signing identity ${identity.name}`);
  const requirement = devDaemonRequirement(CLOVER_TEAM_ID);
  const signed = run("codesign", ["--force", "--sign", identity.hash, "--identifier", DEV_DAEMON_IDENTIFIER, "--options", "runtime", "--timestamp=none", "--entitlements", ENTITLEMENTS, `-r=designated => ${requirement}`, tmp]);
  if (signed.status !== 0) die(`codesign failed: ${signed.stderr.trim()}`);
  // The stated requirement is the one recorded, and the signature satisfies it.
  const shown = run("codesign", ["-d", "-r-", tmp]);
  const recorded = designatedRequirementOf(`${shown.stdout}\n${shown.stderr}`);
  if (recorded !== requirement) die(`the designated requirement did not take (recorded: ${recorded ?? "none"})`);
  const satisfied = run("codesign", ["--verify", "--strict", `-R=${requirement}`, tmp]);
  if (satisfied.status !== 0) die(`the signature does not satisfy ${requirement}: ${satisfied.stderr.trim()}`);
  const facts = signedFacts(run("codesign", ["-dv", tmp]).stderr);
  if (facts.teamId !== CLOVER_TEAM_ID || facts.identifier !== DEV_DAEMON_IDENTIFIER || !facts.runtime) {
    die(`the signature is not what the Keychain needs (team ${facts.teamId ?? "none"}, identifier ${facts.identifier ?? "none"}, hardened runtime ${facts.runtime}) — expected team ${CLOVER_TEAM_ID}, ${DEV_DAEMON_IDENTIFIER}`);
  }
  // The 0.120.0 regression class: bun:ffi under the hardened runtime. Loads the libraries, reads no item.
  const probe = run(tmp, ["__keychain-ffi-probe"]);
  if (probe.status !== 0) die(`the signed binary cannot run bun:ffi (__keychain-ffi-probe exit ${probe.status}): ${probe.stderr.trim().slice(0, 300)}`);
  console.error(`dev:daemon: signed (team ${facts.teamId}, ${facts.identifier}) — ${probe.stdout.trim()}`);
}

function build(build: NonNullable<DevDaemonPlan["build"]>, binary: string): void {
  const tmp = join(CLI_DIR, build.tmp);
  mkdirSync(dirname(binary), { recursive: true });
  try {
    console.error(`dev:daemon: compiling (compile:core → ${binary})…`);
    const status = runScriptLine(build.command, CLI_DIR);
    if (status !== 0 || !existsSync(tmp)) die(`compile failed (exit ${status})`);
    if (build.sign) signForKeychain(tmp);
    renameSync(tmp, binary);
    console.error(`dev:daemon: ${binary}${build.sign ? "" : " (unsigned)"}`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The plugin Bun the dev daemon runs plugin code on (#234's check 5): `dist/dev/clover-plugin-bun`, a copy of the
 *  pinned Bun this script runs on, ad-hoc signed on macOS as `com.waifucave.clover.plugin-bun.dev` (hardened runtime,
 *  `bun-jit.entitlements`), never the core's identity. Made again only when the pinned Bun changed (a stamp beside it
 *  holds the source's SHA-256), through a temp file and a rename, so a running plugin keeps its binary. */
function stagePluginBun(): void {
  const target = devPluginBunPath(REPO_ROOT);
  const stampFile = `${target}.source-sha256`;
  const source = realpathSync(process.execPath);
  const sourceHash = createHash("sha256").update(readFileSync(source)).digest("hex");
  let stamp: string | undefined;
  try {
    stamp = readFileSync(stampFile, "utf8");
  } catch {
    stamp = undefined;
  }
  if (!devPluginBunStale({ exists: existsSync(target), stamp, sourceHash })) return;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    copyFileSync(source, tmp);
    chmodSync(tmp, 0o755);
    if (process.platform === "darwin") {
      const signed = run("codesign", devPluginBunSignArgs(tmp, BUN_JIT_ENTITLEMENTS));
      if (signed.status !== 0) die(`codesign of the plugin Bun failed: ${signed.stderr.trim()}`);
      const facts = signedFacts(run("codesign", ["-dv", tmp]).stderr);
      if (facts.identifier !== DEV_PLUGIN_BUN_IDENTIFIER || !facts.runtime) die(`the plugin Bun's signature is not ${DEV_PLUGIN_BUN_IDENTIFIER} with the hardened runtime`);
    }
    const ran = run(tmp, ["--version"]);
    if (ran.status !== 0) die(`the plugin Bun doesn't run: ${ran.stderr.trim().slice(0, 300)}`);
    renameSync(tmp, target);
    writeFileSync(stampFile, `${sourceHash}\n`);
    console.error(`dev:daemon: ${target} (Bun ${ran.stdout.trim()}${process.platform === "darwin" ? `, ${DEV_PLUGIN_BUN_IDENTIFIER}` : ""})`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function devEnv(plan: DevDaemonPlan): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...plan.env };
  // A test preload's override has no business here (and a default home ignores it anyway).
  delete env.CLOVER_KEYCHAIN_SERVICE;
  if (!env.CLOVER_RUNTIME_EXECUTABLE) {
    const clover = resolvePlatformPackageWinter();
    if (clover !== undefined) env.CLOVER_RUNTIME_EXECUTABLE = clover;
    else console.error("dev:daemon: no `clover` runtime found (npm platform package) — code sessions will refuse until CLOVER_RUNTIME_EXECUTABLE is set");
  }
  if (!env.CLOVER_ANT_EXECUTABLE) {
    const ant = Bun.which("ant");
    if (ant !== null) env.CLOVER_ANT_EXECUTABLE = ant;
  }
  return env;
}

async function main(): Promise<void> {
  // `bun run` itself swallows the first `--`.
  const pkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as { scripts: Record<string, string> };
  let plan: DevDaemonPlan;
  try {
    plan = devDaemonPlan({ argv: process.argv.slice(2), env: process.env, platform: process.platform, compileCoreScript: pkg.scripts["compile:core"] ?? "", pid: process.pid });
  } catch (err) {
    die((err as Error).message);
  }
  if (plan.dryRun) {
    for (const line of describeDevDaemonPlan(plan)) console.log(line);
    process.exit(0);
  }
  // release.ts's check: the dev daemon is compiled by, and runs on, the Bun CI tests (`.bun-version`).
  const pin = bunPinProblem(REPO_ROOT);
  if (pin !== null) die(`${pin} — run it with the pinned Bun: scripts/pinned-bun run dev:daemon`);
  const binary = join(REPO_ROOT, ...plan.binary.split("/"));
  const home = plan.home;
  if (plan.build !== undefined) build(plan.build, binary);
  if (!existsSync(binary)) die(`${binary} does not exist — run without --no-build`);
  // Plugin code never runs on the core's binary: its own Bun, beside it (with --no-build too, when it's missing).
  stagePluginBun();
  const env = devEnv(plan);

  if (plan.transition) {
    console.error(`dev:daemon: moving the dev Keychain items (${home}) from bun to ${binary} — the dev daemon must be stopped`);
    let outcome;
    try {
      outcome = await transitionDevKeychain({ binary, home, env, log: (line) => console.error(`  ${line}`) });
    } catch (err) {
      die(`transition refused: ${(err as Error).message}`);
    }
    if (outcome.kind === "stopped") die(`transition stopped at ${outcome.account} (${outcome.reason}); ${outcome.adopted.length} adopted so far — run it again`);
    console.error(`dev:daemon: transition done — ${outcome.adopted.length} adopted, ${outcome.skipped.length} left as they were${outcome.skipped.length > 0 ? ` (${outcome.skipped.join(", ")})` : ""}${outcome.restored.length > 0 ? `, ${outcome.restored.length} restored from an earlier run` : ""}`);
    process.exit(0);
  }

  // macOS, before the transition: every item on the dev home is bun's, and the signed binary's first read of each
  // would prompt: refuse and say what to run. (Only the default dev home holds the dev service's items.)
  if (plan.os === "macos" && isDefaultCloverHome(home, "dev") && keychainUnlocked(null) && oldCreatorStillOwnsItems({ keychain: null, service: DEV_KEYCHAIN_SERVICE })) {
    die("the dev Keychain items still belong to bun — stop any bun-run dev daemon, then run `bun run dev:daemon --transition` once");
  }

  const child = spawn(binary, plan.args, { stdio: "inherit", env });
  const signals = process.platform === "win32" ? (["SIGINT", "SIGTERM"] as const) : (["SIGINT", "SIGTERM", "SIGHUP"] as const);
  for (const sig of signals) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
  child.on("close", (code, signal) => process.exit(code ?? (signal !== null ? 1 : 0)));
}

await main();
