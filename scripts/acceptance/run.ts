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
//      WebFetch reads a fake public page and is refused a private address; the installed plugin's command hook fires on
//      turn.start under its fence (no write outside its folders, no undeclared host); its stdio MCP server lists to the
//      bot and answers a call, run here under the same fence; and last, the cold start
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
import { CHILD_REPORT, startFakeAnthropic, type FakeProvider } from "./fake-anthropic";
import { Cdp } from "./cdp";
import { shellDoc, dumpFrames, renderNewUser, treeDocs, treeText, UI_STEPS, uiSteps } from "./ui-steps";
import { EXAMPLE_NOTES_STEP, EXAMPLE_WEATHER_STEP, exampleNotesStep, exampleWeatherStep, type ExampleCtx } from "./example-steps";
import { DISTRUST, answerKeyFileFor, keepStateProblem, readState, settingsWithFake, socketPathProblem, statePaths, writeState, type KeptState } from "./state";
import { FAKE_ARTICLE_TEXT, FAKE_PRIVATE_ADDRESS, FAKE_PRIVATE_SITE, FAKE_PUBLIC_SITE, FAKE_SEARCH_HIT, serveOutsideWorld, type OutsideWorld } from "./fake-exa";
import { FAKE_LINKED_PATH, FAKE_LINKS_PATH } from "./fake-exa";

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
// A --keep-state run is the upgrade pair's OLD half: an earlier build, driven by this harness only to leave state behind
// (a key, a conversation, an approved plugin and its "Always" rule, a setting). It asserts nothing of the new build's
// look or features: those checks are skipped or recorded as not asserted on the old build (NOT_ASSERTED_ON_OLD).
const oldHalf = keepState !== undefined;
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
  { name: "reopen while the old daemon is still going (held until the app has dialled it): the window fills once it has gone", delayMs: 0, held: true },
  { name: "reopen after a stop cut off at its bound mid-turn: the turn shows stopped, not thinking, and the next message is answered", delayMs: 0, capped: true },
  { name: "reopen after quitting mid tool call: the call reads interrupted, nothing spins, and the next turn doesn't run it again", delayMs: 0, toolCall: true },
  { name: "a stale socket and core.lock with no daemon: the app has one started, and the window fills", stale: true },
] as const;

/** Alpha's stage tools are display-only (`contained`, her own tree's rule, no special case): the step proves the three
 *  levels on the real path. */
const AGENT_STEP = "Alpha starts her study-buddy on Clover's own coding agent with no card; the agent's row names the definition and the backend, and its report comes back to her conversation";
const STAGE_STEP = "Alpha's stage tool runs with no card at the default level and changes her stage; it asks at \"ask\" and is refused at read-only, where her read-only stage_status still answers with no card";
const FULL_STEPS = [
  "first start: the app pairs and finishes setup",
  "a model key added through the app's methods",
  "a bot turn gets the fake provider's reply",
  "a plugin installs from a folder, its OK card approved",
  "the bot calls the plugin's MCP tool",
  "a write to an ordinary folder lands with no card; one to a sensitive place raises a card, pressed, then lands; a Read of ~/.aws/credentials is refused with no card, an ordinary file reads",
  "the daemon restarts on the same home and boots",
  ...UI_STEPS.map((s) => `window: ${s}`),
  "after quit and reopen: the app registers the same answer key, and a card's Approve is pressed in the window",
  ...REOPEN_STEPS.map((s) => s.name),
  STAGE_STEP,
  AGENT_STEP,
  EXAMPLE_NOTES_STEP,
  EXAMPLE_WEATHER_STEP,
  "each boot lists the bundled web tools within 5 s and offers them; an installed plugin's server lists too",
  "the bot's WebSearch reaches the fake search backend; nothing leaves the machine",
  "the bot's WebFetch reads a page the user gave with no card, asks for an address it made up or a link it found on a page, and is refused a private address",
  "a folder-installed plugin's command hook fires on its event, fenced: no write outside its folders, no undeclared host",
  "a folder-installed plugin's stdio MCP server lists and answers, fenced: no write outside its folders, no undeclared host",
  "a plugin's own network: its granted host through its proxy and nothing else, no direct socket, no borrowed proxy; a pasted MCP config reaches the network, as its card says",
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
  "an \"Always allow\" the old build saved still answers the same call (asking again is acceptable; an error is not)",
  "the daemon trusts the state the old build signed (plugin registry, device key)",
] as const;
const STEPS: readonly string[] = upgrade ? UPGRADE_STEPS : FULL_STEPS;
const TOTAL = STEPS.length;
/** A step's number by the start of its name (the steps after the reopen ones move as steps are added). */
const stepNo = (prefix: string): number => {
  const i = STEPS.findIndex((s) => s.startsWith(prefix));
  if (i < 0) throw new Error(`no step named "${prefix}…"`);
  return i + 1;
};
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
// A sensitive place (a dot-folder in the home): a bot's write there still asks at "ask for risky actions" (§9.1).
const writePath = join(userHome, ".acceptance", upgrade ? `written-upgrade-${randomBytes(3).toString("hex")}.txt` : "written.txt");
// An ordinary one (the user's Downloads): a bot's write there runs with no card (§9.1, the owner's ruling).
const ordinaryWritePath = join(userHome, "Downloads", `acceptance-ordinary-${randomBytes(3).toString("hex")}.txt`);
// A secret place's file (a fake cloud credential in the temp user's home): a bot's Read of it is refused with no card at
// every level (SECRET_READ_PLACES); an ordinary file beside the user's work reads.
const secretReadPath = join(userHome, ".aws", "credentials");
const secretReadValue = `acceptance-secret-${randomBytes(6).toString("hex")}`;
const ordinaryReadPath = join(userHome, "Documents", "acceptance-notes.txt");
const ordinaryReadValue = `acceptance-notes-${randomBytes(6).toString("hex")}`;
// An address the user's message never gave (the bot made it up): it asks.
const composedFetchUrl = `https://${FAKE_PUBLIC_SITE}/article?composed=acceptance`;
/** The address a page the bot reads names (`FAKE_LINKS_PATH`'s text): never one the conversation saw. */
const linkedFetchUrl = `https://${FAKE_PUBLIC_SITE}${FAKE_LINKED_PATH}`;
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
const keptFacts: Pick<KeptState, "session" | "pluginId" | "needsYou" | "needsYouMissing" | "always" | "alwaysMissing"> = {};
/** The full run's steps that test a feature an earlier build may not have: on the old half a FAIL there is recorded as
 *  not asserted on the old build (BLOCKED, saying so), since the old half only leaves state behind. */
const NOT_ASSERTED_ON_OLD = [
  "a write to an ordinary folder lands with no card",
  "window: the model picker lists models and a pick takes",
  "window: Alpha's tab is drawn by Alpha's own layout",
  "window: a pending tool card is drawn by the island",
  "a plugin's own network",
  "window: the composer's slash menu lists a plugin's command",
];
/** What the old half didn't assert in a step that passed (the card's look and size). */
const oldNotAsserted = new Set<string>();
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

/** Ends a child: SIGTERM, then SIGKILL after `graceMs`. True when it exited by itself before the kill. */
async function endChild(proc: ChildProcess, graceMs = 10_000): Promise<boolean> {
  if (proc.pid === undefined || !alive(proc)) return true;
  let alone = true;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ }
  const t = setTimeout(() => { alone = false; try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* gone */ } }, graceMs);
  await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs + 2_000))]);
  clearTimeout(t);
  // Anything the child left in its group.
  try { process.kill(-proc.pid, "SIGKILL"); } catch { /* none */ }
  return alone;
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
  hookTarget?.stop();
  netSite?.stop(true);
  outsideWorld?.stop();
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
    // A core that carries the test build's outside-world seam reaches the run's fakes by name, on loopback.
    started = startChild(`daemon-${daemonRun}`, packagedCore(), ["daemon", "run"], { ...packagedEnv, ...(outsideWorld === undefined ? {} : { CLOVER_TEST_OUTSIDE_WORLD: outsideWorld.spec }) });
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
// What that 5 s protects is a boot's first turn: it waits that long (MCP_FIRST_LISTING_WAIT_MS) at its start for a
// first listing, so the owner's first message after a start is offered the tools. A boot with a turn is judged by that
// turn's request (did it offer them?), on the product's own clock; its listing time is reported. A boot with no turn
// proves nothing for the owner: it fails only past twice the wait (a regression, not a hot machine). The watch goes on
// to BUNDLED_MCP_CEILING_MS so a late listing is timed, not lost.
const BUNDLED_MCP_NO_TURN_MS = 2 * BUNDLED_MCP_WAIT_MS;
const BUNDLED_MCP_CEILING_MS = 20_000;
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
      if ((boot.listed !== undefined && ((run === 1 && !upgrade) || boot.echoMs !== undefined)) || Date.now() - t0 >= BUNDLED_MCP_CEILING_MS) {
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
/** The command hook step's outcome, from the plugin's turn on the first daemon. */
let hookOutcome: { status: Status; detail: string } | undefined;
/** A listener on 127.0.0.1 the fixture's hook must never reach (directly, or through its proxy as an undeclared host). */
let hookTarget: { port: number; connections: number; stop(): void } | undefined;
/** Where the fixture's hook tries to write outside its allowed folders: in the run's user home. */
const hookEscape = (): string => join(userHome, "acceptance-hook-escape");
/** Where the fixture's stdio server tries to write outside its allowed folders. */
const stdioEscape = (): string => join(userHome, "acceptance-stdio-escape");
/** The stdio server step's outcome, from its turn on the first daemon. */
let stdioOutcome: { status: Status; detail: string } | undefined;
/** The plugin network step's outcome, from its turns on the first daemon, and the run's site it reaches. */
let netOutcome: { status: Status; detail: string } | undefined;
let netSite: ReturnType<typeof Bun.serve> | undefined;
const NET_BODY = "ACCEPTANCE-NET-BODY";
/** The open network's line on a pasted server's OK card (packages/plugin-sdk/src/manifest/validate.ts describeOk). */
const OPEN_NETWORK_LINE = "It can reach any host on the network";
/** The first file of that name under a folder (a plugin's data folder in the run's home). */
function findUnder(dir: string, name: string, depth = 8): string | undefined {
  if (depth < 0) return undefined;
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const e of entries) if (e.isFile() && e.name === name) return join(dir, e.name);
  for (const e of entries) if (e.isDirectory()) { const f = findUnder(join(dir, e.name), name, depth - 1); if (f !== undefined) return f; }
  return undefined;
}
/** Step 15's outcome, from its two turns on the first daemon. */
let fetchOutcome: { status: Status; detail: string } | undefined;
/** Step 14's outcome, from its turn on the first daemon. */
let searchOutcome: { status: Status; detail: string } | undefined;
/** What the acceptance daemon logs when its keyed fetch seam refuses a host (scripts/acceptance/daemon.ts). */
const NETWORK_REFUSED = /acceptance daemon: net\.fetch to [^\n]* refused[^\n]*/;

/** Step 14: the search turn's outcome, and no daemon of the run reached for any other host. */
function searchStep(): void {
  const n = stepNo("the bot's WebSearch reaches the fake search backend");
  try {
    for (const b of bundledBoots) {
      const refused = readLog(b.log).match(NETWORK_REFUSED)?.[0];
      if (refused !== undefined) fail(`daemon ${b.run}: ${refused.slice(0, 300)}`);
    }
    if (outsideWorld !== undefined && outsideWorld.refused.length > 0) fail(`the run's loopback outside world was asked for ${[...new Set(outsideWorld.refused)].join(", ")}, a name it doesn't serve`);
    if (searchOutcome === undefined) fail("the search turn didn't run");
    if (searchOutcome!.status !== "PASS") return record(n, searchOutcome!.status, searchOutcome!.detail);
    record(n, "PASS", `${searchOutcome!.detail}; no daemon reached any other host`);
  } catch (err) {
    record(n, statusOf(err), why(err));
  }
}

/** Three before the last step: every boot settled the web server in time (listed, or not served with its reason), none logged a
 *  bundled server's failed listing, and each boot's first turn offered the web tools exactly when they were listed. */
async function bundledMcpStep(n = stepNo("each boot lists the bundled web tools")): Promise<void> {
  try {
    await Promise.all(bundledBoots.map((b) => b.waited));
    if (bundledBoots.length === 0) fail("no daemon started");
    for (const b of bundledBoots) {
      const failed = readLog(b.log).match(BUNDLED_FAILED)?.[0];
      if (failed !== undefined) fail(`daemon ${b.run}: ${failed.slice(0, 400)}`);
      const first = (fake?.requests ?? []).slice(requestsAtBoot[b.run] ?? 0).find((r) => r.path.endsWith("/messages") && r.keyMatched);
      // Without a turn on this boot, the listing's time stands in for the owner's first turn, at twice the wait.
      const limit = first === undefined ? BUNDLED_MCP_NO_TURN_MS : BUNDLED_MCP_CEILING_MS;
      const from = b.graceMs > 0 ? `the registry opening (the run holds it ${b.graceMs / 1000} s after the socket answers)` : "the socket answering";
      if (b.listed === undefined || (b.ms ?? 0) > limit) fail(`daemon ${b.run}: clover/web/web neither listed its tools nor said why it isn't served within ${limit / 1000} s of ${from}${first === undefined ? " (no turn on this boot: twice the wait a turn gives it)" : ""} [packages/core/src/runtime-sdk/turn-loop/plugin-mcp.ts]`);
      const settled = b.listed!;
      const listed = settled.startsWith("listed ");
      // net.fetch crosses the plugin host (packages/core/src/contracts/plugin-host.ts NET_FETCH_CROSSES_PLUGIN_HOST):
      // the web server is offered, never "not served".
      if (!listed) fail(`daemon ${b.run}: clover/web/web ${settled.slice(0, 300)} (net.fetch crosses the plugin host now: it must be listed and offered)`);
      if (!/\bWebSearch\b/.test(settled) || !/\bWebFetch\b/.test(settled)) fail(`daemon ${b.run}: clover/web/web ${settled}, not WebSearch and WebFetch`);
      // A boot after the plugin's install (daemon 1 listed it once installed): its server lists within the time too.
      // An upgrade's boot has the old run's plugin from the start.
      const installed = upgrade ? kept?.pluginId !== undefined : ECHO_LISTED.test(readLog(bundledBoots[0]!.log));
      if ((b.run > 1 || upgrade) && installed && (b.echoMs === undefined || b.echoMs > limit)) fail(`daemon ${b.run}: acceptance-echo/echo, installed before this boot, didn't list its tools within ${limit / 1000} s of ${b.graceMs > 0 ? "the registry opening" : "the socket answering"}${first === undefined ? " (no turn on this boot)" : ""}`);
      if (first === undefined) continue; // no turn on this boot
      // Offered under their exact names.
      const web = first.tools.filter((t) => /(^|__)Web(Search|Fetch)$/.test(t));
      const named = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL].every((t) => first.tools.includes(t));
      if (listed && !named) fail(`daemon ${b.run}: the web tools were listed, but its first turn's request didn't offer ${WEB_SEARCH_TOOL} and ${WEB_FETCH_TOOL} (web tools: ${web.join(", ") || "none"}; tools: ${first.tools.join(", ").slice(0, 300)})`);
      if (!listed && web.length > 0) fail(`daemon ${b.run}: the web server isn't served, yet its first turn offered ${web.join(", ")}`);
    }
    const listedAll = bundledBoots.map((b) => `daemon ${b.run}: clover/web/web ${b.listed!.slice(0, 120)} (${((b.ms ?? 0) / 1000).toFixed(1)} s${(b.ms ?? 0) > BUNDLED_MCP_WAIT_MS ? `, after the ${BUNDLED_MCP_WAIT_MS / 1000} s a turn waits: this boot's first turn still had them` : ""})${b.echoMs === undefined ? "" : `, acceptance-echo/echo listed (${(b.echoMs / 1000).toFixed(1)} s)`}${b.graceMs > 0 ? ` after the registry opened (held ${b.graceMs / 1000} s)` : ""}`).join("; ");
    // An upgrade whose old run approved no plugin can't show the old plugin's server: the web half passed, said so.
    if (upgrade && kept?.pluginId === undefined) block(`the old run left no approved plugin, so its server can't be listed (the web tools: ${listedAll})`);
    record(n, "PASS", listedAll);
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
async function turn(c: CloverClient, session: string, text: string, timeoutMs = 120_000, o: { press?: boolean | { cdp: Cdp; log: string }; /** Looks at a card while it is pending, before it is pressed. */ inspect?: (card: Card) => Promise<void>; /** Answers a card that offers it "Always allow" (over RPC). */ always?: boolean } = {}): Promise<Turn> {
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
          if (o.inspect !== undefined) await o.inspect(card);
          // A turn that presses (step 6's write) presses its cards in the window, the real way; the rest are answered
          // over RPC.
          if (o.press !== undefined && o.press !== false) {
            const by = o.press === true ? (pressCdp === undefined ? undefined : { cdp: pressCdp, log: join(logs, "app.log") }) : o.press;
            if (by === undefined) fail("the first app has no DevTools connection (step 1), so the card can't be pressed the real way");
            await pressApprove(by!.cdp, card, by!.log);
            seenCards.push(`a ${card.kind} card, its Approve pressed in the window (the app signed, the broker checked the proof)`);
            continue;
          }
          const how = await approve(c, card, { always: o.always === true });
          seenCards.push(`a ${card.kind}${card.change !== undefined ? ` (${card.change})` : ""} card, approved${how === "always" ? " (Always allow)" : ""}`);
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
async function approve(c: CloverClient, card: Card, o: { always?: boolean } = {}): Promise<"always" | "once"> {
  await appGotCard(card);
  const always = o.always === true ? card.options.find((x) => x.kind === "approve" && (x as { remember?: string }).remember === "always") : undefined;
  const option = always ?? card.options.find((x) => x.kind === "approve");
  if (option === undefined) fail(`card ${card.kind} has no approve option`);
  const frame = await c.request<{ channel: string }>("card.frame", { id: card.id });
  const children = card.children?.filter((ch) => ch.checked).map((ch) => ch.id);
  const r = await c.request<{ accepted: boolean; reason?: string }>("card.answer", {
    id: card.id, hash: card.hash, option: option!.id,
    proof: { via: "sealed-frame", frame: frame.channel, input: "click", at: Date.now() },
    ...(children !== undefined && children.length > 0 ? { children } : {}),
  });
  if (!r.accepted) fail(`card.answer refused the approval of the ${card.kind} card: ${r.reason ?? "no reason"}`);
  return always !== undefined ? "always" : "once";
}
/** The first app's DevTools connection (step 1), for the run's one real press. */
let pressCdp: Cdp | undefined;
/** Presses the card's Approve on its fallback card, drawn offscreen in a headless run (CLOVER_TEST_SEALED_PRESS): the
 *  pointer enters, the page's own second passes, then a trusted DevTools click on the button. The answer goes the
 *  whole real way (the page's gates, the app's signature with its registered answer key, `card.answer` with a device
 *  proof, the broker's #verify); the app's log says how it went, and a refusal fails the step with its line. */
/** The plain Approve: never the "Always allow" button (the island's quiet one, the fallback's `data-remember`), unless a step asks for it by name. */
const PLAIN_APPROVE = ".seal-button[data-kind=approve]:not(.quiet):not([data-remember])";
async function pressApprove(cdp: Cdp, card: Card, appLog = join(logs, "app.log")): Promise<void> {
  await appGotCard(card, appLog);
  const from = readLog(appLog).length;
  // The card is pressed where the app drew it: its island's own sealed button, or the fallback card's. A press can land on
  // a frame that goes away a moment later (a plugin install remounts the island's layer, and the island folds a card back
  // into its strip), so a press that brings no answer within a few seconds is made again on whatever is drawn then, the
  // fallback card included, until the card's time is up. Each attempt notes what it pressed, for the failure line.
  const cardUrl = `clover-sealed://card/${encodeURIComponent(card.id)}/`;
  const tried: string[] = [];
  const deadline = Date.now() + 45_000;
  let fallbackChecked = false;
  while (Date.now() < deadline) {
    const found = await until(`the ${card.kind} card's Approve (the island's button or the fallback page, drawn offscreen)`, Math.max(1_000, Math.min(20_000, deadline - Date.now())), async () => {
      const docs = await cdp.documents();
      const own = docs.find((d) => d.url.startsWith(`${cardUrl}own`));
      if (own !== undefined) return own;
      for (const d of docs.filter((x) => decodeURIComponent(x.url).startsWith(`${cardUrl}button:`))) {
        if ((await cdp.evaluate(d.session, "!!document.querySelector('.seal-button[data-kind=approve]:not(.quiet):not([data-remember])')").catch(() => false)) === true) return d;
      }
      return undefined;
    }, 300).catch((err: unknown) => fail(`${why(err)}: ${firstLine(appLog, new RegExp(`fallback card for ${card.id}`)) ?? "the app logged nothing about its fallback"}${tried.length ? `; pressed before: ${tried.join(" | ")}` : ""} [apps/desktop/src/main/index.ts showFallbackCard]`));
    const isOwn = found.url.startsWith(`${cardUrl}own`);
    if (isOwn && !fallbackChecked) { await fallbackLooksRight(cdp, found.session, card); fallbackChecked = true; }
    const s = found.session;
    const btn = await until("the card's Approve button", 10_000, () => cdp.centerOf(s, PLAIN_APPROVE), 300).catch(() => undefined);
    if (btn === undefined) { tried.push(`${isOwn ? "fallback" : "island"}: no button`); continue; }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: btn.x, y: btn.y, button: "none", buttons: 0 }, s).catch(() => undefined);
    // The page says when it will take a press (body[data-ready], its own gates: visible, shown long enough, the pointer in);
    // the press waits for that, as a person's would. A page that never says (an older build) gets the fixed wait.
    const readySeen = await until("the page's ready-to-answer mark", 10_000, async () => {
      const v = await cdp.evaluate(s, "document.body.dataset.ready ?? 'none'").catch(() => "gone");
      return v === "yes" || v === "none" || v === "gone" ? v : undefined;
    }, 100).catch(() => "never");
    await sleep(readySeen === "none" ? 1_500 : 300);
    const state = await cdp.evaluate(s, "JSON.stringify({answering:document.body.dataset.answering??null,answered:document.body.dataset.answered??null,ready:document.body.dataset.ready??null,state:(document.querySelector('.state')||{}).textContent??null,w:innerWidth,h:innerHeight})").catch(() => "gone");
    await cdp.click(s, btn.x, btn.y).catch(() => undefined);
    tried.push(`${isOwn ? "fallback" : "island"} at ${Math.round(btn.x)},${Math.round(btn.y)} ${String(state)}`);
    const verdict = await until(`the app's answer for the ${card.kind} card`, 5_000, () => {
      const text = readLog(appLog).slice(from);
      if (text.includes(`sealed: answer accepted for ${card.id}`)) return "accepted";
      return /sealed: (?:core refused answer|answer held back|answer refused)[^\n]*/.exec(text)?.[0];
    }, 300).catch(() => undefined);
    if (verdict === "accepted") return;
    if (verdict !== undefined) fail(`the press on the ${card.kind} card's Approve: ${verdict.trim()} [apps/desktop/src/main/index.ts sealedAnswer → packages/core/src/approvals/broker.ts #verify]`);
  }
  fail(`the press on the ${card.kind} card's Approve reached nothing in 45 s (no "sealed:" line in app.log); pressed: ${tried.join(" | ")} [scripts/acceptance/run.ts pressApprove → apps/desktop/src/main/sealed-pages.ts ownCardPage]`);
}

/** The fallback card is a small window with the card's one line and a short preview, never the raw input: within the size
 *  limits (apps/desktop/src/main/index.ts FALLBACK_*), and its visible text holds no JSON key or literal `\\n`. */
async function fallbackLooksRight(cdp: Cdp, session: string, card: Card): Promise<void> {
  // The card's look and size are the new build's: an old build's card is pressed, not judged.
  if (oldHalf) { oldNotAsserted.add(`the ${card.kind} card's look and size`); return; }
  const seen = await cdp.evaluate(session, "JSON.stringify({w:innerWidth,h:innerHeight,text:document.body.innerText})") as string;
  const { w, h, text } = JSON.parse(seen) as { w: number; h: number; text: string };
  if (w > 480 || h > 600) fail(`the ${card.kind} card's fallback window is ${w}x${h}, over 480x600 [apps/desktop/src/main/index.ts FALLBACK_*]`);
  const raw = /"(?:old_string|new_string|file_path|content|command)"\s*:|\\n/.exec(text);
  if (raw !== null) fail(`the ${card.kind} card's fallback shows raw JSON ("${text.slice(Math.max(0, raw.index - 20), raw.index + 40).replace(/\n/g, " ")}") [apps/desktop/src/main/sealed-pages.ts ownCardPage]`);
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
  fake = startFakeAnthropic({ key: dummyKey, writePath, writeContent, ordinaryWritePath, composedFetchUrl, linkedFetchUrl });
  if (target === "packaged" && packagedCoreSays("CLOVER_TEST_OUTSIDE_WORLD")) startOutsideWorld();
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
  const pressPort = freePort();
  // The renders' scheme for the first app (the new user's Plugins page, before step 4 installs anything).
  const firstAppearance = join(root, "appearance-first");
  const appEnv = {
    ...baseEnv(), CLOVER_DAEMON_BIN: stubBin, CLOVER_SMOKE_KEEP: "1", CLOVER_SMOKE_OUT: smokeOut, CLOVER_SMOKE_DEADLINE_MS: "45000",
    CLOVER_TEST_SEALED_PRESS: "1", CLOVER_TEST_APPEARANCE_FILE: firstAppearance, ...(target === "source" ? { CLOVER_DEV_DEBUG: "1" } : { CLOVER_TEST_DEBUG: "1" }),
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
    // Registered within 10 s of the shell, before any card could be pressed. A wait on the way (a device registry still
    // opening, under load) is the retry working and reads "answer key: waiting…"; "not registered" is the core's no or
    // the give-up, and fails at once.
    const registered = await until("the app's answer key registered (app.log)", 10_000, () => {
      const refused = firstLine(appLog, /answer key: not registered/);
      if (refused !== undefined) return refused;
      return /answer key: registered/.test(readLog(appLog)) ? true : undefined;
    }, 300).catch(() => false);
    if (typeof registered === "string") fail(`${registered.trim()} [apps/desktop/src/main/answer-key.ts KeyRegistration → device.answerKey.set, packages/core/src/devices/rpc.ts answerKeyMethods]`);
    const waited = readLog(appLog).split("\n").filter((l) => /answer key: (waiting|trying again)/.test(l)).length;
    if (registered !== true) fail(`the app's answer key wasn't registered within 10 s of the shell (its last line: ${(readLog(appLog).split("\n").filter((l) => /answer key: /.test(l)).at(-1) ?? "none").trim()}) [apps/desktop/src/main/index.ts onConnected]`);
    record(1, "PASS", `the app paired (protocol.hello, onConnected's setup), registered its answer key${waited > 0 ? " (after waiting for the core to take it)" : ""} and drew the shell, headless`);
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
    else if (mine.some((r) => r.answered === "torn")) fail(`the turn's request reached the fake but its body never arrived whole (${mine.filter((r) => r.answered === "torn").map((r) => r.torn).join("; ")}): stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""}`);
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

  // The renders (CLOVER_ACCEPT_RENDERS): the Plugins page as a new user sees it, signed in (step 2) and nothing installed
  // yet. A picture, never a check.
  const renders = process.env.CLOVER_ACCEPT_RENDERS;
  if (renders && pressCdp !== undefined) say(await renderNewUser(pressCdp, renders, (scheme) => writeFileSync(firstAppearance, scheme)));

  // Step 4: the fixture plugin from a local folder, and its OK card.
  let pluginId: string | undefined;
  let pluginOk = false;
  try {
    // A kept run's plugin folder stays with its user home, as a user's own folder would.
    const folder = join(stateDir !== undefined ? userHome : root, "plugin-src", "acceptance-echo");
    cpSync(join(import.meta.dir, "fixtures", "acceptance-echo"), folder, { recursive: true });
    // The command hook's targets, written before the install so its OK covers them: a listener it must not reach and
    // a path outside its folders it must not write.
    if (hookTarget === undefined) {
      const t = { port: 0, connections: 0, stop: () => {} };
      const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { t.connections += 1; s.end(); }, data() {} } });
      t.port = l.port;
      t.stop = () => l.stop(true);
      hookTarget = t;
    }
    writeFileSync(join(folder, "hooks", "targets"), `${hookTarget.port}\n${hookEscape()}\n`);
    // The stdio server's: the same listener, and a path of its own outside its folders.
    writeFileSync(join(folder, "stdio", "targets"), `${hookTarget.port}\n${stdioEscape()}\n`);
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
    record(4, "PASS", `plugin.install (folder) → ${installed.state}; the ${card.kind} card listed and read, ${pressing ? "its Approve pressed in the window (the app signed, the broker checked the proof)" : "approved over RPC (--no-press)"}; now ${state}${oldNotAsserted.size > 0 ? `; not asserted on the old build: ${[...oldNotAsserted].join(", ")}` : ""}`);
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
      // The old half answers the call's card "Always allow", the rule the upgrade then asks about.
      const { events, cards: carded } = await turn(c, session, "ACCEPTANCE-ECHO: call the echo tool", 150_000, oldHalf ? { always: true } : {});
      const mine = fake.requests.slice(seen);
      const offered = mine.find((r) => r.tools.length > 0)?.tools ?? [];
      if (oldHalf) {
        const kept = mine.find((r) => r.toolUse !== undefined)?.toolUse;
        if (kept !== undefined && carded.some((x) => x.includes("(Always allow)"))) keptFacts.always = { tool: kept };
        else keptFacts.alwaysMissing = carded.length === 0 ? "the Echo call raised no card on the old build" : `the Echo call's card offered no "Always allow" on the old build (${carded.join("; ")})`;
      }
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

  // The command hook step (recorded at the end): step 5's turn started with the fixture's `turn.start` command hook,
  // which runs under its plugin's fence (pluginHookSpawner): it writes what it saw to its own data folder; the run checks
  // that, the disk and its own listener.
  if (session === undefined || !turnsWork) hookOutcome = { status: "BLOCKED", detail: "no bot turn reaches the fake provider (step 3)" };
  else if (pluginId === undefined || !pluginOk) hookOutcome = { status: "BLOCKED", detail: "the plugin isn't installed and approved (step 4)" };
  else {
    try {
      const probe = await until("the command hook's note in its data folder", 30_000, async () => {
        const dir = join(home, "plugin-data");
        for (const name of existsSync(dir) ? readdirSync(dir) : []) {
          const f = join(dir, name, "hook-probe.txt");
          if (existsSync(f)) return { file: f, text: readFileSync(f, "utf8") };
        }
        return undefined;
      });
      const seen = Object.fromEntries(probe.text.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      if (seen.event !== "turn.start") fail(`the hook ran, but on ${JSON.stringify(seen.event)}, not turn.start (${probe.text.trim()})`);
      if (seen.outside !== "denied" || existsSync(hookEscape())) fail(`the hook wrote outside its folders (${hookEscape()}): ${probe.text.trim()}`);
      const tree = join(stateDir !== undefined ? userHome : root, "plugin-src", "acceptance-echo", "escaped");
      if (seen.tree !== "denied" || existsSync(tree)) fail(`the hook wrote into its plugin's folder: ${probe.text.trim()}`);
      if (seen.direct !== "denied") fail(`the hook reached 127.0.0.1:${hookTarget?.port} directly: ${probe.text.trim()}`);
      if (seen.proxied === "200") fail(`the hook's proxy let it reach an undeclared host: ${probe.text.trim()}`);
      if ((hookTarget?.connections ?? 0) > 0) fail(`the run's listener was reached ${hookTarget!.connections} time(s) from the hook`);
      hookOutcome = { status: "PASS", detail: `acceptance-echo's probe hook fired on turn.start (its note in ${probe.file.slice(home.length + 1)}); a write outside its folders and into its tree was refused, 127.0.0.1:${hookTarget?.port} wasn't reached directly, and its proxy answered ${seen.proxied} for the undeclared host; the listener saw 0 connections` };
    } catch (err) {
      hookOutcome = { status: statusOf(err), detail: why(err) };
    }
  }

  // The stdio server step (recorded at the end): the fixture's `probe` server is a stdio one, which runs on this computer
  // (ticked here by the plugin's OK) through lane J's launcher, fenced (B's guard: its folders, its tree's proxy). Its
  // tool lists to the bot, answers a call, and reports what its fence let it do; the run checks the disk and its
  // listener too.
  if (session === undefined || !turnsWork) stdioOutcome = { status: "BLOCKED", detail: "no bot turn reaches the fake provider (step 3)" };
  else if (pluginId === undefined || !pluginOk) stdioOutcome = { status: "BLOCKED", detail: "the plugin isn't installed and approved (step 4)" };
  else {
    try {
      const listeners = hookTarget?.connections ?? 0;
      const seen = fake.requests.length;
      const { events, cards: carded } = await turn(c, session, "ACCEPTANCE-STDIO: call the stdio probe", 150_000);
      const mine = fake.requests.slice(seen);
      const offered = mine.find((r) => r.tools.length > 0)?.tools ?? [];
      const called = mine.find((r) => r.toolUse !== undefined)?.toolUse;
      const result = mine.find((r) => r.toolResult !== undefined)?.toolResult;
      if (called === undefined) fail(`the bot was offered no StdioProbe (${offered.length} tools, plugin tools: ${offered.filter((t) => t.startsWith("mcp__")).join(", ") || "none"})`);
      if (result === undefined) fail(`the bot called ${called} but no tool result came back (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""})`);
      if (result!.isError || !result!.text.includes("acceptance-stdio-pong")) fail(`${called} answered with an error: ${result!.text.slice(0, 300)}`);
      const said = Object.fromEntries(result!.text.slice(result!.text.indexOf("acceptance-stdio-pong")).split(/\s+/).slice(1).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
      const tree = join(stateDir !== undefined ? userHome : root, "plugin-src", "acceptance-echo", "escaped-stdio");
      if (said.outside !== "denied" || existsSync(stdioEscape())) fail(`the stdio server wrote outside its folders (${stdioEscape()}): ${result!.text.slice(0, 300)}`);
      if (said.tree !== "denied" || existsSync(tree)) fail(`the stdio server wrote into its plugin's folder: ${result!.text.slice(0, 300)}`);
      if (said.direct !== "denied") fail(`the stdio server reached 127.0.0.1:${hookTarget?.port} directly: ${result!.text.slice(0, 300)}`);
      if (said.proxied === "200") fail(`the stdio server's proxy let it reach an undeclared host: ${result!.text.slice(0, 300)}`);
      if ((hookTarget?.connections ?? 0) > listeners) fail(`the run's listener was reached ${(hookTarget?.connections ?? 0) - listeners} time(s) from the stdio server`);
      if (said.data !== "written") fail(`the stdio server couldn't write its own data folder (the fence refuses everything?): ${result!.text.slice(0, 300)}`);
      stdioOutcome = { status: "PASS", detail: `the bot was offered and called ${called} (acceptance-echo's stdio server, run here); it wrote its data folder, a write outside its folders and into its tree was refused, 127.0.0.1:${hookTarget?.port} wasn't reached directly, and its proxy answered ${said.proxied} for the undeclared host; the listener saw 0 connections${carded.length ? ` (${carded.join("; ")})` : ""}` };
    } catch (err) {
      stdioOutcome = { status: statusOf(err), detail: why(err) };
    }
  }

  // The plugin network step (its turns here, on the first daemon; recorded at the end): a folder-installed plugin
  // granted one host (`network:localhost:<the run's site>`), whose stdio tool reaches it through its own proxy (the
  // token in its HTTP_PROXY), is refused a host it wasn't granted (the proxy's 403) and a direct socket (the fence); the
  // first plugin's stdio server, given the second's proxy and token, can't use them; and a pasted MCP config (the
  // owner's ruling: a server the user added reaches any host, said on its card) reaches the site straight.
  if (session === undefined || !turnsWork) netOutcome = { status: "BLOCKED", detail: "no bot turn reaches the fake provider (step 3)" };
  else if (pluginId === undefined || !pluginOk) netOutcome = { status: "BLOCKED", detail: "the first plugin isn't installed and approved (step 4): no stdio server to borrow with" };
  else {
    try {
      netSite = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => (new URL(req.url).pathname === "/net-page" ? new Response(NET_BODY) : new Response("not here", { status: 404 })) });
      const port = netSite.port;
      const parse = (text: string, mark: string) => Object.fromEntries(text.slice(text.indexOf(mark)).split(/\s+/).slice(1).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
      const probeTurn = async (ask: string, mark: string) => {
        const seen = fake!.requests.length;
        const { events, cards: carded } = await turn(c, session!, ask, 150_000);
        const mine = fake!.requests.slice(seen);
        // The probe's own call and answer (a deferred probe is loaded through Glossary first).
        const called = mine.map((r) => r.toolUse).find((t) => t !== undefined && /(NetProbe|StdioProbe)$/.test(t)) ?? mine.find((r) => r.toolUse !== undefined)?.toolUse;
        const result = mine.map((r) => r.toolResult).find((x) => x !== undefined && x.text.includes(mark)) ?? mine.find((r) => r.toolResult !== undefined)?.toolResult;
        if (called === undefined) fail(`"${ask}": no tool was called (${mine.map((r) => r.answered).join(", ")}; offered: ${(mine.find((r) => r.tools.length > 0)?.tools ?? []).filter((t) => t.startsWith("mcp__")).join(", ") || "none"})`);
        if (result === undefined || !result.text.includes(mark)) fail(`${called} gave no answer of its own (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""}; ${result?.text.slice(0, 200) ?? "no result"})`);
        return { called: called!, said: parse(result!.text, mark), text: result!.text, cards: carded };
      };
      const install = async (source: Record<string, unknown>) => {
        const installed = await c.request<{ id: string; card?: string }>("plugin.install", { source }, 60_000);
        const card = await until(`${installed.id}'s OK card`, 30_000, async () => (await cards(c)).find((k) => (installed.card !== undefined && k.id === installed.card) || k.pluginId === installed.id));
        const text = JSON.stringify((await c.request<{ card: Card }>("card.get", { id: card.id })).card);
        await approve(c, card);
        await until(`${installed.id} to be enabled after its OK`, 60_000, async () => {
          const st = (await c.request<{ plugin?: { state?: string } }>("plugin.get", { id: installed.id }).catch(() => undefined))?.plugin?.state;
          return st === "enabled" || st === "running" ? st : undefined;
        });
        return { id: installed.id, text };
      };
      // 1: the granted plugin.
      const folder = join(stateDir !== undefined ? userHome : root, "plugin-src", "acceptance-net");
      cpSync(join(import.meta.dir, "fixtures", "acceptance-net"), folder, { recursive: true });
      writeFileSync(join(folder, "clover.json"), readFileSync(join(folder, "clover.json"), "utf8").replace("ACCEPTANCE_NET_PORT", String(port)));
      writeFileSync(join(folder, "stdio", "targets"), `${port}\n${hookTarget?.port ?? 9}\n`);
      const net = await install({ from: "folder", path: folder });
      if (!net.text.includes(`localhost:${port}`)) fail(`${net.id}'s OK card doesn't name the host it's granted (localhost:${port}): ${net.text.slice(0, 300)}`);
      // Every part runs and is said, the wrong ones together at the end (one run shows all of them).
      const wrong: string[] = [];
      const listeners = hookTarget?.connections ?? 0;
      const own = await probeTurn(`ACCEPTANCE-NETPROBE acceptance-net`, "acceptance-net-pong");
      // The site listens on 127.0.0.1 only, as most local services do; `localhost` may resolve to ::1 first.
      if (!own.said.granted?.startsWith("200:") || !own.said.granted.includes(NET_BODY)) wrong.push(`${own.called} didn't reach its granted host (localhost:${port}, a service on 127.0.0.1) through its proxy: granted=${own.said.granted} [packages/core/src/plugin-host/net-proxy.ts open: one resolved address]`);
      if (own.said.proxied !== "yes") wrong.push(`${own.called} was given no proxy (HTTP_PROXY)`);
      if (own.said.ungranted === "200") wrong.push(`${own.called}'s proxy let it reach localhost:${hookTarget?.port}, a port it wasn't granted`);
      if (own.said.direct !== "denied") wrong.push(`${own.called} connected to 127.0.0.1:${port} around its proxy (direct=${own.said.direct})`);
      if ((hookTarget?.connections ?? 0) > listeners) wrong.push(`the run's listener was reached ${(hookTarget?.connections ?? 0) - listeners} time(s) from ${net.id}`);
      // 2: its proxy and token, borrowed by the first plugin's stdio server (no network grant).
      const proxyFile = findUnder(home, "acceptance-net-proxy");
      const echoData = findUnder(home, "stdio-probe-data.txt");
      if (proxyFile === undefined) fail(`${net.id}'s server left no proxy URL in its data folder (acceptance-net-proxy)`);
      if (echoData === undefined) fail("the first plugin's stdio server has no data folder to leave the borrowed proxy in (its stdio step didn't run)");
      writeFileSync(join(dirname(echoData!), "acceptance-borrow"), `${readFileSync(proxyFile!, "utf8").trim()}\nlocalhost:${port}\n`);
      const borrow = await probeTurn("ACCEPTANCE-STDIO: call the stdio probe", "acceptance-stdio-pong");
      rmSync(join(dirname(echoData!), "acceptance-borrow"), { force: true });
      if (borrow.said.borrowed === undefined || borrow.said.borrowed === "none") wrong.push(`the first plugin's stdio server didn't try the borrowed proxy: ${borrow.text.slice(0, 200)}`);
      if (borrow.said.borrowed === "200") wrong.push(`the first plugin's stdio server used ${net.id}'s proxy and token to reach localhost:${port}`);
      // 3: the same probe pasted as an MCP config: open network, said on its card, reaching the site straight. It runs
      // inline (`bun -e`, stdio/inline.js: an argument is at most 4096 characters), its ports in the config's env (which the wrap keeps as the plugin's secrets): a pasted server
      // reads nothing in the user's home outside the tool folders (plugin-fence.ts TOOL_READ_DIRS), so a script there
      // wouldn't start.
      const wrapped = await install({ from: "wrap", kind: "mcp-config", value: JSON.stringify({ mcpServers: { accnet: { command: "bun", args: ["-e", readFileSync(join(folder, "stdio", "inline.js"), "utf8")], env: { ACCEPTANCE_NET_PORTS: `${port},${hookTarget?.port ?? 9}` } } } }) });
      if (!wrapped.text.includes(OPEN_NETWORK_LINE)) wrong.push(`${wrapped.id}'s OK card doesn't say it reaches any host ("${OPEN_NETWORK_LINE}…"): ${wrapped.text.slice(0, 300)}`);
      let pastedSeen = "not run";
      try {
        const pasted = await probeTurn("ACCEPTANCE-NETPROBE accnet", "acceptance-net-pong");
        pastedSeen = pasted.text.slice(pasted.text.indexOf("acceptance-net-pong") + 20, pasted.text.indexOf("acceptance-net-pong") + 200);
        if (!pasted.said.granted?.startsWith("200:") || !pasted.said.granted.includes(NET_BODY)) wrong.push(`${pasted.called} (a pasted config, open network) didn't reach the run's site: granted=${pasted.said.granted}`);
      } catch (err) {
        wrong.push(`the pasted config's NetProbe: ${why(err)}`);
      }
      const seenAll = `own: ${own.text.slice(own.text.indexOf("acceptance-net-pong") + 20, own.text.indexOf("acceptance-net-pong") + 200)}; borrowed=${borrow.said.borrowed}; pasted: ${pastedSeen}`;
      if (wrong.length > 0) fail(`${wrong.join("; ")} (seen: ${seenAll})`);
      netOutcome = { status: "PASS", detail: `${net.id} (card: localhost:${port}) reached its granted host through its proxy (${own.said.granted!.split(":")[0]}), was refused a port it wasn't granted (${own.said.ungranted}) and a direct socket; the first plugin's server, given ${net.id}'s proxy and token, got ${borrow.said.borrowed}; ${wrapped.id}, pasted (its card: "${OPEN_NETWORK_LINE}…"), reached the site (${pastedSeen})${own.cards.length ? `; cards: ${own.cards.join("; ")}` : ""}` };
    } catch (err) {
      netOutcome = { status: statusOf(err), detail: why(err) };
    }
  }

  // Step 14 (its turn here, on the first daemon; recorded at the end with the daemons' logs): the bot's WebSearch, the
  // bundled web plugin's tool, through the plugin host's net.fetch to the fake search backend (fake-exa.ts) that the
  // acceptance daemon's keyed fetch seam serves; every other host is refused there and logged.
  if (session === undefined || !turnsWork) searchOutcome = { status: "BLOCKED", detail: "no bot turn reaches the fake provider (step 3)" };
  // Only the source daemon has the fake search backend (its keyed fetch seam): a packaged core would search the real
  // web, which a run never does.
  else if (skipWebTurns) searchOutcome = { status: "BLOCKED", detail: "--skip-web-turns: this tree's daemon has no fake web seam, so its web turns aren't run (they could reach the real web)" };
  else if (target !== "source" && outsideWorld === undefined) searchOutcome = { status: "BLOCKED", detail: "this packaged core has no test seam for the outside world (CLOVER_TEST_OUTSIDE_WORLD, an earlier build); the run never searches the real web" };
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
  else if (target !== "source" && outsideWorld === undefined) fetchOutcome = { status: "BLOCKED", detail: "this packaged core has no test seam for the outside world (CLOVER_TEST_OUTSIDE_WORLD, an earlier build); the run never fetches the real web" };
  else {
    try {
      const fetchTurn = async (url: string) => {
        const seen = fake!.requests.length;
        const ask = url === composedFetchUrl ? "ACCEPTANCE-FETCH-COMPOSED" : url === linkedFetchUrl ? "ACCEPTANCE-FETCH-LINKED" : `ACCEPTANCE-FETCH ${url}`;
        const { events, cards: carded } = await turn(c, session!, ask, 150_000);
        const mine = fake!.requests.slice(seen);
        const called = mine.find((r) => r.toolUse !== undefined)?.toolUse;
        const result = mine.find((r) => r.toolResult !== undefined)?.toolResult;
        if (called === undefined) fail(`the bot was offered no WebFetch (MCP tools: ${(mine.find((r) => r.tools.length > 0)?.tools ?? []).filter((t) => t.startsWith("mcp__")).join(", ") || "none"})`);
        if (result === undefined) fail(`the bot called ${called} but no tool result came back (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""})`);
        return { called: called!, result: result!, cards: carded };
      };
      // The address is in the user's message: it runs with no card at ask for risky actions (§9.1).
      const page = await fetchTurn(`https://${FAKE_PUBLIC_SITE}/article`);
      if (page.called !== WEB_FETCH_TOOL) fail(`the bot's WebFetch is ${page.called}, not ${WEB_FETCH_TOOL}`);
      if (page.result.isError || !page.result.text.includes(FAKE_ARTICLE_TEXT)) fail(`${page.called} didn't read the public page: ${page.result.text.slice(0, 300)}`);
      if (page.cards.length > 0) fail(`a fetch of the address the user gave raised ${page.cards.join("; ")} (it should run with no card) [packages/core/src/approvals/seen-urls.ts]`);
      // An address the bot made up (no message or search hit gave it): the reviewer, then a card, approved here.
      const composed = await fetchTurn(composedFetchUrl);
      if (composed.cards.length === 0) fail(`a fetch of an address the bot made up raised no card: ${composed.result.text.slice(0, 200)} [packages/core/src/approvals/bot-check.ts]`);
      if (composed.result.isError || !composed.result.text.includes(FAKE_ARTICLE_TEXT)) fail(`${composed.called}, approved, didn't read the page: ${composed.result.text.slice(0, 300)}`);
      // A link taken from a page the bot read (the user gave the page, not the link): not contained, so the reviewer
      // (none in this run), then a card, approved here (the controller's amended R3: a page never feeds the seen set).
      const links = await fetchTurn(`https://${FAKE_PUBLIC_SITE}${FAKE_LINKS_PATH}`);
      if (links.cards.length > 0) fail(`a fetch of the links page the user gave raised ${links.cards.join("; ")} (it should run with no card)`);
      if (links.result.isError || !links.result.text.includes(linkedFetchUrl)) fail(`${links.called} didn't read the links page: ${links.result.text.slice(0, 300)}`);
      const linked = await fetchTurn(linkedFetchUrl);
      if (linked.cards.length === 0) fail(`a fetch of a link taken from a fetched page raised no card: ${linked.result.text.slice(0, 200)} [packages/core/src/approvals/seen-urls.ts]`);
      if (linked.result.isError || !linked.result.text.includes(FAKE_ARTICLE_TEXT)) fail(`${linked.called}, approved, didn't read the linked page: ${linked.result.text.slice(0, 300)}`);
      const inside = await fetchTurn(`https://${FAKE_PRIVATE_SITE}/x`);
      if (!inside.result.isError || !/private address/.test(inside.result.text)) fail(`${inside.called} wasn't refused the private address: ${inside.result.text.slice(0, 300)}`);
      // The model reads that the name resolves to a private address, never which one (that stays in the daemon's log).
      if (inside.result.text.includes(FAKE_PRIVATE_ADDRESS)) fail(`${inside.called}'s refusal names the private address to the model: ${inside.result.text.slice(0, 300)}`);
      // A LAN address itself, in the same run (a packaged test build's seam maps only the run's own names).
      const lan = await fetchTurn("http://192.168.1.10/router");
      if (!lan.result.isError || !/private address/.test(lan.result.text)) fail(`${lan.called} wasn't refused a LAN address: ${lan.result.text.slice(0, 300)}`);
      fetchOutcome = { status: "PASS", detail: `${page.called} read the page the user gave with no card; the made-up address raised ${composed.cards.join("; ")}; a link from a fetched page raised ${linked.cards.join("; ")}; ${FAKE_PRIVATE_SITE} was refused ("${inside.result.text.slice(0, 120)}")` };
    } catch (err) {
      fetchOutcome = { status: statusOf(err), detail: why(err) };
    }
  }

  // Step 6: at "ask for risky actions" (§9.1): a write to an ordinary folder (Downloads) lands with no card; a write to a
  // sensitive place (a dot-folder in the home) raises an approval card, the app's yes is pressed, then the file lands.
  if (session === undefined || !turnsWork) record(6, "BLOCKED", "no bot turn reaches the fake provider (step 3)");
  else {
    try {
      const before = fake.requests.length;
      const plain = await turn(c, session, "ACCEPTANCE-WRITE-ORDINARY: write the file", 150_000);
      const plainResult = fake.requests.slice(before).find((r) => r.toolResult !== undefined)?.toolResult;
      const plainLanded = existsSync(ordinaryWritePath) && readFileSync(ordinaryWritePath, "utf8") === writeContent;
      if (plain.cards.length > 0) fail(`a write to an ordinary folder raised ${plain.cards.join("; ")} (it should run with no card at ask for risky actions) [packages/core/src/approvals/ordinary-paths.ts]`);
      if (!plainLanded) fail(`the write to an ordinary folder didn't land; its result: ${(plainResult?.text ?? "none").slice(0, 200)}`);
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
      // A Read of a secret place's file: refused with no card, the class named, nothing of the file shown; an ordinary
      // file reads. Both made here, in the run's own user home.
      mkdirSync(dirname(secretReadPath), { recursive: true, mode: 0o700 });
      writeFileSync(secretReadPath, `[default]\naws_secret_access_key = ${secretReadValue}\n`, { mode: 0o600 });
      mkdirSync(dirname(ordinaryReadPath), { recursive: true, mode: 0o700 });
      writeFileSync(ordinaryReadPath, ordinaryReadValue);
      const readSeen = fake.requests.length;
      const secret = await turn(c, session, `ACCEPTANCE-READ ${secretReadPath}`, 150_000);
      const secretResult = fake.requests.slice(readSeen).find((r) => r.toolResult !== undefined)?.toolResult;
      if (secret.cards.length > 0) fail(`a Read of ~/.aws/credentials raised ${secret.cards.join("; ")} (it is refused with no card) [packages/core/src/fence/secret-reads.ts]`);
      if (secretResult === undefined) fail("the Read of ~/.aws/credentials got no result back to the model");
      if (secretResult!.text.includes(secretReadValue)) fail("the Read of ~/.aws/credentials showed the model the file's value");
      if (!secretResult!.text.includes("cloud credentials")) fail(`the Read of ~/.aws/credentials wasn't refused as a secret place: ${secretResult!.text.slice(0, 200)}`);
      const ordSeen = fake.requests.length;
      const ord = await turn(c, session, `ACCEPTANCE-READ ${ordinaryReadPath}`, 150_000);
      const ordResult = fake.requests.slice(ordSeen).find((r) => r.toolResult !== undefined)?.toolResult;
      if (ord.cards.length > 0) fail(`a Read of an ordinary file raised ${ord.cards.join("; ")}`);
      if (ordResult?.text.includes(ordinaryReadValue) !== true) fail(`the Read of an ordinary file didn't read it: ${(ordResult?.text ?? "none").slice(0, 200)}`);
      record(6, "PASS", `a write to Downloads landed with no card; ${called} to a dot-folder raised ${answered}; the file landed; a Read of ~/.aws/credentials was refused with no card ("${secretResult!.text.slice(0, 120)}"); an ordinary file read`);
    } catch (err) {
      record(6, statusOf(err), why(err));
    }
  }

  await stageStep(c, session, turnsWork);
  await agentStep(c, session, turnsWork);

  c.close();
  const restarted = await restartStep(daemon, appProc.proc, session);
  await uiPhase(app, restarted, session, pressing && pluginOk && turnsWork);
  if (keepState !== undefined) await keepFacts(session, pluginOk ? pluginId : undefined);
  await bundledMcpStep();
  searchStep();
  record(stepNo("the bot's WebFetch reads a page"), fetchOutcome?.status ?? "BLOCKED", fetchOutcome?.detail ?? "the fetch turns didn't run");
  record(stepNo("a folder-installed plugin's command hook"), hookOutcome?.status ?? "BLOCKED", hookOutcome?.detail ?? "the hook's turn didn't run");
  record(stepNo("a folder-installed plugin's stdio MCP server"), stdioOutcome?.status ?? "BLOCKED", stdioOutcome?.detail ?? "the stdio server's turn didn't run");
  record(stepNo("a plugin's own network"), netOutcome?.status ?? "BLOCKED", netOutcome?.detail ?? "the network turns didn't run");
  await coldStartStep(app, 1);
  await reopenSteps(app);
  await stageLevelsStep(app);
}

// ── the reopen steps ──────────────────────────────────────────────────────────────────────────────────────────────
/** The run's stand-in for the OS starting the daemon at the app's ask (source target): each new line in
 *  launch-requests starts the core if no daemon of the run is alive (an ask while the old one still goes starts
 *  nothing, as launchd's job is still running; the app must ask again). A test-marked app asks nothing (it has no
 *  launcher): on the packaged target the run starts the core itself, once, when no daemon is alive, and says so.
 *  It acts only while a step has armed it (from just before the reopened app opens), so no core starts between the
 *  steps; `settle()` disarms it and waits for a start under way, so a step's check sees the daemon it started (try 10's
 *  run 1 checked before the start it had begun had finished). */
function launchStandIn(): { arm(): void; settle(): Promise<void>; stop(): void; started: string[] } {
  const asksNow = () => (existsSync(launchRequests) ? readLog(launchRequests).split("\n").filter(Boolean).length : 0);
  let armed = false;
  let seen = asksNow();
  let startedThisArm = false;
  let pending: Promise<void> | undefined;
  const started: string[] = [];
  let t0 = Date.now();
  const timer = setInterval(() => {
    if (!armed || pending !== undefined) return;
    const asks = asksNow();
    const daemonAlive = lastDaemon !== undefined && alive(lastDaemon.proc);
    const due = target === "source" ? asks > seen : !daemonAlive && !startedThisArm;
    if (!due) return;
    if (target === "source") {
      const fresh = asks - seen;
      seen = asks;
      if (daemonAlive) { started.push(`+${((Date.now() - t0) / 1000).toFixed(1)} s: ${fresh} ask(s) while the old daemon still runs (nothing started)`); return; }
    }
    startedThisArm = true;
    started.push(`+${((Date.now() - t0) / 1000).toFixed(1)} s: ${target === "source" ? "the app asked; the core started" : "no daemon: the run started the core (a test build's app has no launcher)"}`);
    pending = startDaemonProc().then(() => undefined, (err: unknown) => { started.push(`the core didn't start: ${why(err)}`); }).finally(() => { pending = undefined; });
  }, 200);
  return {
    arm: () => { armed = true; seen = asksNow(); startedThisArm = false; t0 = Date.now(); },
    settle: async () => { armed = false; await pending; },
    stop: () => { armed = false; clearInterval(timer); },
    started,
  };
}

/** Whether this run's daemon takes a short stop bound (CLOVER_TEST_STOP_BUDGET_MS): the source daemon of this tree. */
function daemonTakesStopBudget(): boolean {
  if (target !== "source") return packagedCoreSays("CLOVER_TEST_STOP_BUDGET_MS");
  try { return readFileSync(join(REPO, "scripts", "acceptance", "daemon.ts"), "utf8").includes("CLOVER_TEST_STOP_BUDGET_MS"); } catch { return false; }
}

/** Whether the packaged (test-marked) core carries a test seam, by the name it reads (a real core carries none). */
const coreSays = new Map<string, boolean>();
function packagedCoreSays(name: string): boolean {
  if (target !== "packaged") return false;
  if (!coreSays.has(name)) {
    try { coreSays.set(name, readFileSync(packagedCore()).includes(name)); } catch { coreSays.set(name, false); }
  }
  return coreSays.get(name)!;
}

/** The run's outside world for a packaged core (fake-exa.ts serveOutsideWorld): its test build's seam reaches it by name. */
let outsideWorld: OutsideWorld | undefined;
function startOutsideWorld(): void {
  outsideWorld = serveOutsideWorld();
}

/** Whether this run's daemon holds a stopping daemon on CLOVER_TEST_STOP_HOLD_FILE: the source daemon (this tree's
 *  scripts/acceptance/daemon.ts) or the packaged test-marked core says the name. */
let takesStopHold: boolean | undefined;
function daemonTakesStopHold(): boolean {
  if (takesStopHold === undefined) {
    const file = target === "source" ? join(REPO, "scripts", "acceptance", "daemon.ts") : packagedCore();
    try { takesStopHold = readFileSync(file).includes("CLOVER_TEST_STOP_HOLD_FILE"); } catch { takesStopHold = false; }
  }
  return takesStopHold;
}

/** The reopened app's first dial came back (its log says what came of it after `pair: connecting`): the held daemon
 *  may go from then on. */
async function firstDialOutcome(app: { proc: ChildProcess; log: string }, ms: number): Promise<string> {
  return until("the reopened app's first dial", ms, () => {
    if (!alive(app.proc)) fail(`the app exited (${app.proc.exitCode ?? app.proc.signalCode}): ${lastLines(app.log)}`);
    const lines = readLog(app.log).split("\n");
    const at = lines.findIndex((l) => /pair: connecting/.test(l));
    const outcome = at < 0 ? undefined : lines.slice(at + 1).find((l) => /pair: /.test(l));
    return outcome === undefined ? undefined : outcome.replace(/^\S+Z /, "").slice(0, 160);
  }, 100);
}

/** A DevTools port no one listens on now (the OS's pick): a random one in a fixed range once landed on another run's
 *  Electron on a busy machine, and the run drove that app's window (lane A's "filled on the old daemon"). */
function freePort(): number {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = l.port;
  l.stop(true);
  return port;
}

/** An app as the owner starts it (headless here, with a DevTools port), the launcher stand-in its daemon binary. */
function openApp(app: { exe: string; args: string[] }, label: string): { proc: ChildProcess; log: string; port: number } {
  const port = freePort();
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
    // The window is this app's: it runs, and its own log says it paired (another app on the same port isn't it).
    await until(`the window to fill within ${ms / 1000} s`, ms, async () => {
      if (!alive(app.proc)) fail(`the app exited (${app.proc.exitCode ?? app.proc.signalCode}): ${lastLines(app.log)}`);
      return /pair: connected/.test(readLog(app.log)) ? shellDoc(cdp!) : undefined;
    }, 300).catch(async (e: unknown) => {
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

/** Alpha's stage tool at three levels of this computer. At the default ("ask for risky actions"), in the run's first
 *  daemon: no card, and her stage's mood changes in her plugin's store (`stageStep`). Then, last of all, since this
 *  version raises a level only from the user's own terminal and every later step needs the default: on a daemon and an
 *  app started again on the same home, the level lowered to "ask" (a card, answered yes, and the change) and then to
 *  read-only (refused, the stage left as it was) (`stageLevelsStep`). */
let stageDefault: { ok: true; called: string } | { ok: false; status: Status; detail: string } | undefined;
const stageStoreFile = () => join(home, "settings", "plugin-stores", "alpha.json");
const stageMood = (): string | undefined => { try { return (JSON.parse(readFileSync(stageStoreFile(), "utf8")) as { stage?: { mood?: string } }).stage?.mood; } catch { return undefined; } };
async function stageTurn(c: CloverClient, session: string, want: string) {
  const seen = fake?.requests.length ?? 0;
  const t = await turn(c, session, `ACCEPTANCE-STAGE ${want}: change the mood`, 150_000);
  const mine = (fake?.requests ?? []).slice(seen);
  const called = mine.find((r) => r.toolUse !== undefined)?.toolUse;
  const result = mine.find((r) => r.toolResult !== undefined)?.toolResult;
  if (called === undefined) fail(`Alpha was offered no stage tool (stop ${stopOf(t.events)})`);
  await Bun.sleep(400); // the store's write lands a moment after the tool's answer
  return { called: called!, result, cards: t.cards, mood: stageMood() };
}
async function stageStep(c: CloverClient, session: string | undefined, turnsWork: boolean): Promise<void> {
  if (session === undefined || !turnsWork) { stageDefault = { ok: false, status: "BLOCKED", detail: "no bot turn reaches the fake provider (step 3)" }; return; }
  try {
    const first = await stageTurn(c, session, "joy");
    if (first.cards.length > 0) fail(`at the default level ${first.called} raised ${first.cards.join("; ")} (a display-only tool runs with no card) [packages/core/src/registry/read-only-tools.ts]`);
    if (first.mood !== "joy") fail(`${first.called} ran (${(first.result?.text ?? "no result").slice(0, 120)}) but her stage's mood is ${first.mood ?? "unset"}`);
    stageDefault = { ok: true, called: first.called };
  } catch (err) {
    stageDefault = { ok: false, status: statusOf(err), detail: why(err) };
  }
}
/** A bot's Agent at the default level (the controller's ruling): Alpha hands her study-buddy definition a brief on
 *  `clover-code`, Clover's own sandboxed coding agent, in a folder of the user's home. No card; the start's answer names
 *  the definition; the agent's session row carries the definition and the backend; the child (on the scripted model)
 *  answers, and its report reaches Alpha's conversation as a task notification. */
async function agentStep(c: CloverClient, session: string | undefined, turnsWork: boolean): Promise<void> {
  const n = FULL_STEPS.indexOf(AGENT_STEP) + 1;
  if (session === undefined || !turnsWork) return record(n, "BLOCKED", "no bot turn reaches the fake provider (step 3)");
  try {
    const computer = (await c.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
    if (computer === undefined) fail("computer.list lists no computer");
    mkdirSync(join(userHome, "agent-notes"), { recursive: true });
    writeFileSync(join(userHome, "agent-notes", "chapter.md"), "The Nile floods each summer.\n");
    const root = `home/${computer}/agent-notes`;
    const seen = fake?.requests.length ?? 0;
    const t = await turn(c, session, `ACCEPTANCE-AGENT ${root}`, 150_000);
    const mine = (fake?.requests ?? []).slice(seen);
    const called = mine.find((r) => r.toolUse !== undefined)?.toolUse;
    const started = mine.find((r) => r.toolResult !== undefined)?.toolResult;
    if (called !== "Agent") fail(`Alpha was offered no Agent tool (${mine.map((r) => r.answered).join(", ")}; built-ins: ${(mine.find((r) => r.tools.length > 0)?.tools ?? []).filter((x) => !x.startsWith("mcp__")).join(", ")}) [packages/core/src/daemon.ts botCoreTools agents]`);
    if (t.cards.length > 0) fail(`Agent on clover-code raised ${t.cards.join("; ")} (Clover's own sandboxed agent starts with no card) [packages/core/src/agents/start-policy.ts]`);
    if (started === undefined || started.isError || !started.text.includes("with alpha's agent definition study-buddy")) fail(`Agent didn't start: ${(started?.text ?? "no result").slice(0, 200)}`);
    const agentRow = await until("the agent's session row", 30_000, async () => {
      const r = await c.request<{ sessions: { id: string; kind: string; backend?: string; definition?: string; parent?: string }[] }>("session.list", { kinds: ["agent"] }).catch(() => undefined);
      return r?.sessions.find((x) => x.definition === "alpha:study-buddy");
    }, 500);
    if (agentRow?.backend !== "clover-code") fail(`the agent's row says backend ${agentRow?.backend}, not clover-code`);
    const report = await until("the agent's report in Alpha's conversation", 120_000, async () => {
      const evs = await history(c, session).catch(() => []);
      return evs.find((e) => JSON.stringify(e).includes(CHILD_REPORT));
    }, 1_000).catch(async (err: unknown) => {
      // What the agent did instead: its row, its own log's last events, and whether the scripted model heard it.
      const row = (await c.request<{ sessions: { id: string; status: string; failure?: string }[] }>("session.list", { kinds: ["agent"] }).catch(() => undefined))?.sessions.find((x) => x.id === agentRow!.id);
      const own = await history(c, agentRow!.id).catch(() => []);
      const heard = (fake?.requests ?? []).filter((r) => r.lastUserText.includes("ACCEPTANCE-CHILD")).map((r) => r.answered);
      fail(`${why(err)}; the agent is ${row?.status ?? "gone"}${row?.failure ? ` (${row.failure})` : ""}; its log: ${own.slice(-8).map((e) => `${e.type}${(e as { text?: string }).text ? `:${String((e as { text?: string }).text).slice(0, 80)}` : ""}${(e as { error?: unknown }).error ? `:${JSON.stringify((e as { error?: unknown }).error).slice(0, 160)}` : ""}`).join(", ") || "empty"}; the scripted model heard it ${heard.length} time(s) (${heard.join(", ")})`);
    });
    record(n, "PASS", `Agent on clover-code with alpha:study-buddy: no card; ${started!.text.slice(0, 90)}; its row ${agentRow!.id} (backend ${agentRow!.backend}, definition ${agentRow!.definition}); its report came back (${String((report as { type?: string }).type)})`);
  } catch (err) {
    record(n, statusOf(err), why(err));
  }
}

async function stageLevelsStep(app: { exe: string; args: string[] }): Promise<void> {
  const n = FULL_STEPS.indexOf(STAGE_STEP) + 1;
  if (stageDefault === undefined || !stageDefault.ok) return record(n, stageDefault?.ok === false ? stageDefault.status : "BLOCKED", stageDefault?.ok === false ? stageDefault.detail : "the default-level turn didn't run");
  const called = stageDefault.called;
  if (lastDaemon !== undefined && alive(lastDaemon.proc)) await endChild(lastDaemon.proc, 20_000);
  const port = freePort();
  const env = { ...baseEnv(), CLOVER_DAEMON_BIN: stubBin, ...(target === "source" ? { CLOVER_DEV_DEBUG: "1" } : { CLOVER_TEST_DEBUG: "1" }) };
  const proc = startChild("app", app.exe, [...app.args, "--clover-headless", `--clover-capture=${join(root, "capture.png")}`, "--use-mock-keychain", `--remote-debugging-port=${port}`], env);
  let c: CloverClient | undefined;
  try {
    await startDaemonProc();
    c = (await until("the run's connection to the daemon started again", 60_000, () => appDriver().catch(() => undefined), 500)).client;
    // The bot side starts with the plugin registry, a moment after the daemon answers.
    const session = await until("the bots to be up on the daemon started again", 90_000, async () => {
      const r = await c!.request<{ bots: { id: string; mainSession: string }[] }>("bot.list", {}).catch(() => undefined);
      return r?.bots.find((b) => b.id === "alpha")?.mainSession;
    }, 500);
    if (session === undefined) fail("bot.list lists no alpha");
    await c.request("events.subscribe", { areas: ["sessions", "approvals"] }).catch(() => undefined);
    await c.request("session.attach", { id: session });
    const computer = (await c.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
    if (computer === undefined) fail("computer.list lists no computer");
    const lower = async (level: string): Promise<void> => {
      const r = await c!.request<{ applied: boolean; card?: string }>("computer.setLevel", { name: computer, level });
      if (!r.applied) {
        const card = await until(`the level card for ${level}`, 20_000, async () => [...(await cards(c!).catch(() => [])), ...raised].find((k) => k.id === r.card), 200);
        await approve(c!, card);
      }
      await until(`the level to be ${level}`, 20_000, async () => ((await c!.request<{ computer: { level?: string } }>("computer.get", { name: computer })).computer.level === level ? true : undefined), 200);
      say(`stage step: ${computer} is at ${level}`);
    };
    await lower("ask");
    const asked = await stageTurn(c, session!, "calm");
    if (asked.cards.length === 0) fail(`at "ask" ${asked.called} raised no card`);
    if (asked.mood !== "calm") fail(`at "ask", after the card's yes, her stage's mood is ${asked.mood ?? "unset"}`);
    await lower("read-only");
    const refused = await stageTurn(c, session!, "sad");
    if (refused.mood !== "calm") fail(`at read-only ${refused.called} still changed her stage (mood ${refused.mood})`);
    if (refused.result?.isError !== true && !/refused/.test(refused.result?.text ?? "")) fail(`at read-only ${refused.called} wasn't refused: ${(refused.result?.text ?? "no result").slice(0, 120)}`);
    // Her `readOnly` tool, at read-only: a read, so no card and its answer (lane C's wiring, the router's binding).
    const seen = fake?.requests.length ?? 0;
    const st = await turn(c, session!, "ACCEPTANCE-STAGE-STATUS: read the stage", 150_000);
    const mine = (fake?.requests ?? []).slice(seen);
    const statusCalled = mine.find((r) => r.toolUse !== undefined)?.toolUse;
    const status = mine.find((r) => r.toolResult !== undefined)?.toolResult;
    if (statusCalled === undefined || !statusCalled.endsWith("__stage_status")) fail(`at read-only Alpha was offered no stage_status (stop ${stopOf(st.events)})`);
    if (st.cards.length > 0) fail(`at read-only ${statusCalled} raised ${st.cards.join("; ")} (a declared read-only tool runs as a read) [packages/core/src/approvals/bot-check.ts readOnlyTool]`);
    if (status === undefined || status.isError || !status.text.includes("pinned_notes_shown_to_user") || !status.text.includes('"mood":"calm"')) fail(`at read-only ${statusCalled} didn't answer with her stage: ${(status?.text ?? "no result").slice(0, 160)}`);
    record(n, "PASS", `${called}: no card at the default level (mood joy); at "ask" ${asked.cards.join("; ")} (mood calm); at read-only refused ("${(refused.result?.text ?? "").slice(0, 80)}"), the stage left as it was, and ${statusCalled} answered with no card (mood calm)`);
  } catch (err) {
    record(n, statusOf(err), `the default level passed (${called}, no card, mood joy); then: ${why(err)}`);
  } finally {
    c?.close();
    await endChild(proc.proc);
    if (lastDaemon !== undefined && alive(lastDaemon.proc)) await endChild(lastDaemon.proc, 20_000);
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
      // The held step's daemon, once its pair stopped, holds until this file is there (CLOVER_TEST_STOP_HOLD_FILE, the
      // source daemon's and a test-marked core's): the run writes it once the reopened app has dialled, so the app
      // always finds the old daemon still going, whatever the machine's speed (try 10's run 3 found it gone).
      const holdFile = "held" in step ? join(root, `stop-hold-${i + 1}`) : undefined;
      try {
        // A daemon of this step's own (the held step's slow to go), and the app on it.
        if (lastDaemon !== undefined && alive(lastDaemon.proc)) { stoppingDaemon = true; await endChild(lastDaemon.proc, 20_000); }
        stoppingDaemon = false;
        // A daemon of an earlier build (an upgrade pair's old half) has no such hold: the step can't test what it names.
        if (holdFile !== undefined && !daemonTakesStopHold()) block("this build's daemon has no stop hold (CLOVER_TEST_STOP_HOLD_FILE, an earlier build): the old daemon can't be held until the app has dialled");
        if (holdFile !== undefined) rmSync(holdFile, { force: true });
        // The capped step's daemon: its stop's bound made 1 ms, so the process ends while the stop's tail still runs
        // (the source daemon's seam; a packaged core keeps its own 5 s bound, and the step is blocked there).
        const capped = "capped" in step;
        if (capped && !daemonTakesStopBudget()) block(target === "source" ? "this tree's daemon has no stop bound to cut (CLOVER_TEST_STOP_BUDGET_MS, an earlier build)" : "this packaged core has no test stop bound to cut (CLOVER_TEST_STOP_BUDGET_MS, an earlier build)");
        await startDaemonProc(holdFile !== undefined ? { CLOVER_TEST_STOP_HOLD_FILE: holdFile } : capped ? { CLOVER_TEST_STOP_BUDGET_MS: "1" } : {});
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
          stand.arm();
          appB = openApp(app, `reopen-${i + 1}-b`);
          const took = await windowFills(appB, 60_000);
          await stand.settle();
          if (lastDaemon === old || !alive(lastDaemon!.proc)) fail("the window filled with no new daemon running");
          record(n, "PASS", `a stale core.sock and core.lock, no daemon: the window filled ${(took / 1000).toFixed(1)} s after the app opened; ${stand.started.slice(log0).join("; ")}`);
        } else {
          // A turn that keeps running, then the app quits as the owner's does (the tray's Quit stops both halves).
          const c = (await appDriver()).client;
          const session = (await c.request<{ bots: { mainSession: string }[] }>("bot.list", {})).bots[0]?.mainSession;
          if (session === undefined) block("no bot conversation to run a turn in");
          // Mid text (a held model stream), or mid tool call (the fixture's Echo given `acceptance-hold`, never answered).
          const toolCall = "toolCall" in step;
          const tag = `${toolCall ? "ACCEPTANCE-HOLDTOOL" : "ACCEPTANCE-SLOW"}-${randomBytes(3).toString("hex").toUpperCase()}`;
          const asked = fake!.requests.length;
          const sent = await c.request<{ seq: number }>("session.send", { id: session, message: { text: `${tag} keep going`, clientMessageId: randomUUID() } }, 30_000);
          await until("the turn to be running (the fake asked)", 60_000, () => (fake!.requests.slice(asked).some((r) => r.lastUserText.includes(tag)) ? true : undefined), 200);
          let heldCall: string | undefined;
          if (toolCall) {
            if (fake!.requests.slice(asked).some((r) => r.lastUserText.includes(tag) && r.answered === "text")) block("the bot has no Echo tool (the fixture plugin isn't installed: step 4)");
            // The call running: its card (if any) answered as the app would, its tool_call in the log with no result.
            heldCall = await until("the held Echo call to be running", 60_000, async () => {
              for (const card of await cards(c).catch(() => [])) if (card.session === undefined || card.session === session) await approve(c, card).catch(() => undefined);
              const evs = (await history(c, session!)).filter((e) => typeof e.seq === "number" && e.seq > sent.seq);
              const call = evs.find((e) => e.type === "tool_call" && /Echo$/.test(String(e.name)));
              const id = call === undefined ? undefined : String(call.callId);
              return id !== undefined && !evs.some((e) => e.type === "tool_result" && e.callId === id) ? id : undefined;
            }, 300);
          }
          c.close();
          const quitAt = Date.now();
          const oldLogAt = readLog(old.log).length;
          // The owner's quit (the tray's Quit, which the app's SIGTERM handler runs): the app is given 20 s (a hot
          // machine's Electron is slow to go), and the old daemon must take the quit (its pair stops) before the reopen.
          // An app that had to be killed never quit: the step didn't test what it names. An app that quit while its
          // daemon never took it is the bug the step exists for.
          const quitAlone = await endChild(appA.proc, 20_000);
          const quitTaken = await until("the old daemon to take the app's quit", 30_000, () => (!alive(old.proc) || /\[pair\] stopping the daemon/.test(readLog(old.log).slice(oldLogAt)) ? true : undefined), 200).catch(() => false);
          if (quitTaken !== true) {
            if (!quitAlone) block(`the app didn't quit within 20 s on this machine and was killed, so the old daemon never got its quit: the step didn't test a quit (${lastLines(appA.log, 2)})`);
            fail(`the app quit, but the old daemon never took the quit (no "[pair] stopping the daemon" in 30 s, and it still runs): ${lastLines(old.log, 2)}`);
          }
          await sleep(step.delayMs);
          const oldAlive = alive(old.proc);
          // Held, the old daemon can't have gone: one that did ignored the hold (a seam missing from this core).
          if (holdFile !== undefined && !oldAlive) fail(`the held daemon went before the app reopened: it didn't take CLOVER_TEST_STOP_HOLD_FILE (${lastLines(old.log)})`);
          stand.arm();
          appB = openApp(app, `reopen-${i + 1}-b`);
          let held = "";
          if (holdFile !== undefined) {
            const heldFrom = Date.now();
            const dialled = await firstDialOutcome(appB, 30_000).finally(() => writeFileSync(holdFile, "go\n"));
            if (!alive(old.proc)) fail(`the held daemon went before the app's first dial came back ("${dialled}")`);
            held = `; the old daemon held ${((Date.now() - heldFrom) / 1000).toFixed(1)} s, until the app's first dial came back ("${dialled}")`;
          }
          const took = await windowFills(appB, 60_000);
          await stand.settle();
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
          let cappedNote = "";
          if (heldCall !== undefined) {
            // What the owner sees of a call cut off by the quit, everything observed before any verdict.
            const seen: string[] = [];
            const wrong: string[] = [];
            const result = after.find((e) => e.type === "tool_result" && e.callId === heldCall);
            if (result === undefined) wrong.push("the call has no result in the conversation (a tool_use left open)");
            else seen.push(`its result: ${result.interrupted === true ? "interrupted" : result.isError === true ? "an error" : "a success"} ("${String(result.output ?? "").slice(0, 60)}")`);
            const win = await Cdp.connect(appB!.port);
            let view = "";
            let statuses: string[] = [];
            try {
              view = await until("the quit turn drawn in the window", 30_000, async () => { const t = await treeText(win).catch(() => ""); return t.includes(tag) ? t : undefined; }, 500);
              await sleep(1_500);
              view = await treeText(win).catch(() => view);
              // The tool rows' status (a glyph with `data-status`, its label for a screen reader), in the order drawn.
              const read = "JSON.stringify([...document.querySelectorAll('.cl-conv-status')].map((e) => e.getAttribute('data-status')))";
              statuses = (await Promise.all((await treeDocs(win)).map((d) => win.evaluate(d.session, read).then((v) => JSON.parse(String(v)) as string[], () => [])))).flat();
            } finally {
              win.close();
            }
            const row = statuses.at(-1);
            seen.push(`the tool row's status is ${row ?? "not drawn"}`);
            if (row !== "interrupted") wrong.push(`the tool row's status is ${row ?? "not drawn"}, not interrupted`);
            if (/is thinking|is working/.test(view)) wrong.push(`the window still says the bot is busy ("${/[^.\n]*is (thinking|working)/.exec(view)?.[0] ?? ""}")`);
            const after3 = (await appDriver()).client;
            const ok = `ACCEPTANCE-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
            const before = (await history(after3, session!)).length;
            const { events: next } = await turn(after3, session!, `${ok} are you back?`);
            const later = (await history(after3, session!)).slice(before);
            after3.close();
            if (!JSON.stringify(next).includes(`ACCEPTANCE-REPLY-OK ${ok}`)) wrong.push(`the next message got no reply of its own (stop ${stopOf(next)}${errorsOf(next).length ? `: ${errorsOf(next)[0]}` : ""})`);
            else seen.push("the next message got its own reply");
            const again = later.filter((e) => e.type === "tool_call" && /Echo$/.test(String(e.name)));
            if (again.length > 0) wrong.push(`the next turn ran the call again (${again.length} Echo call(s))`);
            else seen.push("the call wasn't run again");
            if (wrong.length > 0) fail(`after quitting mid tool call: ${wrong.join("; ")} (seen: ${seen.join("; ")})`);
            cappedNote = `; mid tool call: ${seen.join("; ")}`;
          }
          if (capped) {
            // The stop was cut off (its log says so, and what it still waited on), and what the owner sees after it.
            const cut = firstLine(old.log, /\[stop\] not done after/);
            if (cut === undefined) fail(`the old daemon's stop wasn't cut off at its bound (no "[stop] not done after" in its log): the step didn't test what it names (${lastLines(old.log)})`);
            const reason = String(end.stopReason ?? "");
            if (end.type !== "turn_completed" || !/aborted|interrupted|stopped/.test(reason)) fail(`after the cut-off stop the turn ends as ${String(end.type)} (${reason || "no stop reason"}), not stopped`);
            const after2 = (await appDriver()).client;
            const win = await Cdp.connect(appB!.port);
            let view = "";
            try {
              // The quit turn's message drawn, then a moment for its turn state to settle.
              view = await until("the quit turn drawn in the window", 30_000, async () => { const t = await treeText(win).catch(() => ""); return t.includes(tag) ? t : undefined; }, 500);
              await sleep(1_500);
              view = await treeText(win).catch(() => view);
            } finally {
              win.close();
            }
            if (/is thinking|is working/.test(view)) fail(`after the cut-off stop the window still says the bot is busy ("${/[^.\n]*is (thinking|working)/.exec(view)?.[0] ?? ""}")`);
            const bots = await after2.request<{ bots: { mainSession: string; status?: string; state?: string }[] }>("bot.list", {});
            const row = bots.bots.find((b) => b.mainSession === session);
            if (row?.state === "thinking") fail(`after the cut-off stop bot.list still says thinking (status ${row.status ?? "?"})`);
            const ok = `ACCEPTANCE-TAG-${randomBytes(4).toString("hex").toUpperCase()}`;
            const { events: next } = await turn(after2, session!, `${ok} are you back?`);
            after2.close();
            if (!JSON.stringify(next).includes(`ACCEPTANCE-REPLY-OK ${ok}`)) fail(`after the cut-off stop the next message got no reply of its own (stop ${stopOf(next)}${errorsOf(next).length ? `: ${errorsOf(next)[0]}` : ""})`);
            cappedNote = `; the stop was cut off (${cut!.replace(/^.*\[stop\] /, "").slice(0, 160)}); bot.list says ${row?.state ?? "?"}, the window shows no busy bot, and the next message got its own reply`;
          }
          record(n, "PASS", `quit mid-turn, reopened ${step.delayMs / 1000} s later (the old daemon ${oldAlive ? "still going" : "gone"} then): the window filled ${(took / 1000).toFixed(1)} s after the app opened (${((Date.now() - quitAt) / 1000).toFixed(1)} s after the quit)${held}; the turn ends as ${String(end.type)}${end.stopReason !== undefined ? ` (${String(end.stopReason)})` : ""}${cappedNote}; ${stand.started.slice(log0).join("; ") || "no launch asked"}`);
        }
      } catch (err) {
        record(n, statusOf(err), `${why(err)}${stand.started.length > log0 ? ` [launch stand-in: ${stand.started.slice(log0).join("; ")}]` : ""}`);
      } finally {
        await stand.settle();
        if (holdFile !== undefined) writeFileSync(holdFile, "go\n");
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
      const port = freePort();
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
  const port = freePort();
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
    const torn = mine.filter((r) => r.answered === "torn");
    if (!turnsWork && mine.some((r) => r.answered === "slow")) fail(`the fake held this turn as a slow one (its user text carried an ACCEPTANCE-SLOW directive after the tag): stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""}`);
    if (!turnsWork && torn.length > 0) fail(`the turn's request reached the fake but its body never arrived whole (${torn.map((r) => r.torn).join("; ")}); the turn ended: stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""}`);
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
  let echoTurn: { events: Ev[]; cards: string[] } | undefined;
  let echoWhy: string | undefined;
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
    echoTurn = { events, cards: carded };
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
    echoWhy = why(err);
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

  // 9: the "Always allow" the old build gave the Echo call's card, against step 5's same call on this build. A card
  // again is what a user sees when a rule no longer matches (lane C made rule keys per bot): acceptable, and said. An
  // error isn't.
  try {
    if (k.always === undefined) block(k.alwaysMissing !== undefined ? `the old run saved no Always rule: ${k.alwaysMissing}` : "the old run saved no Always rule (its plugin tool step didn't run)");
    if (echoTurn === undefined) block(`step 5's call didn't run on this build${echoWhy !== undefined ? ` (${echoWhy.slice(0, 200)})` : ""}`);
    const errors = errorsOf(echoTurn!.events);
    if (errors.length > 0) fail(`the same call (${k.always!.tool}) erred on this build: ${errors[0]}`);
    const toolCards = echoTurn!.cards.filter((x) => !/plugin-ok/.test(x));
    if (toolCards.length === 0) record(9, "PASS", `the Always rule saved on the old build answered ${k.always!.tool}: no card`);
    else record(9, "PASS", `the old Always rule no longer matches ${k.always!.tool} on this build: the user sees a card again (${toolCards.join("; ")}), which is acceptable; no error`);
  } catch (err) {
    record(9, statusOf(err), why(err));
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
  const port = freePort();
  // The Plugins page step's folder: main's picker, in a test-marked or acceptance build, answers with it (CLOVER_TEST_PICK).
  const pickFolder = { path: join(import.meta.dir, "fixtures", "acceptance-page"), id: "acceptance-page", name: "Acceptance page plugin", tool: "PageProbe" };
  // The picker reads its folder from this file at each pick (a `.pick` file), so the examples' steps pick theirs after.
  const pickFile = join(root, "folder.pick");
  writeFileSync(pickFile, `${pickFolder.path}\n`);
  // The renders' dark and light: the app follows this file (CLOVER_TEST_APPEARANCE_FILE, test-marked builds only).
  const appearanceFile = join(root, "appearance");
  const env = { ...baseEnv(), CLOVER_DAEMON_BIN: stubBin, CLOVER_TEST_SEALED_PRESS: "1", CLOVER_TEST_PICK: pickFile, CLOVER_TEST_APPEARANCE_FILE: appearanceFile, ...(target === "source" ? { CLOVER_DEV_DEBUG: "1" } : { CLOVER_TEST_DEBUG: "1" }) };
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
      cardTurn: pressable && session !== undefined ? (inspect) => turn(rpc, session, "ACCEPTANCE-EDIT: edit the story", 150_000, { press: { cdp: cdp!, log: proc.log }, inspect }).then(() => undefined) : undefined,
      onSetting: (key, value) => { if (key === "notifications.needsYou" && typeof value === "boolean") keptFacts.needsYou = value; },
      pickFolder,
      setAppearance: (scheme: "dark" | "light" | "system") => writeFileSync(appearanceFile, scheme),
      ...(pressable ? {
        pressCard: async (what: string, match: (c: Card) => boolean) => {
          const card = await until(what, 30_000, async () => (await cards(rpc)).find(match), 500);
          await pressApprove(cdp!, card, proc.log);
          return card.id;
        },
      } : {}),
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
    // The SDK's two full examples, third-party plugins installed from their folders on the Plugins page (example-steps.ts).
    const exampleCtx: ExampleCtx = {
      cdp: cdp!, rpc, home, root, userHome, childReport: CHILD_REPORT,
      appLog: () => readLog(join(home, "logs", "app.log")),
      requests: () => fake?.requests ?? [],
      pick: (folder) => writeFileSync(pickFile, `${folder}\n`),
      pressCard: async (what, match) => {
        const card = await until(what, 30_000, async () => (await cards(rpc)).find(match), 500);
        await pressApprove(cdp!, card, proc.log);
        return card.id;
      },
      turn: (s, text, ms) => turn(rpc, s, text, ms),
      history: (s) => history(rpc, s),
    };
    for (const [name, run] of [
      [EXAMPLE_NOTES_STEP, () => exampleNotesStep(exampleCtx, session!)],
      [EXAMPLE_WEATHER_STEP, () => exampleWeatherStep(exampleCtx, session!)],
    ] as const) {
      const n = FULL_STEPS.indexOf(name) + 1;
      try {
        if (!pressable || session === undefined) block("no plugin tool turn runs (steps 3-5), so no card to press");
        record(n, "PASS", await run());
      } catch (err) {
        record(n, statusOf(err), why(err));
      }
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
// The old half leaves state behind; what it can't do of the new build's is not a failure of the upgrade.
if (oldHalf) for (const r of rows) if (r.status === "FAIL" && NOT_ASSERTED_ON_OLD.some((p) => r.name.startsWith(p))) { r.status = "BLOCKED"; r.detail = `not asserted on the old build (a feature of a newer build): ${r.detail}`.slice(0, 600); }
const w = Math.max(...rows.map((r) => r.name.length));
console.log(`\nClover acceptance (${target}${appBundle ? `: ${appBundle}` : ""})\n`);
console.log(`| # | step${" ".repeat(w - 4)} | result  | first failing call / detail`);
console.log(`|---|${"-".repeat(w + 2)}|---------|----------------------------`);
for (const r of rows) console.log(`| ${r.n} | ${r.name.padEnd(w)} | ${r.status.padEnd(7)} | ${r.detail}`);
const bad = rows.filter((r) => r.status !== "PASS").length;
console.log(`\n${rows.length - bad}/${rows.length} passed`);
process.exit(code !== 0 ? code : bad > 0 ? 1 : 0);
