#!/usr/bin/env bun
// The macOS acceptance run: "usable" means this passes. One command, two targets:
//
//   scripts/pinned-bun scripts/acceptance/run.ts                      this checkout: the daemon from source, the
//                                                                     desktop app built here, headless
//   scripts/pinned-bun scripts/acceptance/run.ts --app <Clover.app>   a packaged app (a try build): its own daemon
//                                                                     and its own app, headless
//   --keep-logs <dir>   copy the run's logs there before the temp folder goes (the logs hold no key)
//   --verbose           print each step's progress
//   --keep-state <dir>  leave the run's home, user home and throwaway keychain file in <dir> (new or empty; short, as
//                       the daemon's socket goes under it), with state.json naming its keychain service, dummy key,
//                       conversation, plugin and setting (state.ts)
//   --upgrade-from <dir> an UPGRADE: start on the home, user home and keychain file a --keep-state run left, in place,
//                       and run the upgrade steps instead (the app first, then the daemon; the old key, conversation,
//                       plugin, fence, bundled tools and setting). scripts/acceptance/upgrade.ts runs the pair.
//   --skip-web-turns    don't run the WebSearch/WebFetch turns (a tree whose daemon has no fake web seam)
//   --no-press          answer every card over RPC, none by a real press (an older build that can't draw a card's
//                       fallback offscreen; the upgrade's first half on such a build)
//
// The steps, each PASS, FAIL or BLOCKED with the first failing call and, where it can tell, the file and line:
//   1. first start: the app pairs and finishes its setup
//   2. a model key is added through the app's own methods (models.list, plugin.auth.*): a dummy key, for a fake
//      provider on 127.0.0.1 that speaks Anthropic's wire format
//   3. a bot turn gets the fake's reply
//   4. a plugin installs from a local folder, and its OK card is shown and approved as the app would
//   5. the bot calls that plugin's MCP tool
//   6. a fenced file write raises an approval card, the app answers, and the write lands
//   7. the daemon restarts on the same home and boots
//   8 on (UI_STEPS). the window itself, over the DevTools protocol, on the restarted daemon (ui-steps.ts): drag the title area,
//      type in the composer and send and read the reply, pick a model, open Settings, change a setting and reopen it.
//      The source app takes the DevTools port behind CLOVER_DEV_DEBUG=1; a packaged one only if it is test-marked
//      (CLOVER_TEST_DEBUG=1, loopback), and any other build refuses it (debug-guard.ts), so those steps are BLOCKED.
//   then: each boot lists the bundled web tools; the bot's WebSearch reaches the fake search backend; the bot's
//      WebFetch reads a fake public page and is refused a private address; and last, the cold start
// It ends with a table, and exits 1 on any FAIL or BLOCKED.
//
// What it never does: no window, no Dock icon, no TCC prompt (the app runs `--clover-headless`, Chromium on its mock
// keychain); no real key and no real provider call (the only key is a random dummy, the only provider the fake); no
// home but a temp one (`CLOVER_HOME`, and `HOME` for every process it starts); no keychain but a throwaway FILE,
// never added to the search list (checked before and after). Every process it starts runs in its own process group
// and is ended, and the temp folder and the keychain file are deleted, on every way out.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, closeSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLOVER_PROTOCOL_VERSION } from "../../packages/protocol/src/index";
import { TEST_KEYCHAIN_PASSWORD } from "../../packages/core/src/auth/login-keychain";
import { HARNESS_TOKEN_FILE } from "../../packages/core/src/platform/pair/run-files";
import { USAGE_INERT_ENV } from "../../packages/core/src/usage/wiring";
import { CloverClient, RpcError, hello } from "./client";
import { startFakeAnthropic, type FakeProvider } from "./fake-anthropic";
import { Cdp } from "./cdp";
import { shellDoc, dumpFrames, treeText, UI_STEPS, uiSteps } from "./ui-steps";
import { DISTRUST, answerKeyFileFor, keepStateProblem, readState, settingsWithFake, socketPathProblem, statePaths, writeState, type KeptState } from "./state";
import { FAKE_ARTICLE_TEXT, FAKE_PRIVATE_ADDRESS, FAKE_PRIVATE_SITE, FAKE_PUBLIC_SITE, FAKE_SEARCH_HIT } from "./fake-exa";

const REPO = resolve(import.meta.dir, "..", "..");
const DESKTOP = join(REPO, "apps", "desktop");

// ── arguments ────────────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const appBundle = flag("--app");
const keepLogs = flag("--keep-logs");
const verbose = argv.includes("--verbose");
// --cold-start N: only the cold-start step, N times (the app opens first, the daemon after). --cold-home <dir>: starts it on a copy
// of a home an earlier build made (an upgrade).
const coldStartRuns = Number(flag("--cold-start") ?? 0);
const coldOnly = coldStartRuns > 0;
const coldHome = flag("--cold-home");
const keepState = flag("--keep-state");
const upgradeFrom = flag("--upgrade-from");
const upgrade = upgradeFrom !== undefined;
const skipWebTurns = argv.includes("--skip-web-turns");
// --no-press: the cards are answered over RPC only (an older build whose app can't draw a card offscreen for the press,
// as the upgrade's first half runs).
const pressing = !argv.includes("--no-press");
for (const f of ["--keep-state", "--upgrade-from"]) {
  if (argv.includes(f) && (flag(f) === undefined || flag(f)!.startsWith("--"))) { console.error(`acceptance: ${f} takes a dir`); process.exit(2); }
}
if (keepState !== undefined && upgrade) { console.error("acceptance: --keep-state and --upgrade-from are two runs, not one (scripts/acceptance/upgrade.ts runs the pair)"); process.exit(2); }
if (upgrade && (coldOnly || coldHome !== undefined)) { console.error("acceptance: --upgrade-from runs its own cold start; it takes no --cold-start or --cold-home"); process.exit(2); }
if (keepState !== undefined && (coldOnly || coldHome !== undefined)) { console.error("acceptance: --keep-state keeps a full run's state; it takes no --cold-start or --cold-home"); process.exit(2); }
if (process.platform !== "darwin") {
  console.error("acceptance: this run is macOS only for now");
  process.exit(2);
}
if (appBundle !== undefined && !existsSync(join(appBundle, "Contents", "Info.plist"))) {
  console.error(`acceptance: ${appBundle} isn't an app bundle`);
  process.exit(2);
}
const target = appBundle === undefined ? "source" : "packaged";
const bundleId = appBundle === undefined ? undefined : /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(appBundle, "Contents", "Info.plist"), "utf8"))?.[1];
const profile: "dev" | "dist" = target === "source" || (bundleId ?? "").endsWith(".dev") ? "dev" : "dist";
/** The state an earlier --keep-state run left (an upgrade). */
let kept: KeptState | undefined;
const stateDir = keepState ?? upgradeFrom;
{
  const problem = keepState !== undefined ? keepStateProblem(keepState) : undefined;
  if (problem !== undefined) { console.error(`acceptance: ${problem}`); process.exit(2); }
  if (upgradeFrom !== undefined) {
    try { kept = readState(upgradeFrom); } catch (err) { console.error(`acceptance: --upgrade-from: ${err instanceof Error ? err.message : String(err)}`); process.exit(2); }
    if (kept!.target !== target) { console.error(`acceptance: --upgrade-from: the state was made by a ${kept!.target} run, and this one is ${target}`); process.exit(2); }
  }
  const tooLong = stateDir === undefined ? undefined : socketPathProblem(statePaths(stateDir).home);
  if (tooLong !== undefined) { console.error(`acceptance: ${tooLong}`); process.exit(2); }
}

// ── the result table ─────────────────────────────────────────────────────────────────────────────────────────────
type Status = "PASS" | "FAIL" | "BLOCKED";
interface Row { n: number; name: string; status: Status; detail: string }
/** The reopen steps (try 9's blocker: quit, reopen a few seconds later, stuck on "Starting Clover…"): the app quits the
 *  way the owner's does while a turn runs, and opens again. Each fails on a window that never fills. */
const REOPEN_STEPS = [
  { name: "reopen 0 s after quitting mid-turn: the window fills, and the interrupted turn shows as such", delayMs: 0 },
  { name: "reopen 2 s after quitting mid-turn: the window fills, and the interrupted turn shows as such", delayMs: 2_000 },
  { name: "reopen 5 s after quitting mid-turn: the window fills, and the interrupted turn shows as such", delayMs: 5_000 },
  { name: "reopen while the old daemon is still going (held 8 s): the window fills once it has gone", delayMs: 0, holdMs: 8_000 },
  { name: "a stale socket and core.lock with no daemon: the app has one started, and the window fills", stale: true },
] as const;

const FULL_STEPS = [
  "first start: the app pairs and finishes setup",
  "a model key added through the app's methods",
  "a bot turn gets the fake provider's reply",
  "a plugin installs from a folder, its OK card approved",
  "the bot calls the plugin's MCP tool",
  "a fenced write raises an approval card, then lands",
  "the daemon restarts on the same home and boots",
  ...UI_STEPS.map((s) => `window: ${s}`),
  "after quit and reopen: the app registers the same answer key, and a card's Approve is pressed in the window",
  ...REOPEN_STEPS.map((s) => s.name),
  "each boot lists the bundled web tools within 5 s and offers them; an installed plugin's server lists too",
  "the bot's WebSearch reaches the fake search backend; nothing leaves the machine",
  "the bot's WebFetch reads a public page (network:public) and is refused a private address",
  "cold start: the app opens first, the daemon after, and the shell fills the window",
] as const;

/** The upgrade run's steps (--upgrade-from), in the order they run. */
const UPGRADE_STEPS = [
  "upgrade cold start: the app opens first on the old home, the daemon after, and the shell fills the window",
  "the old run's model key works with no re-entry",
  "the old conversation is listed and opens in the window",
  "a new turn runs on the upgraded home",
  "the old run's plugin is still installed and its tool answers, with no new OK card",
  "a fenced write still raises an approval card, then lands",
  "the bundled web tools and the old plugin's server list within 5 s, and the first turn offers them",
  "a setting the old run changed is still set",
  "the daemon trusts the state the old build signed (plugin registry, device key)",
] as const;
const STEPS: readonly string[] = upgrade ? UPGRADE_STEPS : FULL_STEPS;
const TOTAL = STEPS.length;
const rows: Row[] = [];
const say = (line: string): void => { if (verbose) console.error(`acceptance: ${line}`); };
const record = (n: number, status: Status, detail: string): void => {
  rows.push({ n, name: STEPS[n - 1]!, status, detail: detail.replace(/\s+/g, " ").trim().slice(0, 600) });
  say(`step ${n}: ${status}: ${detail}`);
};
class StepFail extends Error {}
/** A step the run can't drive on this target (it says what it would need). */
class StepBlocked extends StepFail {}
const fail = (detail: string): never => { throw new StepFail(detail); };
const block = (detail: string): never => { throw new StepBlocked(detail); };
const statusOf = (err: unknown): Status => (err instanceof StepBlocked ? "BLOCKED" : "FAIL");
const why = (err: unknown): string => (err instanceof StepFail ? err.message : err instanceof RpcError ? `${err.message}${whereOf(err)}` : err instanceof Error ? err.message : String(err));
/** The daemon's "not served yet" and similar errors name no file; these point at where each is answered. */
function whereOf(err: RpcError): string {
  if (/is not served yet/.test(err.message)) return " [packages/core/src/ipc/clover.ts: no handler registered for the method]";
  return "";
}

// ── the temp world ───────────────────────────────────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "clv-acc-"));
// A --keep-state or --upgrade-from run keeps the home, the user home and the keychain file in its state dir; the rest
// (logs, TMPDIR, the stub, a packaged core's copy) stays in the temp folder and goes.
const kept_ = stateDir === undefined ? undefined : statePaths(stateDir);
const home = kept_?.home ?? join(root, "home");
const userHome = kept_?.user ?? join(root, "user");
const logs = join(root, "logs");
const keychain = kept_?.keychain ?? join(root, "kc", "acceptance.keychain-db");
const answerKeyFile = answerKeyFileFor(keychain);
const stubBin = join(root, "bin", "clover-core-stub");
for (const d of [home, userHome, logs, dirname(keychain), dirname(stubBin)]) mkdirSync(d, { recursive: true, mode: 0o700 });
const service = kept?.service ?? `com.waifucave.clover.core.test.acceptance-${randomBytes(4).toString("hex")}`;
const dummyKey = kept?.key ?? `sk-ant-acceptance-dummy-${randomBytes(12).toString("hex")}`;
// An upgrade writes a file of its own: the old run's is already there.
const writePath = join(userHome, "acceptance", upgrade ? `written-upgrade-${randomBytes(3).toString("hex")}.txt` : "written.txt");
const writeContent = `acceptance-write-${randomBytes(4).toString("hex")}\n`;

// A daemon binary the app finds instead of a real one (`CLOVER_DAEMON_BIN`, honoured by a dev or unpackaged app): any
// login-item or start the app tries fails here, so it never registers anything with launchd.
writeFileSync(stubBin, "#!/bin/sh\necho 'acceptance: the app tried to start a daemon through the OS' >&2\nexit 1\n", { mode: 0o700 });
// The reopen steps' stand-in for the OS's launcher (source target): the app's `autostart status|enable|start` as the
// daemon binary answers them, where `start` only asks the run (a line in launch-requests) and the run starts the core
// when, and only when, no daemon of its is running: as launchd starts the job only once the old process has gone.
const launchRequests = join(root, "launch-requests");
const standInBin = join(root, "bin", "clover-core-launch-stand-in");
writeFileSync(standInBin, `#!/bin/sh
case "$1 $2" in
  "autostart status") echo '{"registered":true,"running":false}' ;;
  "autostart enable") echo "autostart: registered (stand-in)" ;;
  "autostart start") date +%s >> ${JSON.stringify(launchRequests)}; echo "autostart: start asked (stand-in: the acceptance run starts the core)" ;;
  *) echo "acceptance: the stand-in launcher doesn't do $1 $2" >&2; exit 1 ;;
esac
`, { mode: 0o700 });

const children: { name: string; proc: ChildProcess }[] = [];
let fake: FakeProvider | undefined;
const clients: CloverClient[] = [];
let keychainsBefore = "";
/** What a --keep-state run leaves in state.json besides the keychain service and the key. */
const keptFacts: Pick<KeptState, "session" | "pluginId" | "needsYou" | "needsYouMissing"> = {};
let keychainMade = false;

function listKeychains(): string {
  const r = spawnSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: userHome,
    TMPDIR: join(root, "tmp"),
    LANG: "en_US.UTF-8",
    CLOVER_HOME: home,
    // The source target is a dev build; a packaged one runs as the profile its bundle id names (a dist-signed try
    // build must pass the dist app's caller check, not the dev app's).
    ...(profile === "dev" ? { CLOVER_PROFILE: "dev" } : {}),
    CLOVER_KEYCHAIN_SERVICE: service,
    CLOVER_TEST_KEYCHAIN: keychain,
    // The test app's answer key, kept beside the keychain file (a test-marked or unpackaged headless app only): every
    // app of the run, and an upgrade's, registers the same key.
    CLOVER_TEST_ANSWER_KEY: answerKeyFile,
  };
}
mkdirSync(join(root, "tmp"), { recursive: true, mode: 0o700 });

function startChild(name: string, cmd: string, args: string[], env: Record<string, string>, cwd = REPO): { proc: ChildProcess; log: string } {
  const log = join(logs, `${name}.log`);
  const fd = openSync(log, "a");
  const proc = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  children.push({ name, proc });
  return { proc, log };
}

function alive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

async function endChild(proc: ChildProcess, graceMs = 10_000): Promise<void> {
  if (proc.pid === undefined || !alive(proc)) return;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ }
  const t = setTimeout(() => { try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* gone */ } }, graceMs);
  await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs + 2_000))]);
  clearTimeout(t);
  // Anything the child left in its group.
  try { process.kill(-proc.pid, "SIGKILL"); } catch { /* none */ }
}

let cleaned = false;
/** The run itself is stopping the daemon (step 7, cleanup), so its exit isn't a crash. */
let stoppingDaemon = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  stoppingDaemon = true;
  for (const c of clients) c.close();
  pressCdp?.close();
  // The app first (so the daemon never sees it go and starts another), then the daemon.
  for (const c of [...children].reverse().sort((a, b) => Number(b.name === "app") - Number(a.name === "app"))) await endChild(c.proc);
  fake?.close();
  if (keepLogs !== undefined) {
    try { mkdirSync(keepLogs, { recursive: true }); cpSync(logs, keepLogs, { recursive: true }); } catch { /* best effort */ }
    // The app's own log (<home>/logs/app.log and its .1) lives in the run's temp home, which is deleted below.
    for (const f of ["app.log", "app.log.1"]) {
      try { cpSync(join(home, "logs", f), join(keepLogs, f)); } catch { /* not written, or best effort */ }
    }
  }
  // A kept keychain file stays for the upgrade run (its state dir's owner deletes it); a run's own goes.
  if (keychainMade && stateDir === undefined) spawnSync("security", ["delete-keychain", keychain], { stdio: "ignore" });
  if (keepState !== undefined) {
    try {
      writeState(keepState, { v: 1, made: appBundle ?? (spawnSync("git", ["rev-parse", "--short=9", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout ?? "").trim(), target, service, key: dummyKey, ...keptFacts, answerKeyKept: existsSync(answerKeyFile) });
    } catch (err) { console.error(`acceptance: the state file couldn't be written: ${err instanceof Error ? err.message : String(err)}`); }
  }
  rmSync(root, { recursive: true, force: true });
}
const onSignal = (sig: string) => { console.error(`acceptance: ${sig}: cleaning up`); void cleanup().then(() => process.exit(130)); };
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGHUP", () => onSignal("SIGHUP"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined> | T | undefined, everyMs = 300): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) fail(`${what}: not within ${Math.round(timeoutMs / 1000)} s`);
    await sleep(everyMs);
  }
}
const readLog = (path: string): string => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
/** The first line of a log matching `re`, cut short (the logs carry no key: the daemon never logs one). */
const firstLine = (path: string, re: RegExp): string | undefined => readLog(path).split("\n").find((l) => re.test(l))?.slice(0, 400);

// ── setup ────────────────────────────────────────────────────────────────────────────────────────────────────────
function makeKeychain(): void {
  keychainsBefore = listKeychains();
  // An upgrade opens the file the earlier run made; it is never made again here.
  if (upgrade) {
    if (!existsSync(keychain)) throw new Error(`${keychain} isn't there: the earlier run's keychain file is gone`);
    return;
  }
  // The tests' fixed password (packages/core/src/auth/login-keychain.ts): it guards nothing, the file is the run's own.
  const made = spawnSync("security", ["create-keychain", "-p", TEST_KEYCHAIN_PASSWORD, keychain], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`security create-keychain failed: ${(made.stderr ?? "").trim().slice(0, 200)}`);
  keychainMade = true;
  // No auto-lock for the run; the file is never added to the search list.
  spawnSync("security", ["set-keychain-settings", keychain], { stdio: "ignore" });
  if (listKeychains() !== keychainsBefore) throw new Error("the keychain search list changed when the throwaway keychain was made");
}

/** The settings the run starts from: Anthropic's endpoint is the fake (the user's own `providers.<id>.baseUrl`). */
function writeSettings(fakeUrl: string): void {
  const file = join(home, "settings.json");
  // An earlier build's settings (an upgrade, a cold home) are kept: only the endpoint moves to this run's fake.
  writeFileSync(file, settingsWithFake(existsSync(file) ? readFileSync(file, "utf8") : undefined, fakeUrl), { mode: 0o600 });
}

/** From source, the dev bundled plugins are built into the home first: a daemon on a test keychain service doesn't
 *  build them itself (packages/core/src/daemon.ts, `stageBundled`). */
async function buildBundledPlugins(): Promise<void> {
  const r = spawnSync(process.execPath, ["-e", `
    const { buildDevBundledPlugins } = await import(${JSON.stringify(join(REPO, "packages/core/src/registry/bundled-stage.ts"))});
    const { readdirSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sources = ${JSON.stringify(join(REPO, "plugins"))};
    const ids = readdirSync(sources).filter((id) => existsSync(join(sources, id, "clover.json"))).sort();
    const built = await buildDevBundledPlugins({ sources, ids, cloverHome: ${JSON.stringify(home)} });
    console.log("built " + built.built.join(","));
  `], { cwd: REPO, env: baseEnv(), encoding: "utf8", timeout: 600_000 });
  writeFileSync(join(logs, "bundled-build.log"), `${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (r.status !== 0) throw new Error(`building the dev bundled plugins failed (logs/bundled-build.log): ${(r.stderr ?? "").trim().split("\n").pop()?.slice(0, 300)}`);
}

/** The desktop app built from this checkout, and its Electron binary. Always rebuilt: an apps/desktop/out left from an
 *  earlier build would test stale code (a run after a source change once "passed" on the old app). */
function sourceApp(): { exe: string; args: string[] } {
  {
    console.error(`acceptance: building apps/desktop from this checkout (always, for the source target)${existsSync(join(DESKTOP, "out", "main", "index.js")) ? "; the earlier build in apps/desktop/out is replaced" : ""}`);
    const heavy = join(REPO, "scripts", "heavy");
    // The source acceptance's own build (--acceptance: what only this run uses is compiled in); an older tree's build
    // script (the upgrade's first half) doesn't take the flag, and guards those paths at run time instead.
    const own = readFileSync(join(DESKTOP, "scripts", "build.ts"), "utf8").includes('"--acceptance"') ? ["--acceptance"] : [];
    const r = spawnSync(existsSync(heavy) ? heavy : process.execPath, existsSync(heavy) ? [process.execPath, "run", "build", ...own] : ["run", "build", ...own], { cwd: DESKTOP, encoding: "utf8", timeout: 900_000 });
    writeFileSync(join(logs, "desktop-build.log"), `${r.stdout ?? ""}${r.stderr ?? ""}`);
    if (r.status !== 0) throw new Error("building apps/desktop failed (logs/desktop-build.log)");
  }
  const req = createRequire(join(DESKTOP, "package.json"));
  const pkgDir = dirname(req.resolve("electron/package.json"));
  if (!existsSync(join(pkgDir, "path.txt"))) {
    // bun's install doesn't run electron's postinstall, which fetches the binary (or takes it from electron's cache).
    say("fetching the Electron binary (electron/install.js)");
    const r = spawnSync(process.execPath, [join(pkgDir, "install.js")], { cwd: pkgDir, encoding: "utf8", timeout: 600_000 });
    if (r.status !== 0 || !existsSync(join(pkgDir, "path.txt"))) throw new Error(`electron's install.js failed: ${(r.stderr ?? "").trim().slice(0, 300)}`);
  }
  const exe = join(pkgDir, "dist", readFileSync(join(pkgDir, "path.txt"), "utf8").trim());
  return { exe, args: [DESKTOP] };
}

function packagedApp(bundle: string): { exe: string; args: string[] } {
  const plist = readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");
  const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (name === undefined) throw new Error("the bundle's Info.plist names no executable");
  return { exe: join(bundle, "Contents", "MacOS", name), args: [] };
}

/** The packaged core, copied out with the bundled plugins beside it as the bundle lays them out
 *  (`<…>/Resources/daemon/clover-core`, `<…>/Resources/plugins`; packages/core/src/bundled-plugins-dir.ts). Run from
 *  inside the bundle, a core with no app connected within 2 s starts the bundle through `open -n -g -a`
 *  (packages/core/src/platform/pair/launch.ts), a second, windowed app on this screen; from the copy it finds no
 *  bundle and runs alone, and the headless app connects to it. The binary is the bundle's, byte for byte. */
function packagedCore(): string {
  const res = join(root, "pkg", "Resources");
  if (!existsSync(join(res, "daemon"))) {
    mkdirSync(res, { recursive: true, mode: 0o700 });
    cpSync(join(appBundle!, "Contents", "Resources", "daemon"), join(res, "daemon"), { recursive: true, verbatimSymlinks: true });
    const plugins = join(appBundle!, "Contents", "Resources", "plugins");
    if (existsSync(plugins)) cpSync(plugins, join(res, "plugins"), { recursive: true, verbatimSymlinks: true });
  }
  return join(res, "daemon", "clover-core");
}

/** The ruling for a packaged run: only a test-marked core, which takes the test variables and refuses to start without
 *  them. A release core is never started: it would want the account's real home and write to the login keychain. */
function checkTestBuild(): string {
  const core = join(appBundle!, "Contents", "Resources", "daemon", "clover-core");
  if (!existsSync(core)) return `${core} isn't there`;
  const r = spawnSync(core, ["--version"], { env: baseEnv(), encoding: "utf8", timeout: 30_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0]?.slice(0, 200) ?? "";
  return /test build/i.test(out) ? "" : `its core's --version doesn't say "test build" (${out || `exit ${r.status}`}): the packaged run takes only a test-marked try build, never a release`;
}

/** The packaged driver speaks as the CLI (`cli` role): the caller check takes an `app` hello only from the signed app,
 *  and the run doesn't override it. Its harness token comes from run/harness.token, which only a test-marked core
 *  writes (0600, beside app.token). The run NEVER reads the run's keychain file with `bun` in packaged mode: the signed
 *  test core made that item, its access list trusts only that core, and another program's read would put a keychain
 *  prompt on the screen (the first packaged run's incident). */
function harnessToken(): string {
  const file = join(home, "run", HARNESS_TOKEN_FILE);
  // Written just after app.token at the core's start: a moment's grace, then a clear failure.
  for (let i = 0; i < 50 && !existsSync(file); i++) Bun.sleepSync(100);
  if (!existsSync(file)) throw new Error(`${file} isn't there: the packaged run needs a test-marked core that writes the harness token to run/ (int/try-6's test build); it never reads the keychain file instead`);
  const token = readFileSync(file, "utf8").trim();
  if (token === "") throw new Error(`${file} is empty`);
  return token;
}

// ── the daemon ───────────────────────────────────────────────────────────────────────────────────────────────────
let daemonRun = 0;
let lastDaemon: { proc: ChildProcess; log: string } | undefined;
async function startDaemonProc(extraEnv: Record<string, string> = {}): Promise<{ proc: ChildProcess; log: string }> {
  daemonRun++;
  // Usage-inert, both targets (the compiled core honours the same variables): no daemon of the run reads or runs the
  // user's own Codex, Claude Code, Antigravity or OpenCode, nor the plan beat.
  const env = { ...baseEnv(), ...USAGE_INERT_ENV, ...extraEnv, CLOVER_ACCEPTANCE_RUN_PID: String(process.pid), CLOVER_ACCEPTANCE_USER_HOME: userHome };
  let started: { proc: ChildProcess; log: string };
  if (target === "source") {
    started = startChild(`daemon-${daemonRun}`, process.execPath, [join(REPO, "scripts", "acceptance", "daemon.ts")], env);
  } else {
    // The bundle's own test-marked core, with no override of its caller check: the same temp home and throwaway
    // keychain file as the source target, nothing else.
    const { CLOVER_ACCEPTANCE_RUN_PID: _pid, CLOVER_ACCEPTANCE_USER_HOME: _user, ...packagedEnv } = env;
    started = startChild(`daemon-${daemonRun}`, packagedCore(), ["daemon", "run"], packagedEnv);
  }
  const socket = join(home, "run", "core.sock");
  const tokenFile = join(home, "run", "app.token");
  await until("the daemon's socket and app token", 120_000, async () => {
    if (!alive(started.proc)) fail(`the daemon exited (${started.proc.exitCode ?? started.proc.signalCode}): ${lastLines(started.log)}`);
    if (!existsSync(socket) || !existsSync(tokenFile)) return undefined;
    try { (await CloverClient.connect(socket, 1_000)).close(); return true; } catch { return undefined; }
  }, 500);
  lastDaemon = started;
  // A registry the run holds shut (the cold starts' delay) lists nothing before it opens: the wait starts there.
  watchBundledListing(daemonRun, started.log, Number(extraEnv.CLOVER_ACCEPTANCE_REGISTRY_DELAY_MS ?? 0) || 0);
  return started;
}

// ── the bundled MCP servers at each boot (the last step) ────────────────────────────────────────────────────────
// A bundled `host` MCP server that should be up lists its tools within seconds of the daemon's start: the web plugin's
// (`clover/web`, WebSearch and WebFetch; the browser's is per-computer and starts only where a computer ticks it), or
// it says at once why it can't work in this build (`not served: …`: its tools need net.fetch, which can't cross the
// plugin host yet; packages/core/src/contracts/plugin-host.ts NET_FETCH_CROSSES_PLUGIN_HOST). A turn waits at most
// MCP_FIRST_LISTING_WAIT_MS (packages/core/src/runtime-sdk/turn-loop/plugin-mcp.ts) for a first listing, so later
// than that, the first turns go without the tools. The daemon logs each listing (`plugin MCP <plugin>/<server>: listed
// …`), each server not served, and each failure.
const BUNDLED_MCP_WAIT_MS = 5_000;
const BUNDLED_LISTED = /\[plugins\] plugin MCP clover\/web\/web: (listed \d+ tool\(s\): [^\n]*|not served: [^\n]*)/;
// Any plugin's host server whose listing failed, or whose worker went under it, fails the step. And a served server
// that runs a worker must list in time too: the web one isn't started while it isn't served, so the plugin step 4
// installs (acceptance-echo, no network) stands for every served one on the boots after its install.
const BUNDLED_FAILED = /\[plugins\] plugin MCP [^:\n]*: (?:its tools couldn't be listed|its plugin's worker went)[^\n]*/;
const ECHO_LISTED = /\[plugins\] plugin MCP acceptance-echo\/echo: listed \d+ tool\(s\)/;
const bundledBoots: { run: number; log: string; listed?: string; ms?: number; echoMs?: number; graceMs: number; waited?: Promise<void> }[] = [];
/** Requests the fake had when each daemon started: the turns after it are that boot's. */
const requestsAtBoot: number[] = [];
function watchBundledListing(run: number, log: string, graceMs = 0): void {
  // The clock starts when the registry may open: at once, or after the run's own hold on it.
  const t0 = Date.now() + graceMs;
  requestsAtBoot[run] = fake?.requests.length ?? 0;
  const boot: (typeof bundledBoots)[number] = { run, log, graceMs };
  boot.waited = (async () => {
    for (;;) {
      const text = readLog(log);
      const m = text.match(BUNDLED_LISTED);
      if (m && boot.listed === undefined) {
        boot.listed = m[1]!.trim();
        boot.ms = Date.now() - t0;
      }
      if (boot.echoMs === undefined && ECHO_LISTED.test(text)) boot.echoMs = Date.now() - t0;
      // The first boot of a full run has no plugin yet; an upgrade's first boot has the old run's.
      if ((boot.listed !== undefined && ((run === 1 && !upgrade) || boot.echoMs !== undefined)) || Date.now() - t0 >= BUNDLED_MCP_WAIT_MS) {
        // Listed while the registry was still held: no time after its opening.
        if (boot.ms !== undefined && boot.ms < 0) boot.ms = 0;
        if (boot.echoMs !== undefined && boot.echoMs < 0) boot.echoMs = 0;
        return;
      }
      await sleep(200);
    }
  })();
  bundledBoots.push(boot);
}

/** The web plugin's tools as a session names them today: each bundled server under its own name (spec §5.3's
 *  mcp__clover__… waits on the agent runtime, which keeps `clover` for its standing server). */
const WEB_SEARCH_TOOL = "mcp__web__WebSearch";
const WEB_FETCH_TOOL = "mcp__web__WebFetch";
/** Step 15's outcome, from its two turns on the first daemon. */
let fetchOutcome: { status: Status; detail: string } | undefined;
/** Step 14's outcome, from its turn on the first daemon. */
let searchOutcome: { status: Status; detail: string } | undefined;
/** What the acceptance daemon logs when its keyed fetch seam refuses a host (scripts/acceptance/daemon.ts). */
const NETWORK_REFUSED = /acceptance daemon: net\.fetch to [^\n]* refused[^\n]*/;

/** Step 14: the search turn's outcome, and no daemon of the run reached for any other host. */
function searchStep(): void {
  const n = TOTAL - 2; // the WebSearch step: two before the cold start
  try {
    for (const b of bundledBoots) {
      const refused = readLog(b.log).match(NETWORK_REFUSED)?.[0];
      if (refused !== undefined) fail(`daemon ${b.run}: ${refused.slice(0, 300)}`);
    }
    if (searchOutcome === undefined) fail("the search turn didn't run");
    if (searchOutcome!.status !== "PASS") return record(n, searchOutcome!.status, searchOutcome!.detail);
    record(n, "PASS", `${searchOutcome!.detail}; no daemon reached any other host`);
  } catch (err) {
    record(n, statusOf(err), why(err));
  }
}

/** Three before the last step: every boot settled the web server in time (listed, or not served with its reason), none logged a
 *  bundled server's failed listing, and each boot's first turn offered the web tools exactly when they were listed. */
async function bundledMcpStep(n = TOTAL - 3 /* the bundled-tools step: three before the cold start */): Promise<void> {
  try {
    await Promise.all(bundledBoots.map((b) => b.waited));
    if (bundledBoots.length === 0) fail("no daemon started");
    for (const b of bundledBoots) {
      const failed = readLog(b.log).match(BUNDLED_FAILED)?.[0];
      if (failed !== undefined) fail(`daemon ${b.run}: ${failed.slice(0, 400)}`);
      const settled = b.listed ?? fail(`daemon ${b.run}: clover/web/web neither listed its tools nor said why it isn't served within ${BUNDLED_MCP_WAIT_MS / 1000} s of ${b.graceMs > 0 ? `the registry opening (the run holds it ${b.graceMs / 1000} s after the socket answers)` : "the socket answering"} [packages/core/src/runtime-sdk/turn-loop/plugin-mcp.ts]`);
      const listed = settled.startsWith("listed ");
      // net.fetch crosses the plugin host (packages/core/src/contracts/plugin-host.ts NET_FETCH_CROSSES_PLUGIN_HOST):
      // the web server is offered, never "not served".
      if (!listed) fail(`daemon ${b.run}: clover/web/web ${settled.slice(0, 300)} (net.fetch crosses the plugin host now: it must be listed and offered)`);
      if (!/\bWebSearch\b/.test(settled) || !/\bWebFetch\b/.test(settled)) fail(`daemon ${b.run}: clover/web/web ${settled}, not WebSearch and WebFetch`);
      // A boot after the plugin's install (daemon 1 listed it once installed): its server lists within the time too.
      // An upgrade's boot has the old run's plugin from the start.
      const installed = upgrade || ECHO_LISTED.test(readLog(bundledBoots[0]!.log));
      if ((b.run > 1 || upgrade) && installed && b.echoMs === undefined) fail(`daemon ${b.run}: acceptance-echo/echo, installed before this boot, didn't list its tools within ${BUNDLED_MCP_WAIT_MS / 1000} s of ${b.graceMs > 0 ? "the registry opening" : "the socket answering"}`);
      const first = (fake?.requests ?? []).slice(requestsAtBoot[b.run] ?? 0).find((r) => r.path.endsWith("/messages") && r.keyMatched);
      if (first === undefined) continue; // no turn on this boot
      // Offered under their exact names.
      const web = first.tools.filter((t) => /(^|__)Web(Search|Fetch)$/.test(t));
      const named = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL].every((t) => first.tools.includes(t));
      if (listed && !named) fail(`daemon ${b.run}: the web tools were listed, but its first turn's request didn't offer ${WEB_SEARCH_TOOL} and ${WEB_FETCH_TOOL} (web tools: ${web.join(", ") || "none"}; tools: ${first.tools.join(", ").slice(0, 300)})`);
      if (!listed && web.length > 0) fail(`daemon ${b.run}: the web server isn't served, yet its first turn offered ${web.join(", ")}`);
    }
    record(n, "PASS", bundledBoots.map((b) => `daemon ${b.run}: clover/web/web ${b.listed!.slice(0, 120)} (${((b.ms ?? 0) / 1000).toFixed(1)} s)${b.echoMs === undefined ? "" : `, acceptance-echo/echo listed (${(b.echoMs / 1000).toFixed(1)} s)`}${b.graceMs > 0 ? ` after the registry opened (held ${b.graceMs / 1000} s)` : ""}`).join("; "));
  } catch (err) {
    record(n, statusOf(err), why(err));
  }
}
const lastLines = (log: string, n = 3): string => readLog(log).trim().split("\n").slice(-n).join(" | ").slice(0, 500);

/** The run's own connection: the app's role from source (the daemon's test seam takes the run's pid), the CLI's on a
 *  packaged core. */
async function appDriver(): Promise<{ client: CloverClient; result: Record<string, unknown> }> {
  const role = target === "source" ? "app" : "cli";
  const token = role === "app" ? readFileSync(join(home, "run", "app.token"), "utf8").trim() : harnessToken();
  const d = await hello(join(home, "run", "core.sock"), role, token, "clover-acceptance", CLOVER_PROTOCOL_VERSION);
  clients.push(d.client);
  d.client.onNotification((method, params) => {
    const p = params as { type?: string; card?: Card } | null;
    if (method === "core.event" && p?.type === "card_requested" && p.card !== undefined) raised.push(p.card);
  });
  return d;
}

// ── the session helpers ──────────────────────────────────────────────────────────────────────────────────────────
type Ev = Record<string, unknown> & { type?: string; seq?: number };
async function history(c: CloverClient, id: string): Promise<Ev[]> {
  const r = await c.request<{ events: Ev[] }>("session.history", { id, limit: 500 });
  return r.events;
}

/** Fails the step when the fake refused a request since `asked` with the 400 the real API gives (a request that
 *  breaks a documented rule), even when the SDK then retried without the feature and the turn ended well. */
function refusedSince(asked: number): void {
  const refused = (fake?.requests ?? []).slice(asked).find((r) => r.answered === "400");
  if (refused !== undefined) fail(`the provider would refuse a request of this turn (400): ${refused.refused}`);
}

/** Cards the daemon announced to the run's connection (`card_requested`), for a daemon whose `card.list` isn't served. */
const raised: Card[] = [];

interface Turn { events: Ev[]; cards: string[]; changes: string[] }
/** Sends the user's message and waits for its turn to end; gives back the events after it, and the cards the turn
 *  raised, each answered yes as the app would (a card nobody answers holds the turn until it is withdrawn), with each
 *  change card's subject (`changes`, e.g. `bot-provider`). */
async function turn(c: CloverClient, session: string, text: string, timeoutMs = 120_000, o: { press?: boolean | { cdp: Cdp; log: string } } = {}): Promise<Turn> {
  const known = new Set([...(await cards(c).catch(() => [])), ...raised].map((k) => k.id));
  const sent = await c.request<{ seq: number }>("session.send", { id: session, message: { text, clientMessageId: randomUUID() } }, 30_000);
  const asked = fake?.requests.length ?? 0;
  const seenCards: string[] = [];
  const changes: string[] = [];
  let last: Ev[] = [];
  try {
    const events = await until(`the turn after "${text.slice(0, 40)}" to end`, timeoutMs, async () => {
      const after = (await history(c, session)).filter((e) => typeof e.seq === "number" && e.seq > sent.seq);
      last = after;
      const listed = await cards(c).catch(() => undefined);
      for (const card of [...(listed ?? []), ...raised]) {
        if (known.has(card.id) || (card.session !== undefined && card.session !== session)) continue;
        known.add(card.id);
        if (card.change !== undefined) changes.push(card.change);
        try {
          // A turn that presses (step 6's write) presses its cards in the window, the real way; the rest are answered
          // over RPC.
          if (o.press !== undefined && o.press !== false) {
            const by = o.press === true ? (pressCdp === undefined ? undefined : { cdp: pressCdp, log: join(logs, "app.log") }) : o.press;
            if (by === undefined) fail("the first app has no DevTools connection (step 1), so the card can't be pressed the real way");
            await pressApprove(by!.cdp, card, by!.log);
            seenCards.push(`a ${card.kind} card, its Approve pressed in the window (the app signed, the broker checked the proof)`);
            continue;
          }
          await approve(c, card);
          seenCards.push(`a ${card.kind}${card.change !== undefined ? ` (${card.change})` : ""} card, approved`);
        } catch (err) {
          seenCards.push(`a ${card.kind} card that the run couldn't answer (${why(err)})`);
          // A card the app was never told of fails the step at once (`appGotCard`), as a blocked one does.
          if (err instanceof StepBlocked || err instanceof StepFail) throw err;
        }
      }
      return after.some((e) => e.type === "turn_completed") ? after : undefined;
    }, 500);
    refusedSince(asked);
    return { events, cards: seenCards, changes };
  } catch (err) {
    if (err instanceof StepBlocked) throw err;
    refusedSince(asked);
    // What the session showed, the cards it raised, and whether the provider was asked at all.
    const types = [...new Set(last.map((e) => String(e.type)))].join(", ") || "no event after the message";
    fail(`${why(err)} (events: ${types}; ${seenCards.length ? `${seenCards.join("; ")}; ` : ""}${(fake?.requests.length ?? 0) - asked} request(s) reached the fake)`);
  }
  return { events: [], cards: [], changes: [] };
}
const errorsOf = (events: Ev[]): string[] => events.filter((e) => e.type === "agent_error" || e.type === "error").map((e) => String(e.message ?? e.error ?? JSON.stringify(e)).slice(0, 300));
const stopOf = (events: Ev[]): string => String(events.find((e) => e.type === "turn_completed")?.stopReason ?? "?");

// ── the cards ────────────────────────────────────────────────────────────────────────────────────────────────────
type Card = { id: string; hash: string; kind: string; change?: string; session?: string; pluginId?: string; options: { id: string; kind: string }[]; children?: { id: string; checked: boolean }[]; fields?: Record<string, unknown> };
/** The app itself was told of the card (its `card_requested`, which it logs with the card's id): a card the run reads
 *  over RPC but the app never heard of is a card the user would never see (the first packaged run's daemon sent none:
 *  its events didn't parse). Waits a moment for the app's log. */
async function appGotCard(card: Card, log = join(logs, "app.log")): Promise<void> {
  const line = `card: a ${card.kind} card ${card.id} arrived`;
  for (let i = 0; i < 50; i++) {
    if (existsSync(log) && readLog(log).includes(line)) return;
    await Bun.sleep(100);
  }
  fail(`the app was never told of the ${card.kind} card ${card.id} (no card_requested reached it; the daemon log says why) [packages/core/src/ipc/core-events.ts]`);
}

/** Approves a card as the app's sealed frame does: a channel minted for the card, then the answer on it. The app must
 *  have been told of it first (`appGotCard`). From source the run's connection is the app's role (the source daemon's
 *  test seam); on a packaged test-marked core it is the harness's `cli` connection, which only a test build lets list,
 *  frame and answer cards (packages/core/src/approvals/broker.ts's test-build relaxation). Neither presses the real
 *  sealed button: that is the owner's live gate. */
async function approve(c: CloverClient, card: Card): Promise<void> {
  await appGotCard(card);
  const option = card.options.find((o) => o.kind === "approve");
  if (option === undefined) fail(`card ${card.kind} has no approve option`);
  const frame = await c.request<{ channel: string }>("card.frame", { id: card.id });
  const children = card.children?.filter((ch) => ch.checked).map((ch) => ch.id);
  const r = await c.request<{ accepted: boolean; reason?: string }>("card.answer", {
    id: card.id, hash: card.hash, option: option!.id,
    proof: { via: "sealed-frame", frame: frame.channel, input: "click", at: Date.now() },
    ...(children !== undefined && children.length > 0 ? { children } : {}),
  });
  if (!r.accepted) fail(`card.answer refused the approval of the ${card.kind} card: ${r.reason ?? "no reason"}`);
}
/** The first app's DevTools connection (step 1), for the run's one real press. */
let pressCdp: Cdp | undefined;
/** Presses the card's Approve on its fallback card, drawn offscreen in a headless run (CLOVER_TEST_SEALED_PRESS): the
 *  pointer enters, the page's own second passes, then a trusted DevTools click on the button. The answer goes the
 *  whole real way (the page's gates, the app's signature with its registered answer key, `card.answer` with a device
 *  proof, the broker's #verify); the app's log says how it went, and a refusal fails the step with its line. */
async function pressApprove(cdp: Cdp, card: Card, appLog = join(logs, "app.log")): Promise<void> {
  await appGotCard(card, appLog);
  const from = readLog(appLog).length;
  const page = await until(`the ${card.kind} card's fallback page (drawn offscreen)`, 20_000, async () => (await cdp.documents()).find((d) => d.url.startsWith(`clover-sealed://card/${encodeURIComponent(card.id)}/own`)) ?? undefined, 300)
    .catch((err: unknown) => fail(`${why(err)}: ${firstLine(appLog, new RegExp(`fallback card for ${card.id}`)) ?? "the app logged nothing about its fallback"} [apps/desktop/src/main/index.ts showFallbackCard]`));
  const s = page.session;
  const btn = await until("the card's Approve button", 10_000, () => cdp.centerOf(s, ".seal-button[data-kind=approve]"), 300);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: btn.x, y: btn.y, button: "none", buttons: 0 }, s);
  // The fallback counts a press only a second after it is drawn, with the pointer in it.
  await sleep(1_500);
  await cdp.click(s, btn.x, btn.y);
  const verdict = await until(`the app's answer for the ${card.kind} card`, 30_000, () => {
    const text = readLog(appLog).slice(from);
    if (text.includes(`sealed: answer accepted for ${card.id}`)) return "accepted";
    return /sealed: (?:core refused answer|answer held back|answer refused)[^\n]*/.exec(text)?.[0];
  }, 300).catch(() => undefined);
  if (verdict === undefined) fail(`the press on the ${card.kind} card's Approve reached nothing (no "sealed:" line in app.log) [scripts/acceptance/run.ts pressApprove → apps/desktop/src/main/sealed-pages.ts ownCardPage]`);
  if (verdict !== "accepted") fail(`the press on the ${card.kind} card's Approve: ${verdict!.trim()} [apps/desktop/src/main/index.ts sealedAnswer → packages/core/src/approvals/broker.ts #verify]`);
}

async function cards(c: CloverClient): Promise<Card[]> {
  return (await c.request<{ cards: Card[] }>("card.list")).cards;
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.error(`acceptance: target ${target}${appBundle ? ` (${appBundle})` : ` (${REPO})`}; temp folder ${root}`);
  if (target === "packaged") {
    const refused = checkTestBuild();
    if (refused !== "") {
      console.error(`acceptance: not running ${appBundle}: ${refused}`);
      for (let n = 1; n <= TOTAL; n++) record(n, "BLOCKED", n === 1 ? `not a test build: ${refused}` : "not a test build");
      return;
    }
  }
  makeKeychain();
  fake = startFakeAnthropic({ key: dummyKey, writePath, writeContent });
  // An upgrade: the home an earlier build made, copied in (its run/ sockets and tokens left behind), then this build's settings.
  if (coldHome !== undefined) cpSync(coldHome, home, { recursive: true, filter: (src) => !/[\\/]run([\\/]|$)/.test(src.slice(coldHome.length)) });
  writeSettings(fake.url);
  let app: { exe: string; args: string[] };
  try {
    if (target === "source") { say("building the dev bundled plugins"); await buildBundledPlugins(); }
    app = target === "source" ? sourceApp() : packagedApp(appBundle!);
  } catch (err) {
    for (let n = 1; n <= TOTAL; n++) record(n, "BLOCKED", n === 1 ? `setup: ${why(err)}` : "setup failed");
    return;
  }

  if (coldOnly) { await coldStartStep(app, coldStartRuns); return; }
  if (upgrade) { await upgradeRun(app); return; }

  // Step 1: the daemon, then the app headless; the app pairs and finishes its setup.
  let daemon: { proc: ChildProcess; log: string };
  try {
    daemon = await startDaemonProc();
  } catch (err) {
    for (let n = 1; n <= TOTAL; n++) record(n, "BLOCKED", n === 1 ? `the daemon didn't start: ${why(err)}` : "no daemon");
    return;
  }
  const smokeOut = join(root, "smoke.json");
  // The first app takes a DevTools port (the source app behind CLOVER_DEV_DEBUG, a test-marked one behind
  // CLOVER_TEST_DEBUG) and draws a card's fallback offscreen (CLOVER_TEST_SEALED_PRESS), so the run presses the real
  // Approve of step 4's plugin OK card and step 6's write card: the app signs with its registered answer key and the
  // core's broker checks the proof (step 3's turn raises no card: Clover's own bot asks nothing).
  const pressPort = 9300 + Math.floor(Math.random() * 500);
  const appEnv = {
    ...baseEnv(), CLOVER_DAEMON_BIN: stubBin, CLOVER_SMOKE_KEEP: "1", CLOVER_SMOKE_OUT: smokeOut, CLOVER_SMOKE_DEADLINE_MS: "45000",
    CLOVER_TEST_SEALED_PRESS: "1", ...(target === "source" ? { CLOVER_DEV_DEBUG: "1" } : { CLOVER_TEST_DEBUG: "1" }),
  };
  const appProc = startChild("app", app.exe, [...app.args, "--clover-headless", "--clover-smoke", "--use-mock-keychain", `--remote-debugging-port=${pressPort}`], appEnv);
  // A daemon that dies under the app: the app is ended at once, before its redial (3 s) tries to start a daemon through
  // the OS (apps/desktop/src/main/pair/pair.ts `kick`), which a packaged dist app does with its own core, not the stub.
  daemon.proc.once("exit", () => { if (!stoppingDaemon) { say("the daemon exited under the app: ending the app"); void endChild(appProc.proc, 2_000); } });
  try {
    const report = await until("the app's smoke report", 90_000, () => {
      if (!alive(appProc.proc)) fail(`the app exited (${appProc.proc.exitCode ?? appProc.proc.signalCode}): ${firstLine(appProc.log, /refused|failed|error/i) ?? lastLines(appProc.log)}`);
      if (!existsSync(smokeOut)) return undefined;
      try { return JSON.parse(readFileSync(smokeOut, "utf8")) as { ok?: boolean; pair?: string; reason?: string; visibleWindows?: number; frames?: { text?: string }[] }; } catch { return undefined; }
    }, 500);
    // The app's setup after its hello (apps/desktop/src/main/index.ts `onConnected`) ends in a log line when it fails.
    await sleep(3_000);
    const setupFailed = firstLine(appProc.log, /pair: setting up the connection failed|pair: the daemon refused the hello/);
    if ((report.visibleWindows ?? 0) > 0) fail(`the headless app showed ${report.visibleWindows} window(s)`);
    if (report.pair !== "connected") fail(`the app didn't pair (pair state ${report.pair ?? "?"}): ${setupFailed ?? firstLine(appProc.log, /pair:/) ?? "no pair line"} [apps/desktop/src/main/pair/pair.ts]`);
    if (setupFailed !== undefined) fail(`${setupFailed} [apps/desktop/src/main/index.ts onConnected → pair/pair.ts]`);
    if (report.ok !== true) {
      // What the window says instead, and the methods the app's setup found missing.
      const text = (report.frames ?? []).map((f) => f.text ?? "").join(" ").split("\n")[0]?.slice(0, 120);
      const missing = readLog(appProc.log).split("\n").filter((l) => /doesn't serve/.test(l)).map((l) => /serve (\S+)/.exec(l)?.[1]).filter(Boolean);
      fail(`the app paired but drew no shell${text ? ` ("${text}")` : ""}${missing.length ? `; the daemon doesn't serve ${[...new Set(missing)].join(", ")}` : ""} [apps/desktop/src/main/index.ts loadRegistry → plugin.ui]`);
    }
    // The app's answer key is registered with the core on this first connection (try 8: "not served yet" once, and every
    // press on a card refused after): a press on a card needs it.
    // The DevTools connection first: step 3 presses its card whether or not this step passes.
    try { pressCdp = await Cdp.connect(pressPort); } catch (err) { fail(`the first app's DevTools port didn't answer (${why(err)}): the run can't press a card`); }
    const appLog = join(logs, "app.log");
    const registered = await until("the app's answer key registered (app.log)", 15_000, () => (/answer key: registered/.test(readLog(appLog)) ? true : undefined), 300).catch(() => false);
    const notRegistered = firstLine(appLog, /answer key: not registered/);
    if (notRegistered !== undefined) fail(`${notRegistered.trim()} [apps/desktop/src/main/answer-key.ts KeyRegistration → device.answerKey.set, packages/core/src/devices/rpc.ts answerKeyMethods]`);
    if (registered !== true) fail('the app never logged "answer key: registered" [apps/desktop/src/main/index.ts onConnected]');
    record(1, "PASS", "the app paired (protocol.hello, onConnected's setup), registered its answer key and drew the shell, headless");
  } catch (err) {
    record(1, statusOf(err), why(err));
  }

  // The driver: the app's own methods, as the app's main process calls them.
  let c: CloverClient;
  try {
    c = (await appDriver()).client;
  } catch (err) {
    const detail = `the run's ${target === "source" ? "app" : "cli"} hello was refused: ${why(err)}`;
    for (let n = 2; n <= 6; n++) record(n, "BLOCKED", detail);
    const up = await restartStep(daemon, appProc.proc, undefined);
    await uiPhase(app, up, undefined, false);
    return;
  }

  // Step 2: the dummy key, through models.list and plugin.auth.*.
  let keyAdded = false;
  try {
    const before = await c.request<{ models: { tag?: string; id?: string; provider?: string; signedIn: boolean }[] }>("models.list", {});
    const anthropic = before.models.filter((m) => JSON.stringify(m).includes("anthropic"));
    if (anthropic.length === 0) fail(`models.list lists no Anthropic model (${before.models.length} models)`);
    const plugin = "clover/model-anthropic";
    const auth = await c.request<{ auth: { index: number; method: string; state: string }[] }>("plugin.auth.list", { id: plugin });
    const entry = auth.auth.find((a) => a.method === "api-key");
    if (entry === undefined) fail(`plugin.auth.list ${plugin} has no api-key entry`);
    const signed = await c.request<{ state: string }>("plugin.auth.signIn", { id: plugin, index: entry!.index, key: dummyKey });
    if (signed.state !== "signed-in") fail(`plugin.auth.signIn left ${plugin} ${signed.state}`);
    const after = await c.request<{ models: { signedIn: boolean }[] }>("models.list", {});
    const signedIn = after.models.filter((m) => JSON.stringify(m).includes("anthropic") && m.signedIn).length;
    if (signedIn === 0) fail("plugin.auth.signIn said signed-in, but models.list shows no Anthropic model signed in");
    keyAdded = true;
    record(2, "PASS", `plugin.auth.signIn stored the dummy key; models.list: ${signedIn} Anthropic models signed in`);
  } catch (err) {
    record(2, statusOf(err), why(err));
  }

  // Step 3: a turn on the bundled bot's main conversation, answered by the fake. Alpha is Clover's own bundled bot, so
  // its provider asks nothing (the owner's ruling, packages/core/src/bots/provider-consent.ts): a `bot-provider` card
  // fails the step, approved or not.
  let session: string | undefined;
  let turnsWork = false;
  try {
    const bots = await c.request<{ bots: { id: string; mainSession: string; model?: string }[] }>("bot.list", {});
    if (bots.bots.length === 0) fail("bot.list lists no bot (the bundled alpha isn't there)");
    session = bots.bots[0]!.mainSession;
    const model = bots.bots[0]!.model;
    await c.request("events.subscribe", { areas: ["sessions", "approvals"] }).catch(() => undefined);
    await c.request("session.attach", { id: session });
    const seen = fake.requests.length;
    const { events, cards: carded, changes } = await turn(c, session, "ACCEPTANCE-REPLY: say hello");
    const mine = fake.requests.slice(seen).filter((r) => r.path.endsWith("/messages"));
    const replied = JSON.stringify(events).includes("ACCEPTANCE-REPLY-OK");
    turnsWork = replied;
    if (changes.includes("bot-provider")) fail(`the bundled bot's first turn raised a provider card (bot-provider): Clover's own bot asks nothing (${carded.join("; ")})`);
    if (replied) record(3, "PASS", `the reply came from the fake, with no provider card (${mine.length} request(s), key matched: ${mine.some((r) => r.keyMatched)}${carded.length ? `; ${carded.join("; ")}` : ""})`);
    else if (mine.length === 0) fail(`the turn never reached the fake provider${model ? ` (the bot runs ${model})` : ""}: stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""}`);
    else if (!mine.some((r) => r.keyMatched)) fail(`the fake got the turn without the dummy key (key present: ${mine.some((r) => r.keyPresent)}${keyAdded ? "" : "; step 2 added none"}): ${errorsOf(events)[0] ?? `stop ${stopOf(events)}`}`);
    else fail(`the fake answered, but the reply isn't in the session (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""})`);
  } catch (err) {
    record(3, statusOf(err), why(err));
    // A key added a moment ago can still be unseen by the bots (their view of the stored keys is re-read lazily,
    // packages/core/src/bots/key-presence.ts): once its model is the keyed one, a second turn says whether the rest
    // of the path works, so steps 5 and 6 still run. Step 3 stays a FAIL: a user's first turn went wrong.
    if (keyAdded && session !== undefined) {
      try {
        const model = await until("the bot to take the keyed model", 20_000, async () => {
          const m = (await c.request<{ bots: { mainSession: string; model?: string }[] }>("bot.list", {})).bots.find((b) => b.mainSession === session)?.model;
          return m !== undefined && m.startsWith("anthropic/") ? m : undefined;
        }, 1_000);
        const { events, cards: carded, changes } = await turn(c, session, "ACCEPTANCE-REPLY: say hello again");
        turnsWork = JSON.stringify(events).includes("ACCEPTANCE-REPLY-OK");
        const row = rows.find((r) => r.n === 3)!;
        const asked = changes.includes("bot-provider") ? "; it raised a provider card (bot-provider) too" : "";
        row.detail = `${row.detail} — a second turn, once the bot runs ${model}: ${turnsWork ? `the fake's reply came${carded.length ? ` (${carded.join("; ")})` : ""}` : `no reply either (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""})`}${asked}`.slice(0, 700);
      } catch (again) {
        const row = rows.find((r) => r.n === 3)!;
        row.detail = `${row.detail} — and no second turn: ${why(again)}`.slice(0, 700);
      }
    }
  }

  // Step 4: the fixture plugin from a local folder, and its OK card.
  let pluginId: string | undefined;
  let pluginOk = false;
  try {
    // A kept run's plugin folder stays with its user home, as a user's own folder would.
    const folder = join(stateDir !== undefined ? userHome : root, "plugin-src", "acceptance-echo");
    cpSync(join(import.meta.dir, "fixtures", "acceptance-echo"), folder, { recursive: true });
    const installed = await c.request<{ id: string; state: string; card?: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
    pluginId = installed.id;
    say(`plugin.install → ${installed.id} ${installed.state}${installed.card ? ` card ${installed.card}` : " (no card named)"}`);
    const card = await until("the plugin's OK card", 30_000, async () => {
      const all = await cards(c);
      return all.find((k) => (installed.card !== undefined && k.id === installed.card) || k.pluginId === installed.id);
    });
    const shown = await c.request<{ card: Card }>("card.get", { id: card.id });
    if (shown.card.hash !== card.hash) fail("card.get's card isn't card.list's");
    // Pressed in the window, the real way: the app signs with its registered key, the broker checks the proof.
    if (pressing) {
      if (pressCdp === undefined) fail("the first app has no DevTools connection (step 1), so the OK card can't be pressed the real way");
      await pressApprove(pressCdp!, card);
    } else await approve(c, card);
    const state = await until("the plugin to be enabled after its OK", 60_000, async () => {
      const r = await c.request<{ plugin?: { state?: string } }>("plugin.get", { id: installed.id }).catch(() => undefined);
      const s = r?.plugin?.state;
      return s !== undefined && s !== "found" && s !== "installing" ? s : undefined;
    });
    if (state !== "enabled" && state !== "running") fail(`after its OK the plugin is ${state}`);
    pluginOk = true;
    record(4, "PASS", `plugin.install (folder) → ${installed.state}; the ${card.kind} card listed and read, ${pressing ? "its Approve pressed in the window (the app signed, the broker checked the proof)" : "approved over RPC (--no-press)"}; now ${state}`);
  } catch (err) {
    record(4, statusOf(err), why(err));
  }

  // Step 5: the bot calls the plugin's tool.
  if (session === undefined || !turnsWork) record(5, "BLOCKED", "no bot turn reaches the fake provider (step 3)");
  else if (pluginId === undefined || !pluginOk) record(5, "BLOCKED", "the plugin isn't installed and approved (step 4)");
  else {
    try {
      const seen = fake.requests.length;
      // A card on the tool call (commands always card on try-6) is answered as the app would, and named.
      const { events, cards: carded } = await turn(c, session, "ACCEPTANCE-ECHO: call the echo tool", 150_000);
      const mine = fake.requests.slice(seen);
      const offered = mine.find((r) => r.tools.length > 0)?.tools ?? [];
      const called = mine.find((r) => r.toolUse !== undefined)?.toolUse;
      const result = mine.find((r) => r.toolResult !== undefined)?.toolResult;
      if (called === undefined) fail(`the bot was offered no Echo tool (${offered.length} tools, plugin tools: ${offered.filter((t) => t.startsWith("mcp__")).join(", ") || "none"})`);
      if (result === undefined) fail(`the bot called ${called} but no tool result came back (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""})`);
      if (result!.isError || !result!.text.includes("acceptance-echo-pong")) fail(`${called} answered with an error: ${result!.text.slice(0, 200)}`);
      record(5, "PASS", `the bot called ${called} and got "${result!.text.slice(0, 60)}"${carded.length ? ` (${carded.join("; ")})` : " (no card)"}`);
    } catch (err) {
      record(5, statusOf(err), why(err));
    }
  }

  // Step 14 (its turn here, on the first daemon; recorded at the end with the daemons' logs): the bot's WebSearch, the
  // bundled web plugin's tool, through the plugin host's net.fetch to the fake search backend (fake-exa.ts) that the
  // acceptance daemon's keyed fetch seam serves; every other host is refused there and logged.
  if (session === undefined || !turnsWork) searchOutcome = { status: "BLOCKED", detail: "no bot turn reaches the fake provider (step 3)" };
  // Only the source daemon has the fake search backend (its keyed fetch seam): a packaged core would search the real
  // web, which a run never does.
  else if (skipWebTurns) searchOutcome = { status: "BLOCKED", detail: "--skip-web-turns: this tree's daemon has no fake web seam, so its web turns aren't run (they could reach the real web)" };
  else if (target !== "source") searchOutcome = { status: "BLOCKED", detail: "a packaged core has no fake search backend (the keyed fetch's test seam is the source daemon's, scripts/acceptance/daemon.ts); the run never searches the real web" };
  else {
    try {
      const seen = fake.requests.length;
      const { events, cards: carded } = await turn(c, session, "ACCEPTANCE-SEARCH: search the web", 150_000);
      const mine = fake.requests.slice(seen);
      const offered = mine.find((r) => r.tools.length > 0)?.tools ?? [];
      const called = mine.find((r) => r.toolUse !== undefined)?.toolUse;
      const result = mine.find((r) => r.toolResult !== undefined)?.toolResult;
      if (called === undefined) fail(`the bot was offered no WebSearch (${offered.length} tools, MCP tools: ${offered.filter((t) => t.startsWith("mcp__")).join(", ") || "none"})`);
      if (result === undefined) fail(`the bot called ${called} but no tool result came back (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""})`);
      if (called !== WEB_SEARCH_TOOL) fail(`the bot's WebSearch is ${called}, not ${WEB_SEARCH_TOOL}`);
      if (result!.isError || !result!.text.includes(FAKE_SEARCH_HIT)) fail(`${called} answered without the fake backend's result: ${result!.text.slice(0, 300)}`);
      searchOutcome = { status: "PASS", detail: `the bot called ${called} and got the fake search backend's result${carded.length ? ` (${carded.join("; ")})` : ""}` };
    } catch (err) {
      searchOutcome = { status: statusOf(err), detail: why(err) };
    }
  }

  // Step 15 (its turns here; recorded at the end): the bot's WebFetch (network:public) reads the fake public site's
  // article through the same seam, and a name that resolves to a private address is refused before any request.
  if (session === undefined || !turnsWork) fetchOutcome = { status: "BLOCKED", detail: "no bot turn reaches the fake provider (step 3)" };
  else if (skipWebTurns) fetchOutcome = { status: "BLOCKED", detail: "--skip-web-turns: this tree's daemon has no fake web seam, so its web turns aren't run (they could reach the real web)" };
  else if (target !== "source") fetchOutcome = { status: "BLOCKED", detail: "a packaged core has no fake public site (the keyed fetch's test seam is the source daemon's); the run never fetches the real web" };
  else {
    try {
      const fetchTurn = async (url: string) => {
        const seen = fake!.requests.length;
        const { events } = await turn(c, session!, `ACCEPTANCE-FETCH ${url}`, 150_000);
        const mine = fake!.requests.slice(seen);
        const called = mine.find((r) => r.toolUse !== undefined)?.toolUse;
        const result = mine.find((r) => r.toolResult !== undefined)?.toolResult;
        if (called === undefined) fail(`the bot was offered no WebFetch (MCP tools: ${(mine.find((r) => r.tools.length > 0)?.tools ?? []).filter((t) => t.startsWith("mcp__")).join(", ") || "none"})`);
        if (result === undefined) fail(`the bot called ${called} but no tool result came back (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""})`);
        return { called: called!, result: result! };
      };
      const page = await fetchTurn(`https://${FAKE_PUBLIC_SITE}/article`);
      if (page.called !== WEB_FETCH_TOOL) fail(`the bot's WebFetch is ${page.called}, not ${WEB_FETCH_TOOL}`);
      if (page.result.isError || !page.result.text.includes(FAKE_ARTICLE_TEXT)) fail(`${page.called} didn't read the public page: ${page.result.text.slice(0, 300)}`);
      const inside = await fetchTurn(`https://${FAKE_PRIVATE_SITE}/x`);
      if (!inside.result.isError || !/private address/.test(inside.result.text)) fail(`${inside.called} wasn't refused the private address: ${inside.result.text.slice(0, 300)}`);
      // The model reads that the name resolves to a private address, never which one (that stays in the daemon's log).
      if (inside.result.text.includes(FAKE_PRIVATE_ADDRESS)) fail(`${inside.called}'s refusal names the private address to the model: ${inside.result.text.slice(0, 300)}`);
      fetchOutcome = { status: "PASS", detail: `${page.called} read the fake public page; ${FAKE_PRIVATE_SITE} was refused ("${inside.result.text.slice(0, 120)}")` };
    } catch (err) {
      fetchOutcome = { status: statusOf(err), detail: why(err) };
    }
  }

  // Step 6: a write outside the bot's own folders: an approval card, the app's yes, then the file.
  if (session === undefined || !turnsWork) record(6, "BLOCKED", "no bot turn reaches the fake provider (step 3)");
  else {
    try {
      const seen = fake.requests.length;
      const { events, cards: carded } = await turn(c, session, "ACCEPTANCE-WRITE: write the file", 150_000, { press: pressing });
      const answered = carded.length ? carded.join("; ") : undefined;
      const mine = fake.requests.slice(seen);
      const called = mine.find((r) => r.toolUse !== undefined)?.toolUse;
      const result = mine.find((r) => r.toolResult !== undefined)?.toolResult;
      const landed = existsSync(writePath) && readFileSync(writePath, "utf8") === writeContent;
      if (called === undefined) fail(`the bot was offered no Write tool (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""})`);
      if (answered === undefined && landed) fail("the write landed outside the bot's folders with no approval card (the fence didn't ask)");
      if (answered === undefined) fail(`no approval card was raised; the write's result: ${(result?.text ?? "none").slice(0, 200)}`);
      if (!landed) fail(`${answered} — but the file didn't land; the write's result: ${(result?.text ?? "none").slice(0, 200)}`);
      record(6, "PASS", `${called} raised ${answered}; the file landed`);
    } catch (err) {
      record(6, statusOf(err), why(err));
    }
  }

  c.close();
  const restarted = await restartStep(daemon, appProc.proc, session);
  await uiPhase(app, restarted, session, pressing && pluginOk && turnsWork);
  if (keepState !== undefined) await keepFacts(session, pluginOk ? pluginId : undefined);
  await bundledMcpStep();
  searchStep();
  record(TOTAL - 1, fetchOutcome?.status ?? "BLOCKED", fetchOutcome?.detail ?? "the fetch turns didn't run");
  await coldStartStep(app, 1);
  await reopenSteps(app);
}

// ── the reopen steps ──────────────────────────────────────────────────────────────────────────────────────────────
/** The run's stand-in for the OS starting the daemon at the app's ask (source target): each new line in
 *  launch-requests starts the core if no daemon of the run is alive (an ask while the old one still goes starts
 *  nothing, as launchd's job is still running; the app must ask again). A test-marked app asks nothing (it has no
 *  launcher): on the packaged target the run starts the core itself once the old one has gone, and says so. */
function launchStandIn(): { stop(): void; started: string[] } {
  let seen = existsSync(launchRequests) ? readLog(launchRequests).split("\n").filter(Boolean).length : 0;
  let starting = false;
  const started: string[] = [];
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (starting) return;
    const asks = existsSync(launchRequests) ? readLog(launchRequests).split("\n").filter(Boolean).length : 0;
    const daemonAlive = lastDaemon !== undefined && alive(lastDaemon.proc);
    const due = target === "source" ? asks > seen : !daemonAlive;
    if (!due) return;
    if (target === "source") {
      const fresh = asks - seen;
      seen = asks;
      if (daemonAlive) { started.push(`+${((Date.now() - t0) / 1000).toFixed(1)} s: ${fresh} ask(s) while the old daemon still runs (nothing started)`); return; }
    }
    starting = true;
    started.push(`+${((Date.now() - t0) / 1000).toFixed(1)} s: ${target === "source" ? "the app asked; the core started" : "no daemon: the run started the core (a test build's app has no launcher)"}`);
    void startDaemonProc().catch((err: unknown) => started.push(`the core didn't start: ${why(err)}`)).finally(() => { starting = false; });
  }, 200);
  return { stop: () => clearInterval(timer), started };
}

/** An app as the owner starts it (headless here, with a DevTools port), the launcher stand-in its daemon binary. */
function openApp(app: { exe: string; args: string[] }, label: string): { proc: ChildProcess; log: string; port: number } {
  const port = 9300 + Math.floor(Math.random() * 500);
  const env = { ...baseEnv(), CLOVER_DAEMON_BIN: standInBin, ...(target === "source" ? { CLOVER_DEV_DEBUG: "1" } : { CLOVER_TEST_DEBUG: "1" }) };
  const p = startChild(label, app.exe, [...app.args, "--clover-headless", `--clover-capture=${join(root, "capture.png")}`, "--use-mock-keychain", `--remote-debugging-port=${port}`], env);
  return { ...p, port };
}

/** The window filled (the shell drawn) within `ms`; on a timeout, what the window and the app's pair said. */
async function windowFills(app: { proc: ChildProcess; log: string; port: number }, ms: number): Promise<number> {
  const t0 = Date.now();
  let cdp: Cdp | undefined;
  try {
    await until("the window's DevTools port", 60_000, async () => {
      if (!alive(app.proc)) fail(`the app exited (${app.proc.exitCode ?? app.proc.signalCode}): ${lastLines(app.log)}`);
      try { cdp = await Cdp.connect(app.port); return true; } catch { return undefined; }
    }, 300);
    await until(`the window to fill within ${ms / 1000} s`, ms, () => shellDoc(cdp!), 300).catch(async (e: unknown) => {
      const text = await treeText(cdp!).catch(() => "");
      const root = (await cdp!.documents().catch(() => [])).map((d) => d.text).join(" ").replace(/\s+/g, " ").slice(0, 160);
      const pairLines = readLog(app.log).split("\n").filter((l) => /pair:/.test(l)).slice(-5).join(" | ").slice(0, 600);
      fail(`${why(e)}${/Starting Clover/.test(root + text) ? ' — stuck on "Starting Clover…"' : ""} (window: "${root}"; the app's pair: ${pairLines})`);
    });
    return Date.now() - t0;
  } finally {
    cdp?.close();
  }
}

async function reopenSteps(app: { exe: string; args: string[] }): Promise<void> {
  const first = FULL_STEPS.indexOf(REOPEN_STEPS[0].name) + 1;
  const stand = launchStandIn();
  const waitGone = async (d: { proc: ChildProcess } | undefined, ms: number): Promise<void> => {
    if (d === undefined) return;
    await until("the old daemon to go", ms, () => (alive(d.proc) ? undefined : true), 200).catch(() => undefined);
  };
  try {
    for (const [i, step] of REOPEN_STEPS.entries()) {
      const n = first + i;
      const log0 = stand.started.length;
      let appA: ReturnType<typeof openApp> | undefined;
      let appB: ReturnType<typeof openApp> | undefined;
      try {
        // A daemon of this step's own (the held step's slow to go), and the app on it.
        if (lastDaemon !== undefined && alive(lastDaemon.proc)) { stoppingDaemon = true; await endChild(lastDaemon.proc, 20_000); }
        stoppingDaemon = false;
        await startDaemonProc("holdMs" in step ? { CLOVER_ACCEPTANCE_STOP_HOLD_MS: String(step.holdMs) } : {});
        const old = lastDaemon!;
        appA = openApp(app, `reopen-${i + 1}-a`);
        await windowFills(appA, 60_000);
        if ("stale" in step) {
          // A crash of both: the app and the daemon killed outright, which leaves core.sock and core.lock behind.
          try { process.kill(-appA.proc.pid!, "SIGKILL"); } catch { /* gone */ }
          try { process.kill(-old.proc.pid!, "SIGKILL"); } catch { /* gone */ }
          await waitGone(old, 10_000);
          await until("the killed app to go", 10_000, () => (alive(appA!.proc) ? undefined : true), 200);
          const left = ["core.sock", "core.lock"].filter((f) => existsSync(join(home, "run", f)));
          if (left.length < 2) block(`killing the daemon left ${left.join(", ") || "nothing"} in run/, not a stale core.sock and core.lock`);
          appB = openApp(app, `reopen-${i + 1}-b`);
          const took = await windowFills(appB, 60_000);
          if (lastDaemon === old || !alive(lastDaemon!.proc)) fail("the window filled with no new daemon running");
          record(n, "PASS", `a stale core.sock and core.lock, no daemon: the window filled ${(took / 1000).toFixed(1)} s after the app opened; ${stand.started.slice(log0).join("; ")}`);
        } else {
          // A turn that keeps running, then the app quits as the owner's does (the tray's Quit stops both halves).
          const c = (await appDriver()).client;
          const session = (await c.request<{ bots: { mainSession: string }[] }>("bot.list", {})).bots[0]?.mainSession;
          if (session === undefined) block("no bot conversation to run a turn in");
          const tag = `ACCEPTANCE-SLOW-${randomBytes(3).toString("hex").toUpperCase()}`;
          const asked = fake!.requests.length;
          await c.request("session.send", { id: session, message: { text: `${tag} keep going`, clientMessageId: randomUUID() } }, 30_000);
          await until("the turn to be running (the fake asked)", 60_000, () => (fake!.requests.slice(asked).some((r) => r.lastUserText.includes(tag)) ? true : undefined), 200);
          c.close();
          const quitAt = Date.now();
          await endChild(appA.proc, 10_000);
          await sleep(step.delayMs);
          const oldAlive = alive(old.proc);
          if ("holdMs" in step && !oldAlive) block("the old daemon had gone before the app reopened: the step didn't test what it names");
          appB = openApp(app, `reopen-${i + 1}-b`);
          const took = await windowFills(appB, 60_000);
          const oldGoneMs = old.proc.exitCode !== null || old.proc.signalCode !== null ? "gone" : "still running";
          if (lastDaemon === old) fail(`the window filled on the old daemon (${oldGoneMs}), not a new one`);
          // The interrupted turn, honestly: the session doesn't still say it's running, and its history ends the turn.
          const d = (await appDriver()).client;
          const events = await until("the bot side after the reopen", 60_000, () => history(d, session!).catch(() => undefined), 1_000);
          const at = events.findIndex((e) => JSON.stringify(e).includes(tag));
          const after = at < 0 ? [] : events.slice(at + 1);
          const ends = after.filter((e) => /turn_completed|turn_interrupted|interrupted|agent_error|turn_failed/.test(String(e.type)));
          const status = (await d.request<{ bots: { mainSession: string; status?: string }[] }>("bot.list", {}).catch(() => ({ bots: [] }))).bots.find((b) => b.mainSession === session)?.status;
          d.close();
          if (at < 0) fail("the quit turn's message isn't in the conversation after the reopen");
          if (ends.length === 0) fail(`the interrupted turn has no end in the conversation (events after it: ${[...new Set(after.map((e) => String(e.type)))].join(", ") || "none"}; bot status ${status ?? "?"})`);
          const end = ends[ends.length - 1]!;
          record(n, "PASS", `quit mid-turn, reopened ${step.delayMs / 1000} s later (the old daemon ${oldAlive ? "still going" : "gone"} then): the window filled ${(took / 1000).toFixed(1)} s after the app opened (${((Date.now() - quitAt) / 1000).toFixed(1)} s after the quit); the turn ends as ${String(end.type)}${end.stopReason !== undefined ? ` (${String(end.stopReason)})` : ""}; ${stand.started.slice(log0).join("; ") || "no launch asked"}`);
        }
      } catch (err) {
        record(n, statusOf(err), `${why(err)}${stand.started.length > log0 ? ` [launch stand-in: ${stand.started.slice(log0).join("; ")}]` : ""}`);
      } finally {
        if (appA !== undefined && alive(appA.proc)) await endChild(appA.proc);
        if (appB !== undefined) await endChild(appB.proc);
        // The daemon the app's quit stops goes by itself (the pair); a test that failed may have left one.
        await waitGone(lastDaemon, 20_000);
      }
    }
  } finally {
    stand.stop();
  }
}

/** The cold-start step, in the order a real start has: the app is up FIRST with no daemon, then the daemon starts, and its
 *  plugin registry opens a moment later (a delay the test daemon takes, so the app's connect lands inside the opening on
 *  purpose; a packaged core takes none). The shell must fill the window within COLD_START_SECONDS of the daemon's start. */
const COLD_START_SECONDS = 40;
async function coldStartStep(app: { exe: string; args: string[] }, runs: number): Promise<void> {
  const n = STEPS.length;
  const took: number[] = [];
  try {
    for (let i = 1; i <= runs; i++) {
      // No daemon: the one from the steps before ends.
      if (lastDaemon !== undefined && alive(lastDaemon.proc)) { stoppingDaemon = true; await endChild(lastDaemon.proc, 20_000); }
      const port = 9300 + Math.floor(Math.random() * 500);
      const env = { ...baseEnv(), CLOVER_DAEMON_BIN: stubBin, ...(target === "source" ? { CLOVER_DEV_DEBUG: "1" } : { CLOVER_TEST_DEBUG: "1" }) };
      const appLog = join(home, "logs", "app.log");
      const logFrom = readLog(appLog).length;
      const proc = startChild(`cold-app-${i}`, app.exe, [...app.args, "--clover-headless", `--clover-capture=${join(root, "capture.png")}`, "--use-mock-keychain", `--remote-debugging-port=${port}`], env);
      let cdp: Cdp | undefined;
      try {
        await until("the window's DevTools port", 120_000, async () => {
          if (!alive(proc.proc)) fail(`the app exited (${proc.proc.exitCode ?? proc.proc.signalCode}): ${firstLine(proc.log, /refusing|refused|failed|error/i) ?? lastLines(proc.log)}`);
          try { cdp = await Cdp.connect(port); return true; } catch { return undefined; }
        }, 500);
        // The app is waiting for a daemon (it has said so), and has been for a moment.
        await until("the app to be waiting for a daemon", 60_000, () => (/pair: (unavailable|starting-daemon|reconnecting)/.test(readLog(appLog).slice(logFrom)) ? true : undefined), 300);
        await sleep(1_000);
        const at = Date.now();
        const delay: Record<string, string> = target === "source" ? { CLOVER_ACCEPTANCE_REGISTRY_DELAY_MS: "5000", CLOVER_ACCEPTANCE_REGISTRY_ANSWER_DELAY_MS: "8000" } : {};
        await startDaemonProc(delay);
        await until(`the shell to fill the window within ${COLD_START_SECONDS} s of the daemon's start`, COLD_START_SECONDS * 1000, () => shellDoc(cdp!)).catch(async (e: unknown) => fail(`${why(e)} (frames: ${await dumpFrames(cdp!).catch(() => "?")}; app.log: ${readLog(appLog).slice(logFrom).split("\n").filter((l) => /pair:|layers:|registry/.test(l)).slice(-6).join(" | ").slice(0, 500)})`));
        took.push(Date.now() - at);
        const since = readLog(appLog).slice(logFrom);
        if (/Nothing fills this window/.test(since)) fail("the fallback note was drawn");
      } finally {
        cdp?.close();
        await endChild(proc.proc);
      }
    }
    record(n, "PASS", `${runs} cold start(s): the shell filled the window ${took.map((t) => `${(t / 1000).toFixed(1)} s`).join(", ")} after the daemon started`);
  } catch (err) {
    record(n, statusOf(err), `${took.length + 1} of ${runs}: ${why(err)}`);
  }
}

/** The upgrade run (--upgrade-from): this build on the home, user home and keychain file an earlier build's
 *  --keep-state run left, in the order the owner's upgrade has: the app opens first, the daemon after. Each thing the
 *  earlier run made is its own step: the key, the conversation, the plugin, the fence, the bundled tools, the setting,
 *  and the daemon's trust in what the old build signed. */
async function upgradeRun(app: { exe: string; args: string[] }): Promise<void> {
  const k = kept!;
  // The old run's harness token (a test-marked core's, test-only) would be read before the new core writes its own:
  // it goes. Everything else the old build left in run/ stays, as on a real upgrade.
  rmSync(join(home, "run", HARNESS_TOKEN_FILE), { force: true });
  const blockFrom = (from: number, detail: string) => { for (let n = from; n <= TOTAL; n++) if (!rows.some((r) => r.n === n)) record(n, "BLOCKED", detail); };
  // 1: the app first (no daemon), then the daemon; the shell fills the window.
  const port = 9300 + Math.floor(Math.random() * 500);
  const env = { ...baseEnv(), CLOVER_DAEMON_BIN: stubBin, CLOVER_TEST_SEALED_PRESS: "1", ...(target === "source" ? { CLOVER_DEV_DEBUG: "1" } : { CLOVER_TEST_DEBUG: "1" }) };
  const appLog = join(home, "logs", "app.log");
  const logFrom = readLog(appLog).length;
  // Named "app": the cards' check reads the app's own output (logs/app.log).
  const appProc = startChild("app", app.exe, [...app.args, "--clover-headless", `--clover-capture=${join(root, "capture.png")}`, "--use-mock-keychain", `--remote-debugging-port=${port}`], env);
  let cdp: Cdp | undefined;
  let daemonUp = false;
  try {
    await until("the window's DevTools port", 120_000, async () => {
      if (!alive(appProc.proc)) fail(`the app exited (${appProc.proc.exitCode ?? appProc.proc.signalCode}): ${firstLine(appProc.log, /refusing|refused|failed|error/i) ?? lastLines(appProc.log)}`);
      try { cdp = await Cdp.connect(port); return true; } catch { return undefined; }
    }, 500);
    await until("the app to be waiting for a daemon", 60_000, () => (/pair: (unavailable|starting-daemon|reconnecting)/.test(readLog(appLog).slice(logFrom)) ? true : undefined), 300);
    await sleep(1_000);
    const at = Date.now();
    const delay: Record<string, string> = target === "source" ? { CLOVER_ACCEPTANCE_REGISTRY_DELAY_MS: "5000", CLOVER_ACCEPTANCE_REGISTRY_ANSWER_DELAY_MS: "8000" } : {};
    const daemon = await startDaemonProc(delay);
    daemonUp = true;
    daemon.proc.once("exit", () => { if (!stoppingDaemon) { say("the daemon exited under the app: ending the app"); void endChild(appProc.proc, 2_000); } });
    await until(`the shell to fill the window within ${COLD_START_SECONDS} s of the daemon's start`, COLD_START_SECONDS * 1000, () => shellDoc(cdp!)).catch(async (e: unknown) => fail(`${why(e)} (frames: ${await dumpFrames(cdp!).catch(() => "?")}; app.log: ${readLog(appLog).slice(logFrom).split("\n").filter((l) => /pair:|layers:|registry/.test(l)).slice(-6).join(" | ").slice(0, 500)})`));
    const took = Date.now() - at;
    if (/Nothing fills this window/.test(readLog(appLog).slice(logFrom))) fail("the fallback note was drawn");
    record(1, "PASS", `the app waited, the daemon started on the old home, and the shell filled the window ${(took / 1000).toFixed(1)} s later`);
  } catch (err) {
    record(1, statusOf(err), why(err));
  }
  if (!daemonUp) { blockFrom(2, "the daemon didn't start on the old home (step 1)"); trustStep(); return; }

  let c: CloverClient;
  try {
    c = (await appDriver()).client;
  } catch (err) {
    blockFrom(2, `the run's ${target === "source" ? "app" : "cli"} hello was refused: ${why(err)}`);
    trustStep();
    return;
  }
  await c.request("events.subscribe", { areas: ["sessions", "approvals"] }).catch(() => undefined);
  // The bot side opens after the socket answers (packages/core/src/daemon.ts, `partsReady`).
  type Bot = { id: string; mainSession: string; model?: string };
  let bots: Bot[] | undefined;
  let botsWhy = "";
  try {
    bots = await until("bot.list on the old home", 60_000, () => c.request<{ bots: Bot[] }>("bot.list", {}).then((r) => r.bots).catch((err: unknown) => {
      if (err instanceof RpcError && /not served yet|while it opens/.test(err.message)) return undefined;
      throw err;
    }), 1_000);
  } catch (err) {
    botsWhy = why(err);
  }

  // 2 (first half): the stored key is seen with no re-entry; the turn in 4 says whether the fake gets it.
  let signedIn = -1;
  let keyWhy = "";
  try {
    const listed = await c.request<{ models: { signedIn: boolean }[] }>("models.list", {});
    signedIn = listed.models.filter((m) => JSON.stringify(m).includes("anthropic") && m.signedIn).length;
  } catch (err) {
    keyWhy = why(err);
  }

  // 3: the old conversation: listed, its history kept, and drawn in the window.
  let session: string | undefined;
  try {
    if (bots === undefined) fail(`bot.list: ${botsWhy}`);
    if (k.session === undefined) block("the old run left no conversation (its step 3 didn't run)");
    const bot = bots!.find((b) => b.mainSession === k.session);
    if (bot === undefined) fail(`bot.list doesn't list the old conversation ${k.session} (it lists ${bots!.map((b) => `${b.id}: ${b.mainSession}`).join(", ") || "no bot"})`);
    session = k.session;
    await c.request("session.attach", { id: session });
    const events = await history(c, session!);
    if (!JSON.stringify(events).includes("ACCEPTANCE-REPLY-OK")) fail(`session.history of ${session} has ${events.length} event(s) and not the old run's reply`);
    if (cdp === undefined) fail("the window couldn't be driven (step 1)");
    await until("the old reply drawn in the window", 30_000, async () => ((await treeText(cdp!)).includes("ACCEPTANCE-REPLY-OK") ? true : undefined), 500);
    record(3, "PASS", `bot.list lists ${bot!.id}'s conversation ${session}; its history (${events.length} events) has the old run's reply, and the window draws it`);
  } catch (err) {
    record(3, statusOf(err), why(err));
    // A conversation not listed: the new turns go to the bot's current one, if there is one.
    if (session === undefined && bots !== undefined && bots.length > 0) session = bots[0]!.mainSession;
  }

  // 4: a new turn, its own reply (a tag only this turn can have caused).
  let turnsWork = false;
  const tag = `ACCEPTANCE-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
  const seen4 = fake!.requests.length;
  try {
    if (session === undefined) fail(`no conversation to talk in (bot.list: ${botsWhy || "no bot"})`);
    const { events, cards: carded } = await turn(c, session!, `${tag} say hello after the upgrade`);
    const mine = fake!.requests.slice(seen4).filter((r) => r.path.endsWith("/messages"));
    turnsWork = JSON.stringify(events).includes(`ACCEPTANCE-REPLY-OK ${tag}`);
    if (!turnsWork) fail(mine.length === 0 ? `the turn never reached the fake provider: stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""}` : `the fake answered (${mine.length} request(s)), but this turn's reply isn't in the session (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""})`);
    record(4, "PASS", `this turn's own reply came from the fake (${mine.length} request(s))${carded.length ? `; ${carded.join("; ")}` : ""}`);
  } catch (err) {
    record(4, statusOf(err), why(err));
  }

  // 2: the key, with no re-entry: models.list sees it, and the fake got it on step 4's turn.
  try {
    if (keyWhy !== "") fail(`models.list: ${keyWhy}`);
    if (signedIn === 0) fail("models.list shows no Anthropic model signed in: the key the old run stored isn't seen");
    const mine = fake!.requests.slice(seen4).filter((r) => r.path.endsWith("/messages"));
    if (mine.length === 0) block("step 4's turn never reached the fake provider, so the key wasn't sent");
    if (!mine.some((r) => r.keyMatched)) fail(`the fake got step 4's turn without the old run's key (a key present: ${mine.some((r) => r.keyPresent)})`);
    record(2, "PASS", `models.list: ${signedIn} Anthropic models signed in with no plugin.auth.signIn; the fake got the old run's key`);
  } catch (err) {
    record(2, statusOf(err), why(err));
  }

  // 5: the old plugin, still installed and approved: its tool answers and no new OK card is asked.
  try {
    if (k.pluginId === undefined) block("the old run left no approved plugin (its step 4 didn't pass)");
    const got = await c.request<{ plugin?: { state?: string } }>("plugin.get", { id: k.pluginId });
    const state = got.plugin?.state;
    if (state !== "enabled" && state !== "running") fail(`plugin.get ${k.pluginId}: ${state ?? "not installed"}`);
    const waiting = [...(await cards(c).catch(() => [])), ...raised].filter((card) => card.pluginId === k.pluginId);
    if (waiting.length > 0) fail(`the old plugin asks again: ${waiting.map((card) => `a ${card.kind} card`).join(", ")}`);
    if (session === undefined || !turnsWork) block("no turn runs on the upgraded home (step 4)");
    const seen = fake!.requests.length;
    const { events, cards: carded } = await turn(c, session!, "ACCEPTANCE-ECHO: call the echo tool", 150_000);
    const okAgain = carded.filter((x) => /plugin-ok/.test(x));
    if (okAgain.length > 0) fail(`the old plugin's OK card came again (${okAgain.join("; ")})`);
    const mine = fake!.requests.slice(seen);
    const called = mine.find((r) => r.toolUse !== undefined)?.toolUse;
    const result = mine.find((r) => r.toolResult !== undefined)?.toolResult;
    if (called === undefined) fail(`the bot was offered no Echo tool (plugin tools: ${(mine.find((r) => r.tools.length > 0)?.tools ?? []).filter((t) => t.startsWith("mcp__")).join(", ") || "none"})`);
    if (result === undefined) fail(`the bot called ${called} but no tool result came back (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""})`);
    if (result!.isError || !result!.text.includes("acceptance-echo-pong")) fail(`${called} answered with an error: ${result!.text.slice(0, 200)}`);
    record(5, "PASS", `${k.pluginId} is ${state}; the bot called ${called} and got "${result!.text.slice(0, 60)}"${carded.length ? ` (${carded.join("; ")})` : " (no card)"}`);
  } catch (err) {
    record(5, statusOf(err), why(err));
  }

  // 6: the fence still asks.
  try {
    if (session === undefined || !turnsWork) block("no turn runs on the upgraded home (step 4)");
    const seen = fake!.requests.length;
    // Pressed in the window, the real way, when the old run's app kept its answer key (this app registers the same
    // one); an older build kept it in memory only, so its card goes over RPC, and the detail says so.
    const pressHere = pressing && k.answerKeyKept === true && cdp !== undefined;
    if (pressHere) {
      const notRegistered = firstLine(join(logs, "app.log"), /answer key: not registered/);
      if (notRegistered !== undefined) fail(`the upgraded app didn't register the old run's answer key: ${notRegistered.trim()}`);
    }
    const { events, cards: carded } = await turn(c, session!, "ACCEPTANCE-WRITE: write the file", 150_000, pressHere ? { press: { cdp: cdp!, log: join(logs, "app.log") } } : {});
    const answered = carded.length ? `${carded.join("; ")}${pressHere ? "" : ` (over RPC: ${!pressing ? "--no-press" : k.answerKeyKept !== true ? "the old build kept its answer key in memory only" : "no window"})`}` : undefined;
    const mine = fake!.requests.slice(seen);
    const called = mine.find((r) => r.toolUse !== undefined)?.toolUse;
    const result = mine.find((r) => r.toolResult !== undefined)?.toolResult;
    const landed = existsSync(writePath) && readFileSync(writePath, "utf8") === writeContent;
    if (called === undefined) fail(`the bot was offered no Write tool (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""})`);
    if (answered === undefined && landed) fail("the write landed outside the bot's folders with no approval card (the fence didn't ask)");
    if (answered === undefined) fail(`no approval card was raised; the write's result: ${(result?.text ?? "none").slice(0, 200)}`);
    if (!landed) fail(`${answered} — but the file didn't land; the write's result: ${(result?.text ?? "none").slice(0, 200)}`);
    record(6, "PASS", `${called} raised ${answered}; the file landed`);
  } catch (err) {
    record(6, statusOf(err), why(err));
  }

  // 7: the bundled web tools and the old plugin's server, on this boot.
  await bundledMcpStep(7);

  // 8: the setting.
  try {
    if (k.needsYou === undefined) {
      if (k.needsYouMissing !== undefined) block(`the old run left no notifications.needsYou: ${k.needsYouMissing}`);
      fail("the old run's record has no notifications.needsYou, though its Settings step didn't fail: the harness missed it [scripts/acceptance/run.ts keepFacts, ui-steps.ts onSetting]");
    }
    const stored = await c.request<{ settings: { key: string; value?: unknown }[] }>("plugin.settings.get", { id: "clover/settings" });
    const v = stored.settings.find((x) => x.key === "notifications.needsYou")?.value;
    if (v !== k.needsYou) fail(`notifications.needsYou is ${String(v)}; the old run left it ${String(k.needsYou)}`);
    record(8, "PASS", `notifications.needsYou is still ${String(v)}, as the old run left it`);
  } catch (err) {
    record(8, statusOf(err), why(err));
  }

  c.close();
  cdp?.close();
  trustStep();
}

/** The upgrade's last step: no daemon of the run distrusts state the old build signed (the plugin registry's MAC, the
 *  device registry's key); each such line is a FAIL with its text. */
function trustStep(): void {
  const lines = bundledBoots.flatMap((b) => readLog(b.log).match(new RegExp(DISTRUST.source, "g")) ?? []);
  if (bundledBoots.length === 0) record(TOTAL, "BLOCKED", "no daemon started");
  else if (lines.length > 0) record(TOTAL, "FAIL", [...new Set(lines.map((l) => l.trim().slice(0, 250)))].join(" | "));
  else record(TOTAL, "PASS", "no daemon line says the registry or the device key isn't trusted");
}

/** A --keep-state run's facts for the upgrade run, read from the restarted daemon after the window's steps (the setting
 *  step 12 changed). Best effort: what can't be read is left out, and the upgrade run says so for that step. */
async function keepFacts(session: string | undefined, pluginId: string | undefined): Promise<void> {
  if (session !== undefined) keptFacts.session = session;
  if (pluginId !== undefined) keptFacts.pluginId = pluginId;
  // The Settings step recorded what it set (onSetting). Without it, the reason is the old build's own step's, when
  // that step didn't pass; a passing step with no record is the harness's miss, and the upgrade step fails on it.
  if (keptFacts.needsYou !== undefined) return;
  const settingsRow = rows.find((r) => r.name.includes("a setting changed in Settings"));
  if (settingsRow !== undefined && settingsRow.status !== "PASS") keptFacts.needsYouMissing = `the old run's Settings step: ${settingsRow.status}: ${settingsRow.detail.slice(0, 200)}`;
  try {
    const d = await appDriver();
    const stored = await d.client.request<{ settings: { key: string; value?: unknown }[] }>("plugin.settings.get", { id: "clover/settings" });
    const v = stored.settings.find((x) => x.key === "notifications.needsYou")?.value;
    if (typeof v === "boolean") keptFacts.needsYou = v;
    d.client.close();
  } catch (err) {
    say(`keep-state: the setting couldn't be read (${why(err)})`);
  }
}

/** Steps 8 on: the window, driven over the DevTools protocol (ui-steps.ts), on the daemon step 7 restarted. */
async function uiPhase(app: { exe: string; args: string[] }, daemonUp: boolean, session: string | undefined, pressable: boolean): Promise<void> {
  const first = 8;
  const reopened = first + UI_STEPS.length; // after quit and reopen: the same key, one more real press
  const blockAll = (why: string) => { for (let i = 0; i <= UI_STEPS.length; i++) record(first + i, "BLOCKED", why); };
  if (!daemonUp) return blockAll("the daemon didn't come back (step 7)");
  const port = 9300 + Math.floor(Math.random() * 500);
  const env = { ...baseEnv(), CLOVER_DAEMON_BIN: stubBin, CLOVER_TEST_SEALED_PRESS: "1", ...(target === "source" ? { CLOVER_DEV_DEBUG: "1" } : { CLOVER_TEST_DEBUG: "1" }) };
  const proc = startChild("ui-app", app.exe, [...app.args, "--clover-headless", `--clover-capture=${join(root, "capture.png")}`, "--use-mock-keychain", `--remote-debugging-port=${port}`], env);
  let cdp: Cdp | undefined;
  try {
    await until("the window's DevTools port", 120_000, async () => {
      if (!alive(proc.proc)) fail(`the app exited (${proc.proc.exitCode ?? proc.proc.signalCode}): ${firstLine(proc.log, /refusing|refused|failed|error/i) ?? lastLines(proc.log)}`);
      try { cdp = await Cdp.connect(port); return true; } catch { return undefined; }
    }, 500);
    const rpc = (await appDriver()).client;
    await uiSteps({
      cdp: cdp!, rpc, reply: "ACCEPTANCE-REPLY-OK", requests: () => fake?.requests ?? [], appLog: () => readLog(join(home, "logs", "app.log")),
      onSetting: (key, value) => { if (key === "notifications.needsYou" && typeof value === "boolean") keptFacts.needsYou = value; },
    }, (i, status, detail) => record(first + i, status, detail));
    // After quit and reopen (the owner's check 10): this app registers the SAME answer key the first one did (the run's
    // kept key file), and a card's Approve is pressed in its window, the real way.
    try {
      if (!pressable) block(pressing ? "no plugin tool turn runs (steps 3-5), so no card to press" : "--no-press: cards go over RPC");
      const registered = await until("the reopened app's answer key registered", 15_000, () => (/answer key: registered/.test(readLog(proc.log)) ? true : undefined), 300).catch(() => false);
      const notRegistered = firstLine(proc.log, /answer key: not registered/);
      if (notRegistered !== undefined) fail(`${notRegistered.replace(/^\[clover-app\] /, "").trim()} [apps/desktop/src/main/index.ts answerKey → fileVault (CLOVER_TEST_ANSWER_KEY)]`);
      if (registered !== true) fail('the reopened app never logged "answer key: registered"');
      const { cards: carded } = await turn(rpc, session!, "ACCEPTANCE-ECHO: call the echo tool", 150_000, { press: { cdp: cdp!, log: proc.log } });
      const pressed = carded.filter((x) => x.includes("pressed in the window"));
      if (pressed.length === 0) fail(`the turn raised no card to press (${carded.join("; ") || "no card"})`);
      record(reopened, "PASS", `the reopened app registered the same answer key; ${pressed.join("; ")}`);
    } catch (err) {
      record(reopened, statusOf(err), why(err));
    }
  } catch (err) {
    for (let i = 0; i <= UI_STEPS.length; i++) if (!rows.some((r) => r.n === first + i)) record(first + i, "BLOCKED", `the window couldn't be driven: ${why(err)}`);
  } finally {
    cdp?.close();
    await endChild(proc.proc);
  }
}

/** Step 7: the app and the daemon stop; the daemon starts again on the same home, and answers. */
async function restartStep(daemon: { proc: ChildProcess; log: string }, appProc: ChildProcess, session: string | undefined): Promise<boolean> {
  try {
    await endChild(appProc);
    stoppingDaemon = true;
    await endChild(daemon.proc, 20_000);
    if (existsSync(join(home, "run", "core.sock"))) say("the stopped daemon left its socket file");
    const again = await startDaemonProc().catch((err: unknown) => {
      const refused = firstLine(join(logs, `daemon-${daemonRun}.log`), /refus|migration/i);
      return fail(`${why(err)}${refused ? ` (${refused})` : ""}`);
    });
    const d = target === "source" ? await appDriver().catch(() => undefined) : undefined;
    if (d !== undefined && session !== undefined) {
      // The bot side starts after the socket answers (packages/core/src/daemon.ts, `partsReady`).
      const events = await until("the bot side after the restart (session.history)", 60_000, () => history(d.client, session).catch((err: unknown) => {
        if (err instanceof RpcError && /not served yet|while it opens/.test(err.message)) return undefined;
        throw err;
      }), 1_000);
      const kept = JSON.stringify(events).includes("ACCEPTANCE-REPLY-OK");
      record(7, "PASS", `the daemon booted again on the same home${kept ? "; the earlier reply is still in the session" : ""}`);
    } else {
      record(7, "PASS", "the daemon booted again on the same home and serves its socket");
    }
    void again;
    return true;
  } catch (err) {
    record(7, statusOf(err), why(err));
    return false;
  }
}

let code = 0;
// An upgrade's home holds the earlier run's app log: only this run's lines (stamped from now on) count below.
const runStartedAt = new Date().toISOString();
try {
  await main();
} catch (err) {
  console.error(`acceptance: the run itself failed: ${why(err)}`);
  code = 2;
} finally {
  // A run is headless: no window may reach the owner's screen. The app logs "window: shown while headless" whenever one would.
  for (const f of ["app.log.1", "app.log"]) {
    const shown = readLog(join(home, "logs", f)).split("\n").find((l) => /window: shown while headless/.test(l) && !(/^\d{4}-\d\d-\d\dT/.test(l) && l.slice(0, 24) < runStartedAt));
    if (shown !== undefined) { console.error(`acceptance: FAIL: a window was shown during a headless run (${f}): ${shown.slice(0, 300)}`); code = code === 0 ? 1 : code; break; }
  }
  await cleanup();
  const after = listKeychains();
  if (keychainsBefore !== "" && after !== keychainsBefore) {
    console.error("acceptance: WARNING: the keychain search list differs from before the run");
    code = 2;
  }
}
if (coldOnly) for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.n !== TOTAL) rows.splice(i, 1);
for (let n = coldOnly ? TOTAL : 1; n <= TOTAL; n++) if (!rows.some((r) => r.n === n)) rows.push({ n, name: STEPS[n - 1]!, status: "BLOCKED", detail: "not reached" });
rows.sort((a, b) => a.n - b.n);
const w = Math.max(...rows.map((r) => r.name.length));
console.log(`\nClover acceptance (${target}${appBundle ? `: ${appBundle}` : ""})\n`);
console.log(`| # | step${" ".repeat(w - 4)} | result  | first failing call / detail`);
console.log(`|---|${"-".repeat(w + 2)}|---------|----------------------------`);
for (const r of rows) console.log(`| ${r.n} | ${r.name.padEnd(w)} | ${r.status.padEnd(7)} | ${r.detail}`);
const bad = rows.filter((r) => r.status !== "PASS").length;
console.log(`\n${rows.length - bad}/${rows.length} passed`);
process.exit(code !== 0 ? code : bad > 0 ? 1 : 0);
