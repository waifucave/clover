/**
 * The compiled-binary proof that the Cowork native channel's receiver thread starts in the SHIPPED `clover-core`.
 *
 * `fd-channel.ts` serves every launcher channel from ONE Bun Worker. In dev it builds the Worker from an absolute source URL; in a compiled binary it must use the plain relative
 * string `./fd-receiver-worker.ts` (a `new URL(...).href` hangs silently, WS-23 spike #1), which resolves only if `packages/cli/src/fd-receiver-worker.ts` was passed to
 * `compile:core` as a third entrypoint. `bun test` only runs the dev path, so nothing but the real artifact notices that missing.
 *
 *   1. `compile:core` -> dist/clover-core (all three entrypoints).
 *   2. A copy in a throwaway directory, ad-hoc signed the way the Release app signs clover-core (hardened runtime + scripts/clover-core.entitlements).
 *   3. `<copy> __fd-receiver-probe` from that directory, with a narrow environment and a temp CLOVER_HOME: socketpair, one line through the receiver hub, expect the line back.
 *   3b. `<copy> __host-code-adapter-probe`: the host-code broker's SDK modules resolve INSIDE the built binary (`installedHostCodeAdapter()` does not throw "Cannot find module").
 *       Same safety: no home, Keychain, daemon or launcher.
 *   3c. `<copy> __host-env-lazy-probe`: the activation seam's lazy `require("./host-env/environment")` resolves INSIDE the built binary (the seam stays off; the module loads, nothing is built).
 *   3d. (#234's checks 4 and 5) The release-shaped binary has no `__plugin-run-probe` route (`compile:core` defines `CLOVER_PLUGIN_RUN_PROBE=false`, and the route's code is
 *       not in it). A second build with the define true, with a dev `clover-plugin-bun` in the temp home's bin (a copy of this Bun, ad-hoc signed as
 *       `com.waifucave.clover.plugin-bun.dev`, its digest recorded beside it as dev:daemon records it), runs `<copy> __plugin-run-probe <empty folder>`: `pluginBun()` accepts that copy, and
 *       a plugin host started the supervisor's way runs on `clover-plugin-bun`, never on clover-core, as Bun (its `Bun.main` is
 *       the host's entry), without the `BUN_BE_BUN` it was handed, with the load guard preloaded (no `ShadowRealm`), and an outside import is refused and never runs.
 *       Same safety: the scratch folder only.
 *   4. The negative control: the same probe against a copy of the binary whose Worker entry cannot be found must NOT print ok. (Checked without rebuilding: the probe is run with the
 *      entry string patched in the copy to a name that does not exist.)
 *
 *   bun run verify:fd-receiver
 *
 * Standalone, never part of `bun test`. The probe touches no home, no Keychain, no daemon and no launcher, and the script never runs anything but the temp copy.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_BUN_IDENTIFIER as PLUGIN_BUN_IDENTIFIERS } from "../packages/core/src/bundled-identities";
import { pluginBunDigest } from "../packages/core/src/registry/plugin-run";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_BINARY = join(REPO_ROOT, "dist", "clover-core");
const ENTITLEMENTS = join(REPO_ROOT, "scripts", "clover-core.entitlements");
const COMPILE_TIMEOUT_MS = 180_000, PROBE_TIMEOUT_MS = 30_000;
const CLI_DIR = join(REPO_ROOT, "packages", "cli");
const BUN_JIT_ENTITLEMENTS = join(REPO_ROOT, "scripts", "bun-jit.entitlements");
/** The plugin Bun's dev signing identifier (`bundled-identities.ts`): never clover-core's. */
const PLUGIN_BUN_IDENTIFIER = PLUGIN_BUN_IDENTIFIERS.dev;
/** Strings only the plugin-run probe's code holds: absent from a release-shaped build. */
const PROBE_MARKERS = ["__plugin-run-probe", "the probe needs an absolute path to an empty scratch folder"];
export const ENTRY_NAME = "./fd-receiver-worker.ts";

/** The probe's one JSON line, or undefined. */
export function parseProbe(stdout: string): { ok: boolean; line?: string; error?: string } | undefined {
  for (const raw of stdout.split("\n")) {
    const text = raw.trim();
    if (!text.startsWith("{")) continue;
    try { const value = JSON.parse(text); if (typeof value?.ok === "boolean") return value; } catch { /* not the line */ }
  }
  return undefined;
}

/** A copy of the binary whose receiver entry string names a file that is not embedded (same length, so the executable layout is untouched). Null when the entry string is absent. */
export function withBrokenEntry(binary: Uint8Array): Buffer | null {
  const needle = Buffer.from(ENTRY_NAME), replacement = Buffer.from("./fd-receiver-wxrker.ts");
  const bytes = Buffer.from(binary);
  let at = bytes.indexOf(needle), count = 0;
  while (at >= 0) { replacement.copy(bytes, at); count += 1; at = bytes.indexOf(needle, at + needle.length); }
  return count > 0 ? bytes : null;
}

function runChild(binary: string, args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env, cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve({ code: null, stdout, stderr: `${stderr}\n(timed out after ${PROBE_TIMEOUT_MS} ms)` }); }, PROBE_TIMEOUT_MS);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function sign(path: string): void {
  const result = spawnSync("codesign", ["--force", "--sign", "-", "--options", "runtime", "--entitlements", ENTITLEMENTS, path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`codesign of ${path} failed: ${(result.stderr ?? "").trim()}`);
}

async function main(): Promise<void> {
  console.log("=== compiled-binary proof: the Cowork channel's receiver thread ===");
  const compile = spawnSync(process.execPath, ["run", "--filter", "@waifucave/clover-cli", "compile:core"], { cwd: REPO_ROOT, encoding: "utf8", timeout: COMPILE_TIMEOUT_MS });
  if (compile.status !== 0) throw new Error(`compile:core failed:\n${compile.stdout ?? ""}\n${compile.stderr ?? ""}`);
  if (!existsSync(DIST_BINARY)) throw new Error(`compile:core reported success but ${DIST_BINARY} was not produced`);
  const scratch = mkdtempSync(join(tmpdir(), "clover-fd-receiver-proof-"));
  try {
    const home = join(scratch, "home"); mkdirSync(home);
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? homedir(), CLOVER_HOME: home, CLOVER_PROFILE: "dev", CLOVER_KEYCHAIN_SERVICE: "com.waifucave.clover.core.test-isolated", CLOVER_LOGIN_SHELL_PATH: "off" };
    const good = join(scratch, "clover-core");
    copyFileSync(DIST_BINARY, good); chmodSync(good, 0o755); sign(good);
    const run = await runChild(good, ["__fd-receiver-probe"], env, scratch);
    const result = parseProbe(run.stdout);
    if (run.code !== 0 || result?.ok !== true) throw new Error(`the compiled daemon's receiver thread did not start (exit ${run.code}): ${JSON.stringify(result)}\n${run.stderr.trim()}`);
    console.log(`ok: the probe line came back through the receiver hub (${JSON.stringify(result)})`);

    const adapter = await runChild(good, ["__host-code-adapter-probe"], env, scratch);
    const adapterResult = parseProbe(adapter.stdout);
    if (adapter.code !== 0 || adapterResult?.ok !== true) throw new Error(`the host-code broker's modules do not resolve inside the compiled daemon (exit ${adapter.code}): ${JSON.stringify(adapterResult)}\n${adapter.stderr.trim()}`);
    console.log(`ok: installedHostCodeAdapter() ran in the compiled daemon (${JSON.stringify(adapterResult)})`);

    const lazy = await runChild(good, ["__host-env-lazy-probe"], env, scratch);
    const lazyResult = parseProbe(lazy.stdout);
    if (lazy.code !== 0 || lazyResult?.ok !== true) throw new Error(`the lazy host-env require does not resolve inside the compiled daemon (exit ${lazy.code}): ${JSON.stringify(lazyResult)}\n${lazy.stderr.trim()}`);
    console.log(`ok: the activation seam's lazy host-env require resolved in the compiled daemon (${JSON.stringify(lazyResult)})`);

    const release = readFileSync(DIST_BINARY);
    const leaked = PROBE_MARKERS.filter((m) => release.includes(Buffer.from(m)));
    if (leaked.length > 0) throw new Error(`the release-shaped clover-core carries the plugin-run probe (${leaked.join(", ")}): CLOVER_PLUGIN_RUN_PROBE=false no longer removes it`);
    console.log("ok: the release-shaped binary has no plugin-run probe route");

    const probeDir = join(scratch, "probe-build"); mkdirSync(probeDir);
    const script = (JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["compile:core"] ?? "";
    if (!script.includes("--define CLOVER_PLUGIN_RUN_PROBE=false") || !script.includes("--outfile ../../dist/clover-core")) throw new Error("compile:core no longer has the probe define or its outfile — update this gate");
    const probeBuild = script.replace("--define CLOVER_PLUGIN_RUN_PROBE=false", "--define CLOVER_PLUGIN_RUN_PROBE=true").replace("--outfile ../../dist/clover-core", `--outfile ${JSON.stringify(join(probeDir, "clover-core"))}`);
    const built = spawnSync("sh", ["-c", probeBuild], { cwd: CLI_DIR, encoding: "utf8", timeout: COMPILE_TIMEOUT_MS, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` } });
    if (built.status !== 0) throw new Error(`the probe build failed:\n${built.stdout ?? ""}\n${built.stderr ?? ""}`);
    const probeCore = join(probeDir, "clover-core"); chmodSync(probeCore, 0o755); sign(probeCore);
    // The dev profile's plugin Bun (the gate runs the core as dev): in the temp home's bin, signed under its own dev
    // identifier, its digest recorded beside it the way dev:daemon records it (#234's check 6, L2).
    const pluginBun = join(home, "bin", "clover-plugin-bun"); mkdirSync(dirname(pluginBun), { recursive: true });
    copyFileSync(realpathSync(process.execPath), pluginBun); chmodSync(pluginBun, 0o755);
    const signed = spawnSync("codesign", ["--force", "--sign", "-", "--identifier", PLUGIN_BUN_IDENTIFIER, "--options", "runtime", "--entitlements", BUN_JIT_ENTITLEMENTS, pluginBun], { encoding: "utf8" });
    if (signed.status !== 0) throw new Error(`codesign of ${pluginBun} failed: ${(signed.stderr ?? "").trim()}`);
    const digest = pluginBunDigest(pluginBun);
    if (digest === undefined) throw new Error(`no digest for ${pluginBun}`);
    writeFileSync(`${pluginBun}.digest`, `${digest}\n`);
    const pluginScratch = join(scratch, "plugin-run"); mkdirSync(pluginScratch);
    const pluginRun = await runChild(probeCore, ["__plugin-run-probe", pluginScratch], env, scratch);
    const pluginResult = parseProbe(pluginRun.stdout);
    if (pluginRun.code !== 0 || pluginResult?.ok !== true) throw new Error(`a plugin host did not run guarded on clover-plugin-bun inside the compiled core (exit ${pluginRun.code}): ${JSON.stringify(pluginResult)}\n${pluginRun.stderr.trim()}`);
    console.log(`ok: a plugin host ran on clover-plugin-bun, not clover-core, without BUN_BE_BUN, guarded, its outside import refused (${JSON.stringify(pluginResult)})`);

    const broken = withBrokenEntry(readFileSync(DIST_BINARY));
    if (broken === null) throw new Error(`the binary does not contain the entry string ${ENTRY_NAME}: fd-channel.ts does not use the compiled entry`);
    const bad = join(scratch, "clover-core-broken");
    writeFileSync(bad, broken); chmodSync(bad, 0o755); sign(bad);
    const negative = await runChild(bad, ["__fd-receiver-probe"], env, scratch);
    if (parseProbe(negative.stdout)?.ok === true) throw new Error("negative control failed: a binary without the worker entry still passed the probe, so the probe proves nothing");
    console.log("ok: the negative control (entry renamed in a copy) is refused by the same probe");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) main().catch((error) => { console.error(`verify:fd-receiver: ${(error as Error).message}`); process.exit(1); });
