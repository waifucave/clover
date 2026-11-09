/**
 * The DEV daemon: a compiled `clover-core` on the dev profile (`~/.clover-dev`, secret service
 * `com.waifucave.clover.core.dev`), on macOS, Linux and Windows.
 *
 *   bun run dev:daemon                     build, then `daemon run` on ~/.clover-dev (dev profile)
 *   bun run dev:daemon --dry-run [...]     print what the other flags would do, and stop: nothing built or started
 *
 * Every run but --dry-run also makes `<dev home>/bin/clover-plugin-bun` when it's missing, the pinned Bun changed, or
 * the copy there isn't the one recorded: a copy of that Bun, ad-hoc signed on macOS as
 * `com.waifucave.clover.plugin-bun.dev` (hardened runtime, bun-jit.entitlements), its digest recorded beside it, which
 * the dev daemon runs plugin code on, never on its own binary (#234's checks 5 and 6).
 *   bun run dev:daemon --no-build          reuse dist/dev/clover-core (clover-core.exe on Windows) as it is
 *   bun run dev:daemon --transition        macOS: build, sign, then the ONE-TIME Keychain transition, then exit
 *   bun run dev:daemon <clover args>       run any other verb through the dev binary (e.g. `credentials list`)
 *   bun scripts/dev-daemon.ts --no-build --cli [args]   exactly `clover-core [args]` (no args = the TUI) —
 *                                          what the `clover-dev` wrapper runs, so it gets the pre-start check
 *
 * Build, every OS: `packages/cli`'s own `compile:core`, output redirected to a temp file beside the binary
 * (`dev-daemon-lib.ts`'s `devCompileCommand`), sealed like a release (`seal-bun-doors.ts`: Bun's BUN_BE_BUN,
 * BUN_OPTIONS, BUN_INSPECT* and NODE_PATH doors closed; without the dist define, so the env overrides of the runtime
 * ladder still work here), then an atomic rename to `dist/dev/` — never over the running dev
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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOVER_TEAM_ID } from "../packages/core/src/auth/app-token-acl";
import { DEV_KEYCHAIN_SERVICE, oldCreatorStillOwnsItems, transitionDevKeychain } from "../packages/core/src/auth/dev-keychain-transition";
import { keychainUnlocked } from "../packages/core/src/auth/keychain-ffi";
import { isDefaultCloverHome } from "../packages/core/src/clover-dir";
import { pluginBunDigest } from "../packages/core/src/registry/plugin-run";
import { resolvePlatformPackageWinter } from "../packages/core/src/runtime-sdk/executable";
import { hostTarget, runScriptLine } from "./build-daemon";
import { BUNDLED_IDENTIFIERS, buildHolder, HOLDER_FILE, holderSource, PLUGIN_BUN_ENTITLEMENTS } from "./bundled-binaries";
import { LINK_BUILD, LINK_OUTPUT } from "./build-packages";
import { DYLD_ENTITLEMENT, sealFile } from "./seal-bun-doors";
import { bunPinProblem } from "./bun-pin";
import { describeDevDaemonPlan, designatedRequirementOf, DEV_DAEMON_IDENTIFIER, DEV_LINK_IDENTIFIER, DEV_PLUGIN_BUN_IDENTIFIER, devDaemonPlan, devDaemonRequirement, devLinkSidecarPlan, devPluginBunPath, devPluginBunSignArgs, devPluginBunStale, resolveDevSigningIdentity, signedFacts, type DevDaemonPlan } from "./dev-daemon-lib";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_DIR = join(REPO_ROOT, "packages", "cli");
const ENTITLEMENTS = join(REPO_ROOT, "scripts", "clover-core.entitlements");

function die(message: string): never {
  console.error(`dev:daemon: ${message}`);
  process.exit(1);
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function devSigningIdentity(): { name: string; hash: string } {
  return resolveDevSigningIdentity({
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
}

/** macOS: sign the freshly compiled `tmp` as the dev daemon, and check it before it is moved into place. */
function signForKeychain(tmp: string): void {
  const identity = devSigningIdentity();
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
  // The macOS seal (`DYLD_*` names, seal-bun-doors.ts) holds only under the hardened runtime (checked above) and with
  // no allow-dyld-environment-variables entitlement.
  const ents = run("codesign", ["-d", "--entitlements", "-", "--xml", tmp]);
  if (`${ents.stdout}${ents.stderr}`.includes(DYLD_ENTITLEMENT)) die(`the signed dev daemon carries ${DYLD_ENTITLEMENT}, which would open its seal`);
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
    // The same seal as a release (seal-bun-doors.ts), before the signature the dev Keychain items trust.
    try {
      sealFile(tmp);
    } catch (err) {
      die((err as Error).message);
    }
    if (build.sign) signForKeychain(tmp);
    renameSync(tmp, binary);
    console.error(`dev:daemon: ${binary}${build.sign ? "" : " (unsigned)"}`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The plugin Bun the dev daemon runs plugin code on (#234's checks 5 and 6): `<dev home>/bin/clover-plugin-bun`, inside
 *  the home no runner writes, a copy of the pinned Bun this script runs on, ad-hoc signed on macOS as
 *  `com.waifucave.clover.plugin-bun.dev` (hardened runtime, the release copy's `clover-plugin-bun.entitlements`, so a
 *  plugin's native addon or FFI runs in dev as it does shipped), never the core's identity. Its digest
 *  (macOS: its cdhash) goes beside it as `clover-plugin-bun.digest`, which the daemon's `pluginBun()` checks on start and
 *  whenever the file changes. Made again when the pinned Bun changed (a source stamp beside it) or the copy there isn't
 *  the one recorded (swapped), through a temp file and a rename, so a running plugin keeps its binary. */
function stageDevPluginBun(home: string): void {
  const target = devPluginBunPath(home);
  const stampFile = `${target}.source-sha256`;
  const digestFile = `${target}.digest`;
  const source = realpathSync(process.execPath);
  const sourceHash = createHash("sha256").update(readFileSync(source)).digest("hex");
  const read = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };
  const exists = existsSync(target);
  if (!devPluginBunStale({ exists, stamp: read(stampFile), sourceHash, recordedDigest: read(digestFile), actualDigest: exists ? pluginBunDigest(target) : undefined })) return;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    copyFileSync(source, tmp);
    chmodSync(tmp, 0o755);
    if (process.platform === "darwin") {
      const signed = run("codesign", devPluginBunSignArgs(tmp, join(REPO_ROOT, PLUGIN_BUN_ENTITLEMENTS)));
      if (signed.status !== 0) die(`codesign of the plugin Bun failed: ${signed.stderr.trim()}`);
      const facts = signedFacts(run("codesign", ["-dv", tmp]).stderr);
      if (facts.identifier !== DEV_PLUGIN_BUN_IDENTIFIER || !facts.runtime) die(`the plugin Bun's signature is not ${DEV_PLUGIN_BUN_IDENTIFIER} with the hardened runtime`);
    }
    const ran = run(tmp, ["--version"]);
    if (ran.status !== 0) die(`the plugin Bun doesn't run: ${ran.stderr.trim().slice(0, 300)}`);
    renameSync(tmp, target);
    const digest = pluginBunDigest(target);
    if (digest === undefined) die(`the plugin Bun at ${target} has no digest to record (its signature doesn't verify)`);
    writeFileSync(digestFile, `${digest}\n`, { mode: 0o600 });
    writeFileSync(stampFile, `${sourceHash}\n`, { mode: 0o600 });
    console.error(`dev:daemon: ${target} (Bun ${ran.stdout.trim()}, ${digest}${process.platform === "darwin" ? `, ${DEV_PLUGIN_BUN_IDENTIFIER}` : ""})`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Lane A's process holder beside the dev core (macOS; scripts/bundled-binaries.ts), signed with the dev identity under
 * its own `.dev` identifier, never the dev core's, which the dev Keychain items trust. Plugin Bun's dev copy is lane
 * B's step. A dev build without the holder's source (an agent runtime before SDK 0.0.70) says so and goes on: commands
 * fall back to process-group tracking, which a packaged build never does (its package gate).
 */
async function buildBundled(dir: string, sign: boolean): Promise<void> {
  stageLinkSidecar(join(dir, "clover-core"), sign, true);
  if (hostTarget() !== "darwin-arm64") return;
  if (holderSource(REPO_ROOT) === undefined) {
    console.error(`dev:daemon: no ${HOLDER_FILE} (the installed agent runtime has no native/process-holder.c before SDK 0.0.70): a bot's commands fall back to process-group tracking`);
    return;
  }
  const holder = join(dir, HOLDER_FILE);
  buildHolder(REPO_ROOT, holder);
  if (sign) {
    const identity = devSigningIdentity();
    const r = run("codesign", ["--force", "--sign", identity.hash, "--identifier", BUNDLED_IDENTIFIERS[HOLDER_FILE].dev, "--options", "runtime", "--timestamp=none", holder]);
    if (r.status !== 0) die(`codesign of ${holder} failed: ${r.stderr.trim()}`);
  }
  console.error(`dev:daemon: beside it ${holder}${sign ? ` (${BUNDLED_IDENTIFIERS[HOLDER_FILE].dev})` : ""}`);
}

/**
 * Lane H's link sidecar beside the dev core, so the dev daemon pairs and links like a packaged one: built with cargo for
 * this machine and signed (macOS) with the dev identity under its own `.dev` identifier. Without cargo it says so and
 * goes on: the dev daemon then runs local-only (its links on no other device), which a packaged build never does. With
 * `--no-build` nothing is built: an existing build is copied and signed, or it says there is none.
 */
function stageLinkSidecar(binary: string, sign: boolean, build: boolean): void {
  const plan = devLinkSidecarPlan({ repoRoot: REPO_ROOT, binary, linkBuild: LINK_BUILD, linkOutput: LINK_OUTPUT });
  if (build) {
    const cargo = Bun.which("cargo") ?? (existsSync(join(homedir(), ".cargo", "bin", "cargo")) ? join(homedir(), ".cargo", "bin", "cargo") : null);
    if (cargo === null) {
      console.error("dev:daemon: no cargo, so no clover-link beside the dev core: it runs local-only, without links to other devices");
      return;
    }
    console.error("dev:daemon: building the link sidecar (clover-link)…");
    const built = run(cargo, plan.cargoArgs, { cwd: REPO_ROOT });
    if (built.status !== 0 || !existsSync(plan.from)) die(`the link sidecar didn't build (exit ${built.status}): ${built.stderr.trim().split("\n").slice(-3).join(" ")}`);
  } else if (!existsSync(plan.from)) {
    console.error(`dev:daemon: no built clover-link at ${plan.from} (--no-build builds none), so ${existsSync(plan.to) ? `the one already beside the dev core stays` : "the dev core runs local-only, without links to other devices"}`);
    return;
  }
  // Beside the dev core, by a rename, so a running dev daemon's sidecar is never written in place.
  const tmp = `${plan.to}.tmp-${process.pid}`;
  copyFileSync(plan.from, tmp);
  chmodSync(tmp, 0o755);
  if (sign && plan.sign) {
    const identity = devSigningIdentity();
    const r = run("codesign", ["--force", "--sign", identity.hash, "--identifier", DEV_LINK_IDENTIFIER, "--options", "runtime", "--timestamp=none", tmp]);
    if (r.status !== 0) {
      rmSync(tmp, { force: true });
      die(`codesign of clover-link failed: ${r.stderr.trim()}`);
    }
  }
  renameSync(tmp, plan.to);
  console.error(`dev:daemon: beside it ${plan.to}${sign && plan.sign ? ` (${DEV_LINK_IDENTIFIER})` : ""}`);
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
  if (plan.build !== undefined) {
    build(plan.build, binary);
    await buildBundled(dirname(binary), plan.build.sign);
  }
  if (!existsSync(binary)) die(`${binary} does not exist — run without --no-build`);
  // --no-build: the sidecar as last built, copied and signed (macOS, as a build signs), never built here.
  if (plan.build === undefined) stageLinkSidecar(binary, process.platform === "darwin", false);
  // Plugin code never runs on the core's binary: its own Bun, beside it (with --no-build too, when it's missing).
  stageDevPluginBun(home);
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
