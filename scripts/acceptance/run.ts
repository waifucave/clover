#!/usr/bin/env bun
// The macOS acceptance run: "usable" means this passes. One command, two targets:
//
//   scripts/pinned-bun scripts/acceptance/run.ts                      this checkout: the daemon from source, the
//                                                                     desktop app built here, headless
//   scripts/pinned-bun scripts/acceptance/run.ts --app <Clover.app>   a packaged app (a try build): its own daemon
//                                                                     and its own app, headless
//   --keep-logs <dir>   copy the run's logs there before the temp folder goes (the logs hold no key)
//   --verbose           print each step's progress
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
//   8-12. the window itself, over the DevTools protocol, on the restarted daemon (ui-steps.ts): drag the title area,
//      type in the composer and send and read the reply, pick a model, open Settings, change a setting and reopen it.
//      The source app takes the DevTools port behind CLOVER_DEV_DEBUG=1; a packaged one only if it is test-marked
//      (CLOVER_TEST_DEBUG=1, loopback), and any other build refuses it (debug-guard.ts), so those steps are BLOCKED.
//   13. each boot lists the bundled web tools; 14. the bot's WebSearch reaches the fake search backend; 15. the bot's
//      WebFetch reads a fake public page and is refused a private address; 16. the cold start
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
import { shellDoc, dumpFrames, UI_STEPS, uiSteps } from "./ui-steps";
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

// ── the result table ─────────────────────────────────────────────────────────────────────────────────────────────
type Status = "PASS" | "FAIL" | "BLOCKED";
interface Row { n: number; name: string; status: Status; detail: string }
const STEPS = [
  "first start: the app pairs and finishes setup",
  "a model key added through the app's methods",
  "a bot turn gets the fake provider's reply",
  "a plugin installs from a folder, its OK card approved",
  "the bot calls the plugin's MCP tool",
  "a fenced write raises an approval card, then lands",
  "the daemon restarts on the same home and boots",
  ...UI_STEPS.map((s) => `window: ${s}`),
  "each boot lists the bundled web tools within 5 s and offers them; an installed plugin's server lists too",
  "the bot's WebSearch reaches the fake search backend; nothing leaves the machine",
  "the bot's WebFetch reads a public page (network:public) and is refused a private address",
  "cold start: the app opens first, the daemon after, and the shell fills the window",
] as const;
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
const home = join(root, "home");
const userHome = join(root, "user");
const logs = join(root, "logs");
const keychain = join(root, "kc", "acceptance.keychain-db");
const stubBin = join(root, "bin", "clover-core-stub");
for (const d of [home, userHome, logs, dirname(keychain), dirname(stubBin)]) mkdirSync(d, { recursive: true, mode: 0o700 });
const service = `com.waifucave.clover.core.test.acceptance-${randomBytes(4).toString("hex")}`;
const dummyKey = `sk-ant-acceptance-dummy-${randomBytes(12).toString("hex")}`;
const writePath = join(userHome, "acceptance", "written.txt");
const writeContent = `acceptance-write-${randomBytes(4).toString("hex")}\n`;

// A daemon binary the app finds instead of a real one (`CLOVER_DAEMON_BIN`, honoured by a dev or unpackaged app): any
// login-item or start the app tries fails here, so it never registers anything with launchd.
writeFileSync(stubBin, "#!/bin/sh\necho 'acceptance: the app tried to start a daemon through the OS' >&2\nexit 1\n", { mode: 0o700 });

const children: { name: string; proc: ChildProcess }[] = [];
let fake: FakeProvider | undefined;
const clients: CloverClient[] = [];
let keychainsBefore = "";
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
  if (keychainMade) spawnSync("security", ["delete-keychain", keychain], { stdio: "ignore" });
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
  writeFileSync(join(home, "settings.json"), `${JSON.stringify({ schemaVersion: 1, providers: { anthropic: { baseUrl: fakeUrl } } }, null, 2)}\n`, { mode: 0o600 });
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
    const r = spawnSync(existsSync(heavy) ? heavy : process.execPath, existsSync(heavy) ? [process.execPath, "run", "build"] : ["run", "build"], { cwd: DESKTOP, encoding: "utf8", timeout: 900_000 });
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
  watchBundledListing(daemonRun, started.log);
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
const bundledBoots: { run: number; log: string; listed?: string; ms?: number; echoMs?: number; waited?: Promise<void> }[] = [];
/** Requests the fake had when each daemon started: the turns after it are that boot's. */
const requestsAtBoot: number[] = [];
function watchBundledListing(run: number, log: string): void {
  const t0 = Date.now();
  requestsAtBoot[run] = fake?.requests.length ?? 0;
  const boot: (typeof bundledBoots)[number] = { run, log };
  boot.waited = (async () => {
    for (;;) {
      const text = readLog(log);
      const m = text.match(BUNDLED_LISTED);
      if (m && boot.listed === undefined) {
        boot.listed = m[1]!.trim();
        boot.ms = Date.now() - t0;
      }
      if (boot.echoMs === undefined && ECHO_LISTED.test(text)) boot.echoMs = Date.now() - t0;
      if ((boot.listed !== undefined && (run === 1 || boot.echoMs !== undefined)) || Date.now() - t0 >= BUNDLED_MCP_WAIT_MS) return;
      await sleep(200);
    }
  })();
  bundledBoots.push(boot);
}

/** The web plugin's tools as a session names them: every bundled plugin's read mcp__clover__… (spec §5.3). */
const WEB_SEARCH_TOOL = "mcp__clover__WebSearch";
const WEB_FETCH_TOOL = "mcp__clover__WebFetch";
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
async function bundledMcpStep(): Promise<void> {
  const n = TOTAL - 3; // the bundled-tools step: three before the cold start
  try {
    await Promise.all(bundledBoots.map((b) => b.waited));
    if (bundledBoots.length === 0) fail("no daemon started");
    for (const b of bundledBoots) {
      const failed = readLog(b.log).match(BUNDLED_FAILED)?.[0];
      if (failed !== undefined) fail(`daemon ${b.run}: ${failed.slice(0, 400)}`);
      const settled = b.listed ?? fail(`daemon ${b.run}: clover/web/web neither listed its tools nor said why it isn't served within ${BUNDLED_MCP_WAIT_MS / 1000} s of the socket answering [packages/core/src/runtime-sdk/turn-loop/plugin-mcp.ts]`);
      const listed = settled.startsWith("listed ");
      // net.fetch crosses the plugin host (packages/core/src/contracts/plugin-host.ts NET_FETCH_CROSSES_PLUGIN_HOST):
      // the web server is offered, never "not served".
      if (!listed) fail(`daemon ${b.run}: clover/web/web ${settled.slice(0, 300)} (net.fetch crosses the plugin host now: it must be listed and offered)`);
      if (!/\bWebSearch\b/.test(settled) || !/\bWebFetch\b/.test(settled)) fail(`daemon ${b.run}: clover/web/web ${settled}, not WebSearch and WebFetch`);
      // A boot after the plugin's install (daemon 1 listed it once installed): its server lists within the time too.
      const installed = ECHO_LISTED.test(readLog(bundledBoots[0]!.log));
      if (b.run > 1 && installed && b.echoMs === undefined) fail(`daemon ${b.run}: acceptance-echo/echo, installed before this boot, didn't list its tools within ${BUNDLED_MCP_WAIT_MS / 1000} s of the socket answering`);
      const first = (fake?.requests ?? []).slice(requestsAtBoot[b.run] ?? 0).find((r) => r.path.endsWith("/messages") && r.keyMatched);
      if (first === undefined) continue; // no turn on this boot
      // Every bundled plugin's tools read mcp__clover__… (spec §5.3).
      const web = first.tools.filter((t) => /(^|__)Web(Search|Fetch)$/.test(t));
      const named = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL].every((t) => first.tools.includes(t));
      if (listed && !named) fail(`daemon ${b.run}: the web tools were listed, but its first turn's request didn't offer ${WEB_SEARCH_TOOL} and ${WEB_FETCH_TOOL} (web tools: ${web.join(", ") || "none"}; tools: ${first.tools.join(", ").slice(0, 300)})`);
      if (!listed && web.length > 0) fail(`daemon ${b.run}: the web server isn't served, yet its first turn offered ${web.join(", ")}`);
    }
    record(n, "PASS", bundledBoots.map((b) => `daemon ${b.run}: clover/web/web ${b.listed!.slice(0, 120)} (${((b.ms ?? 0) / 1000).toFixed(1)} s)${b.echoMs === undefined ? "" : `, acceptance-echo/echo listed (${(b.echoMs / 1000).toFixed(1)} s)`}`).join("; "));
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

interface Turn { events: Ev[]; cards: string[] }
/** Sends the user's message and waits for its turn to end; gives back the events after it, and the cards the turn
 *  raised, each answered yes as the app would (a card nobody answers holds the turn until it is withdrawn). */
async function turn(c: CloverClient, session: string, text: string, timeoutMs = 120_000): Promise<Turn> {
  const known = new Set([...(await cards(c).catch(() => [])), ...raised].map((k) => k.id));
  const sent = await c.request<{ seq: number }>("session.send", { id: session, message: { text, clientMessageId: randomUUID() } }, 30_000);
  const asked = fake?.requests.length ?? 0;
  const seenCards: string[] = [];
  let last: Ev[] = [];
  try {
    const events = await until(`the turn after "${text.slice(0, 40)}" to end`, timeoutMs, async () => {
      const after = (await history(c, session)).filter((e) => typeof e.seq === "number" && e.seq > sent.seq);
      last = after;
      const listed = await cards(c).catch(() => undefined);
      for (const card of [...(listed ?? []), ...raised]) {
        if (known.has(card.id) || (card.session !== undefined && card.session !== session)) continue;
        known.add(card.id);
        try {
          await approve(c, card);
          seenCards.push(`a ${card.kind} card, approved`);
        } catch (err) {
          seenCards.push(`a ${card.kind} card that the run couldn't answer (${why(err)})`);
          // A card the app was never told of fails the step at once (`appGotCard`), as a blocked one does.
          if (err instanceof StepBlocked || err instanceof StepFail) throw err;
        }
      }
      return after.some((e) => e.type === "turn_completed") ? after : undefined;
    }, 500);
    refusedSince(asked);
    return { events, cards: seenCards };
  } catch (err) {
    if (err instanceof StepBlocked) throw err;
    refusedSince(asked);
    // What the session showed, the cards it raised, and whether the provider was asked at all.
    const types = [...new Set(last.map((e) => String(e.type)))].join(", ") || "no event after the message";
    fail(`${why(err)} (events: ${types}; ${seenCards.length ? `${seenCards.join("; ")}; ` : ""}${(fake?.requests.length ?? 0) - asked} request(s) reached the fake)`);
  }
  return { events: [], cards: [] };
}
const errorsOf = (events: Ev[]): string[] => events.filter((e) => e.type === "agent_error" || e.type === "error").map((e) => String(e.message ?? e.error ?? JSON.stringify(e)).slice(0, 300));
const stopOf = (events: Ev[]): string => String(events.find((e) => e.type === "turn_completed")?.stopReason ?? "?");

// ── the cards ────────────────────────────────────────────────────────────────────────────────────────────────────
type Card = { id: string; hash: string; kind: string; session?: string; pluginId?: string; options: { id: string; kind: string }[]; children?: { id: string; checked: boolean }[]; fields?: Record<string, unknown> };
/** The app itself was told of the card (its `card_requested`, which it logs with the card's id): a card the run reads
 *  over RPC but the app never heard of is a card the user would never see (the first packaged run's daemon sent none:
 *  its events didn't parse). Waits a moment for the app's log. */
async function appGotCard(card: Card): Promise<void> {
  const line = `card: a ${card.kind} card ${card.id} arrived`;
  const log = join(logs, "app.log");
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

  // Step 1: the daemon, then the app headless; the app pairs and finishes its setup.
  let daemon: { proc: ChildProcess; log: string };
  try {
    daemon = await startDaemonProc();
  } catch (err) {
    for (let n = 1; n <= TOTAL; n++) record(n, "BLOCKED", n === 1 ? `the daemon didn't start: ${why(err)}` : "no daemon");
    return;
  }
  const smokeOut = join(root, "smoke.json");
  const appEnv = { ...baseEnv(), CLOVER_DAEMON_BIN: stubBin, CLOVER_SMOKE_KEEP: "1", CLOVER_SMOKE_OUT: smokeOut, CLOVER_SMOKE_DEADLINE_MS: "45000" };
  const appProc = startChild("app", app.exe, [...app.args, "--clover-headless", "--clover-smoke", "--use-mock-keychain"], appEnv);
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
    record(1, "PASS", "the app paired (protocol.hello, onConnected's setup) and drew the shell, headless");
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
    await uiPhase(app, up);
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

  // Step 3: a turn on the bundled bot's main conversation, answered by the fake.
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
    const { events, cards: carded } = await turn(c, session, "ACCEPTANCE-REPLY: say hello");
    const mine = fake.requests.slice(seen).filter((r) => r.path.endsWith("/messages"));
    const replied = JSON.stringify(events).includes("ACCEPTANCE-REPLY-OK");
    turnsWork = replied;
    if (replied) record(3, "PASS", `the reply came from the fake (${mine.length} request(s), key matched: ${mine.some((r) => r.keyMatched)}${carded.length ? `; ${carded.join("; ")}` : ""})`);
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
        const { events, cards: carded } = await turn(c, session, "ACCEPTANCE-REPLY: say hello again");
        turnsWork = JSON.stringify(events).includes("ACCEPTANCE-REPLY-OK");
        const row = rows.find((r) => r.n === 3)!;
        row.detail = `${row.detail} — a second turn, once the bot runs ${model}: ${turnsWork ? `the fake's reply came${carded.length ? ` (${carded.join("; ")})` : ""}` : `no reply either (stop ${stopOf(events)}${errorsOf(events).length ? `: ${errorsOf(events)[0]}` : ""})`}`.slice(0, 700);
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
    const folder = join(root, "plugin-src", "acceptance-echo");
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
    await approve(c, card);
    const state = await until("the plugin to be enabled after its OK", 60_000, async () => {
      const r = await c.request<{ plugin?: { state?: string } }>("plugin.get", { id: installed.id }).catch(() => undefined);
      const s = r?.plugin?.state;
      return s !== undefined && s !== "found" && s !== "installing" ? s : undefined;
    });
    if (state !== "enabled" && state !== "running") fail(`after its OK the plugin is ${state}`);
    pluginOk = true;
    record(4, "PASS", `plugin.install (folder) → ${installed.state}; the ${card.kind} card listed, read and approved; now ${state}`);
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
      if (called !== WEB_SEARCH_TOOL) fail(`the bot's WebSearch is ${called}, not ${WEB_SEARCH_TOOL} (spec §5.3)`);
      if (result!.isError || !result!.text.includes(FAKE_SEARCH_HIT)) fail(`${called} answered without the fake backend's result: ${result!.text.slice(0, 300)}`);
      searchOutcome = { status: "PASS", detail: `the bot called ${called} and got the fake search backend's result${carded.length ? ` (${carded.join("; ")})` : ""}` };
    } catch (err) {
      searchOutcome = { status: statusOf(err), detail: why(err) };
    }
  }

  // Step 15 (its turns here; recorded at the end): the bot's WebFetch (network:public) reads the fake public site's
  // article through the same seam, and a name that resolves to a private address is refused before any request.
  if (session === undefined || !turnsWork) fetchOutcome = { status: "BLOCKED", detail: "no bot turn reaches the fake provider (step 3)" };
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
      if (page.called !== WEB_FETCH_TOOL) fail(`the bot's WebFetch is ${page.called}, not ${WEB_FETCH_TOOL} (spec §5.3)`);
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
      const { events, cards: carded } = await turn(c, session, "ACCEPTANCE-WRITE: write the file", 150_000);
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
  await uiPhase(app, restarted);
  await bundledMcpStep();
  searchStep();
  record(TOTAL - 1, fetchOutcome?.status ?? "BLOCKED", fetchOutcome?.detail ?? "the fetch turns didn't run");
  await coldStartStep(app, 1);
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

/** Steps 8 on: the window, driven over the DevTools protocol (ui-steps.ts), on the daemon step 7 restarted. */
async function uiPhase(app: { exe: string; args: string[] }, daemonUp: boolean): Promise<void> {
  const first = 8;
  const blockAll = (why: string) => { for (let i = 0; i < UI_STEPS.length; i++) record(first + i, "BLOCKED", why); };
  if (!daemonUp) return blockAll("the daemon didn't come back (step 7)");
  const port = 9300 + Math.floor(Math.random() * 500);
  const env = { ...baseEnv(), CLOVER_DAEMON_BIN: stubBin, ...(target === "source" ? { CLOVER_DEV_DEBUG: "1" } : { CLOVER_TEST_DEBUG: "1" }) };
  const proc = startChild("ui-app", app.exe, [...app.args, "--clover-headless", `--clover-capture=${join(root, "capture.png")}`, "--use-mock-keychain", `--remote-debugging-port=${port}`], env);
  let cdp: Cdp | undefined;
  try {
    await until("the window's DevTools port", 120_000, async () => {
      if (!alive(proc.proc)) fail(`the app exited (${proc.proc.exitCode ?? proc.proc.signalCode}): ${firstLine(proc.log, /refusing|refused|failed|error/i) ?? lastLines(proc.log)}`);
      try { cdp = await Cdp.connect(port); return true; } catch { return undefined; }
    }, 500);
    const rpc = (await appDriver()).client;
    await uiSteps({ cdp: cdp!, rpc, reply: "ACCEPTANCE-REPLY-OK", appLog: () => readLog(join(home, "logs", "app.log")) }, (i, status, detail) => record(first + i, status, detail));
  } catch (err) {
    for (let i = 0; i < UI_STEPS.length; i++) if (!rows.some((r) => r.n === first + i)) record(first + i, "BLOCKED", `the window couldn't be driven: ${why(err)}`);
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
try {
  await main();
} catch (err) {
  console.error(`acceptance: the run itself failed: ${why(err)}`);
  code = 2;
} finally {
  // A run is headless: no window may reach the owner's screen. The app logs "window: shown while headless" whenever one would.
  for (const f of ["app.log.1", "app.log"]) {
    const shown = readLog(join(home, "logs", f)).split("\n").find((l) => /window: shown while headless/.test(l));
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
