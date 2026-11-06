// The app for real, in Electron, against the fake daemon: the default shell from lane F's plugins drawn in layers, a
// third-party part in a layer of its own, the packaged app, and the pair (the app starts the daemon, starts it again
// after a crash, and Quit stops both).
//
// CI runs it (CI=true and CLOVER_UI_TESTS=1, the app job in .github/workflows/ci.yml; Linux under xvfb). Locally it
// runs only when CLOVER_UI_LOCAL_ELECTRON names an Electron that can never come to the front (a copy with
// LSBackgroundOnly on macOS); every run is headless: no window shown, no Dock or tray icon, no focus (plan §8).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCalls } from "./fake-core/fake-daemon";
import { IPV6_REACHABILITY_PROBE, offMachine, readNetLog } from "./netlog";
import { FIXTURES, REPO, alphaView, cloverViews, folderView } from "./fake-core/registry";

const root = join(import.meta.dir, "..");
const ci = process.env.CI === "true" && process.env.CLOVER_UI_TESTS === "1";
const localElectron = process.env.CLOVER_UI_LOCAL_ELECTRON;
const enabled = ci || (localElectron !== undefined && localElectron !== "");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const exe = process.platform === "win32" ? ".exe" : "";

interface Frame { origin: string; node: boolean; bridge: string; shell: boolean; sidebar: boolean; conversation: boolean; composer: boolean; frames: number; accent: string; insetTop: string; sheets: number; themed: string; text: string; url: string; osPid: number; sandboxed: boolean | null }
interface Smoke { ok: boolean; frames: Frame[]; [key: string]: unknown }

let work: string;
let fakeCore: string;
const registries: Record<string, string> = {};
const homes: string[] = [];

function electron(): string {
  return localElectron !== undefined && localElectron !== "" ? localElectron : (createRequire(join(root, "package.json"))("electron") as string);
}

/** A local run's Electron must never come to the front: on macOS a copy whose Info.plist sets `LSBackgroundOnly`
 *  (`bun run scripts/background-electron.ts` makes one). The test refuses any other. */
function refuseForegroundElectron(): void {
  if (ci || process.platform !== "darwin") return;
  const plist = join(dirname(dirname(localElectron!)), "Info.plist");
  const value = spawnSync("plutil", ["-extract", "LSBackgroundOnly", "raw", plist], { encoding: "utf8" });
  if (value.status !== 0 || value.stdout.trim() !== "true") {
    throw new Error(`CLOVER_UI_LOCAL_ELECTRON (${localElectron}) is not a background-only Electron; make one with \`bun run scripts/background-electron.ts <dir>\``);
  }
}

function home(): string {
  // Short, for the Unix socket's path limit.
  const h = mkdtempSync(join(tmpdir(), "ce1-"));
  homes.push(h);
  return h;
}

function env(h: string, registry: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, CLOVER_HOME: h, CLOVER_DAEMON_BIN: fakeCore, CLOVER_FAKE_UI: registries[registry], ELECTRON_ENABLE_LOGGING: "1", ...extra };
  delete e.CLOVER_PROFILE;
  delete e.ELECTRON_RUN_AS_NODE;
  delete e.CLOVER_APP_TOKEN;
  return e;
}

function smoke(executable: string, args: string[], registry: string, extra: Record<string, string> = {}): { status: number | null; facts: Smoke | undefined; output: string; all: string; home: string; netlog: string } {
  const h = home();
  const out = join(h, "smoke.json");
  // Every run records a net log: what it sent off the machine is asserted (none of it beyond loopback).
  const netlog = join(h, "net.json");
  const r = spawnSync(executable, [...args, "--clover-smoke", `--log-net-log=${netlog}`], { env: env(h, registry, { CLOVER_SMOKE_OUT: out, ...extra }), encoding: "utf8", timeout: 100_000 });
  const facts = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Smoke) : undefined;
  const all = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
  return { status: r.status, facts, output: all.slice(-6000), all, home: h, netlog };
}

/** Nothing left the machine: no lookup, socket or request beyond loopback (and `allowed`, the probe's control). */
function expectQuiet(r: ReturnType<typeof smoke>, allowed: Parameters<typeof offMachine>[1] = {}): ReturnType<typeof readNetLog> {
  expect(existsSync(r.netlog), r.output).toBe(true);
  const activity = readNetLog(r.netlog);
  expect(activity.events, "the net log recorded nothing").toBeGreaterThan(0);
  expect(offMachine(activity, allowed)).toEqual({ lookups: [], sockets: [], requests: [] });
  // Loopback is allowed above, so the spellchecker's own word is checked too: no dictionary download began (asserted
  // on the whole run's output: a fast run's tail can cut an early line off).
  expect(r.all).not.toContain("began a dictionary download");
  return activity;
}

function expectShell(r: ReturnType<typeof smoke>, opts: { safeMode?: boolean } = {}): Frame {
  expect(r.facts, r.output).toBeDefined();
  const f = r.facts!;
  expect(f, r.output).toMatchObject({ ok: true, profile: "dist", appId: "com.waifucave.clover", name: "Clover", visibleWindows: 0, pair: "connected", safeMode: opts.safeMode ?? false });
  // The main window, and one per surface (the island and the pill are clover's; they stay hidden).
  expect(f.windows).toBe(1 + (f.surfaces as unknown[]).length);
  const rootFrame = f.frames.find((x) => x.origin === "clover-core://app");
  const shell = f.frames.find((x) => x.origin === "clover-plugin://clover");
  expect(rootFrame, r.output).toBeDefined();
  expect(shell, r.output).toMatchObject({ shell: true, sidebar: true, conversation: true, bridge: "object" });
  // The shell is its own layer: a process other than the root's.
  expect(shell!.osPid).not.toBe(rootFrame!.osPid);
  for (const frame of f.frames) {
    expect(frame.node, frame.origin).toBe(false);
    // The OS reports a process's sandbox on macOS and Windows only.
    if (process.platform !== "linux") expect(frame.sandboxed, frame.origin).toBe(true);
  }
  // The screen add-on loads in Electron's own Node on a Mac (the build makes it there), and reads the housing or none.
  const housing = f.housing as { addOn: boolean; notch: { width: number; height: number } | null } | undefined;
  if (process.platform === "darwin") expect(housing?.addOn, r.output).toBe(true);
  else expect(housing).toEqual({ addOn: false, notch: null });
  if (housing?.notch != null) expect(housing.notch.width).toBeGreaterThan(0);
  // The frame's variables reach the layer, and the base theme's CSS dresses it (scoped by `@scope` to the part).
  expect(shell!.insetTop).toBe("45px");
  expect(shell!.sheets, r.output).toBeGreaterThanOrEqual(1);
  expect(shell!.themed).toBe("optimizelegibility");
  return shell!;
}

function expectBothStopped(r: ReturnType<typeof smoke>): void {
  expect(r.status, r.output).toBe(0);
  const calls = readCalls(r.home).map((c) => (c.event === "request" ? `request ${String(c.method)}` : c.event));
  expect(calls).toContain("autostart-enable");
  expect(calls).toContain("autostart-start");
  expect(calls).toContain("request pair.quit");
  expect(calls).toContain("daemon-quit");
}

beforeAll(() => {
  if (!enabled) return;
  if (!ci) refuseForegroundElectron();
  work = mkdtempSync(join(tmpdir(), "clover-ui-"));
  if (!existsSync(join(root, "out", "main", "index.js"))) {
    const built = spawnSync("bun", ["run", "scripts/build.ts"], { cwd: root, encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
  }
  fakeCore = join(work, `clover-core${exe}`);
  const compiled = spawnSync("bun", ["build", "--compile", join(import.meta.dir, "fake-core", "fake-daemon.ts"), "--outfile", fakeCore], { encoding: "utf8" });
  expect(compiled.status, compiled.stderr).toBe(0);
  const base = [...cloverViews(), alphaView()];
  registries.default = join(work, "default.json");
  registries.fixture = join(work, "fixture.json");
  writeFileSync(registries.default, JSON.stringify({ plugins: base }));
  writeFileSync(registries.fixture, JSON.stringify({ plugins: [...base, folderView(join(FIXTURES, "fixture-composer")), folderView(join(FIXTURES, "fixture-surface"), 1001)] }));
  registries.welcome = join(work, "welcome.json");
  writeFileSync(registries.welcome, JSON.stringify({ plugins: base, models: [{ id: "fixture-model", name: "Fixture Model", terms: "Use it kindly.", auth: [{ method: "api-key" }] }] }));
  registries.manage = join(work, "manage.json");
  writeFileSync(registries.manage, JSON.stringify({ plugins: [...base, folderView(join(FIXTURES, "fixture-composer"))], listPlugins: true }));
  registries.web = join(work, "web.json");
  writeFileSync(registries.web, JSON.stringify({ plugins: [...base, folderView(join(FIXTURES, "fixture-web"), 1005)] }));
  registries.spin = join(work, "spin.json");
  writeFileSync(registries.spin, JSON.stringify({ plugins: [...base, folderView(join(FIXTURES, "fixture-spin"), 1004)] }));
  registries.dns = join(work, "dns.json");
  writeFileSync(registries.dns, JSON.stringify({ plugins: [...base, folderView(join(FIXTURES, "fixture-dns"), 1002), folderView(join(FIXTURES, "fixture-dns-control"), 1003)] }));
});

afterAll(() => {
  // CLOVER_UI_KEEP_HOMES=1 keeps each run's home (its log, net log and calls) for a look after a failure.
  if (process.env.CLOVER_UI_KEEP_HOMES === "1") return;
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
});

describe.if(enabled)("the app in Electron (UI test: CI, or locally with a background-only Electron)", () => {
  test("the default shell from F's plugins renders in the clover layer; the app starts the daemon and Quit stops both", () => {
    const r = smoke(electron(), [root], "default");
    const shell = expectShell(r);
    expect(shell.composer).toBe(true);
    expect(shell.text).toContain("Alpha");
    expect(r.facts!.mounts).toMatchObject({ root: 3, frame: 3 });
    expectBothStopped(r);
    expectQuiet(r);
  }, 120_000);

  test("a third-party part renders in a layer of its own, in its own process, themed by its tab; surfaces and menus go through the core", () => {
    // Both menus answered: the composer's (in the main window) and the surface's (in its own window).
    const r = smoke(electron(), [root], "fixture", { CLOVER_SMOKE_LAYERS: "1", CLOVER_SMOKE_WAIT_TEXT: "Picked: second|Menu: second", CLOVER_TEST_MENU_PICK: "second", CLOVER_SMOKE_INPUT: "1" });
    const shell = expectShell(r);
    const part = r.facts!.frames.find((x) => x.origin === "clover-plugin://fixture-composer");
    expect(part, r.output).toMatchObject({ bridge: "object", node: false });
    expect(part!.text).toContain("Send");
    expect(part!.text).toContain("Picked: second");
    expect(part!.osPid).not.toBe(shell.osPid);
    // It sits in Alpha's tab, so it wears Alpha's theme; the shell around the tabs wears the base theme.
    const alpha = JSON.parse(readFileSync(join(REPO, "plugins", "alpha", "tab", "theme.json"), "utf8")) as { tokens: Record<string, string>; dark?: { tokens: Record<string, string> } };
    const accent = (r.facts!.appearance === "dark" ? alpha.dark?.tokens["color.accent"] : undefined) ?? alpha.tokens["color.accent"];
    if (typeof accent === "string" && accent !== "system") expect(part!.accent.toUpperCase()).toBe(accent.toUpperCase());
    // The themes' CSS reaches another layer's document too.
    expect(part!.sheets).toBeGreaterThanOrEqual(1);
    expect(part!.themed).toBe("optimizelegibility");
    // Surface windows: one per `app.surface` entry with a window, each with its own root, never shown headless. The
    // fixture's part sized its window and got its menu's answer through the core.
    const surfaces = r.facts!.surfaces as { id: string; visible: boolean; bounds: { width: number; height: number }; frames: Frame[] }[];
    const fixture = surfaces.find((x) => x.id === "fixture");
    expect(fixture, r.output).toMatchObject({ visible: false, bounds: { width: 360, height: 120 } });
    const surfaceFrame = fixture!.frames.find((x) => x.origin === "clover-plugin://fixture-surface");
    expect(surfaceFrame, r.output).toMatchObject({ text: "Menu: second", node: false, bridge: "object" });
    expect(surfaces.map((x) => x.id).sort()).toEqual(["fixture", "island", "pill"]);
    expect(r.facts!.mounts).toMatchObject({ root: 4, frame: 5 });
    for (const x of surfaces) expect(x.visible).toBe(false);
    // Menus wait for the user's input in their window: refused before the test's key press, shown after it. The log
    // lines are asserted on the run's whole output: the refused ones begin early, and a fast run's tail can cut them.
    expect(r.all).toContain("menu: refused (a menu needs the user's recent click or key press in its window)");
    // The composer's menu came from a frame inside the shell's frame: placed by each frame's offset, low in the window.
    const at = [...r.all.matchAll(/menu: 1 item\(s\) at (\d+),(\d+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    expect(at.length, r.all).toBeGreaterThan(0);
    expect(at[0]!.y).toBeGreaterThan(300);
    expectBothStopped(r);
    expectQuiet(r);
  }, 120_000);

  test("a third-party layer that hangs has its process stopped; the app doesn't restart into safe mode", () => {
    // The layer hangs in its own handler; the window's `unresponsive` is raised by the run (index.ts says why), and
    // the app pings each document (3 s), stops the silent layer's process, and the census finds it gone.
    const r = smoke(electron(), [root], "spin", { CLOVER_SMOKE_HANG: "spin", CLOVER_SMOKE_WAIT_TEXT: "stopped drawing" });
    expectShell(r);
    // The whole run's output: these lines come early in it, and a fast run's 6,000-character tail cuts them.
    expect(r.all).toContain("went unresponsive; not answering: fixture-spin");
    expect(r.all).toContain("stopping a hung layer's process");
    expect(r.all).not.toContain("restarting in safe mode");
    const spin = (r.facts!.surfaces as { id: string; frames: Frame[] }[]).find((x) => x.id === "spin");
    expect(spin?.frames.some((f) => f.text.includes("stopped drawing")), r.output).toBe(true);
    expect(r.facts!.safeMode).toBe(false);
    expectBothStopped(r);
    expectQuiet(r);
  }, 120_000);

  test("the welcome guide opens on a first start with no provider signed in; its terms come first, and a key goes only to the sign-in", () => {
    const key = "fixture-key-0123456789";
    const steps = [
      { check: '[data-clover-terms="fixture-model"]' },
      { fill: '[data-clover-key="fixture-model#0"]', value: key },
      { click: '[data-clover-save="fixture-model#0"]' },
    ];
    const r = smoke(electron(), [root], "welcome", { CLOVER_SMOKE_ROOT_STEPS: JSON.stringify(steps), CLOVER_SMOKE_WAIT_TEXT: "Saved. Clover keeps the key" });
    expectShell(r);
    expect(r.all).toContain("welcome: no model provider is signed in; the guide opens");
    const rootFrame = r.facts!.frames.find((x) => x.origin === "clover-core://app")!;
    expect(rootFrame.text).toContain("Welcome to Clover");
    expect(rootFrame.text).toContain("Use it kindly.");
    expect(rootFrame.text).toContain("Signed in");
    const signIn = readCalls(r.home).find((c) => c.event === "request" && c.method === "plugin.auth.signIn");
    expect(signIn?.params).toEqual({ id: "fixture-model", index: 0, key: `<${key.length} characters>` });
    // The key reached the daemon's sign-in and nothing the app writes.
    expect(r.all).not.toContain(key);
    expectBothStopped(r);
    expectQuiet(r);
  }, 120_000);

  test("safe mode's plugin manager, from the core's own page: every plugin but the app's own, and one turned off", () => {
    const steps = [{ click: '[data-clover-turn-off="fixture-composer"]' }];
    const r = smoke(electron(), [root, "--safe-mode"], "manage", { CLOVER_SMOKE_PAGE: "plugins", CLOVER_SMOKE_ROOT_STEPS: JSON.stringify(steps), CLOVER_SMOKE_WAIT_TEXT: "fixture-composer · Off" });
    expectShell(r, { safeMode: true });
    const rootFrame = r.facts!.frames.find((x) => x.origin === "clover-core://app")!;
    expect(rootFrame.text).toContain("Safe mode: only Clover's own plugins run.");
    // The third-party plugin, now off, can still be removed; none of the app's own is listed.
    expect(rootFrame.text).toContain("fixture-composer · Off");
    expect(rootFrame.text).toContain("Remove");
    expect(rootFrame.text).not.toContain("clover/");
    expect(rootFrame.text).not.toContain("alpha");
    const turnedOff = readCalls(r.home).filter((c) => c.event === "request" && c.method === "plugin.setEnabled").map((c) => c.params);
    expect(turnedOff).toEqual([{ id: "fixture-composer", enabled: false }]);
    expectBothStopped(r);
    expectQuiet(r);
  }, 120_000);

  test("a web page entry shows in an isolated view of its own, in its own session, reaching nothing of the app's", () => {
    const r = smoke(electron(), [root], "web", { CLOVER_SMOKE_WAIT_TEXT: "Fixture web page (scripted)" });
    expectShell(r);
    const web = r.facts!.web as { mount: string; url: string; visible: boolean; text: string }[];
    expect(web, r.output).toHaveLength(1);
    expect(web[0]!.url).toBe("clover-web://fixture-web/page.html");
    expect(web[0]!.text).toContain("Fixture web page (scripted)");
    expect(web[0]!.text).toContain("bridge: none; node: none");
    // The view is drawn over its part, in the window (shown, though the window itself never is in a headless run).
    expect(web[0]!.visible).toBe(true);
    expectBothStopped(r);
    expectQuiet(r);
  }, 120_000);

  test("a window that stays unresponsive while every document in it answers restarts the app into safe mode after the longer window", () => {
    // The GPU or compositor case: the window is said to be unresponsive (as Chromium says it), each document answers
    // its ping, and the longer window (60 s, shortened here) runs out. The relaunch itself is left out of the run.
    const r = smoke(electron(), [root], "default", { CLOVER_SMOKE_UNRESPONSIVE: "1", CLOVER_SMOKE_COMPOSITOR_MS: "1500", CLOVER_SMOKE_SETTLE_MS: "5000", CLOVER_SMOKE_NO_RESTART: "1" });
    expectShell(r);
    expect(r.all).toMatch(/went unresponsive; not answering: none/);
    expect(r.all).toContain("every document answers; it has 2 s to come back");
    expect(r.all).toContain("stayed unresponsive: restarting in safe mode");
    expect(r.all).not.toContain("stopping a hung layer's process");
    expectBothStopped(r);
    expectQuiet(r);
  }, 120_000);

  test("S9's DNS-prefetch probe: a layer looks up no host name; the same document without its allowlist does", () => {
    const guarded = "fixture-dns-probe.example";
    const control = "fixture-dns-control-probe.example";
    const r = smoke(electron(), [root], "dns", { CLOVER_TEST_UNGUARDED_LAYERS: "fixture-dns-control", CLOVER_SMOKE_WAIT_TEXT: `probe: ${guarded}|probe: ${control}`, CLOVER_SMOKE_SETTLE_MS: "3000" });
    expectShell(r);
    const texts = (r.facts!.surfaces as { frames: Frame[] }[]).flatMap((x) => x.frames.map((f) => f.text));
    expect(texts, r.output).toContain(`probe: ${guarded}`);
    expect(texts, r.output).toContain(`probe: ${control}`);
    // The control's lookup is all: its DNS server (Chromium's own resolver, as on Windows, asks it on port 53) and the
    // resolver's IPv6 check it sets off (a UDP connect that sends nothing).
    const activity = expectQuiet(r, { lookups: [control], sockets: [IPV6_REACHABILITY_PROBE], ports: [53] });
    // The positive control reached the resolver, so the probe sees a lookup when one happens; the guarded one didn't.
    expect(activity.lookups, JSON.stringify(activity.lookups)).toContain(control);
    expect(activity.lookups).not.toContain(guarded);
    expectBothStopped(r);
  }, 120_000);

  test.if(ci)("the unsigned packaged app draws the same shell", () => {
    const dist = join(root, "out", "dist");
    const candidates = process.platform === "darwin"
      ? [join(dist, `mac-${process.arch}`, "Clover.app", "Contents", "MacOS", "Clover"), join(dist, "mac", "Clover.app", "Contents", "MacOS", "Clover")]
      : process.platform === "win32"
        ? [join(dist, "win-unpacked", "Clover.exe")]
        : [join(dist, process.arch === "x64" ? "linux-unpacked" : `linux-${process.arch}-unpacked`, "clover")];
    const executable = candidates.find((c) => existsSync(c));
    expect(executable, "run `bun run dist` first (the app job does)").toBeDefined();
    // A packaged dist app ignores CLOVER_DAEMON_BIN: it finds its daemon in its own resources, where lane M packages
    // it, so the fake goes there.
    const resources = process.platform === "darwin" ? join(dirname(dirname(executable!)), "Resources") : join(dirname(executable!), "resources");
    mkdirSync(join(resources, "daemon"), { recursive: true });
    copyFileSync(fakeCore, join(resources, "daemon", `clover-core${exe}`));
    const r = smoke(executable!, [], "default");
    expectShell(r);
    expect(r.facts!).toMatchObject({ packaged: true, version });
    expectBothStopped(r);
    expectQuiet(r);
  }, 120_000);

  test("the pair: a crashed daemon is started again, and the launcher's Quit stops both", async () => {
    const h = home();
    const e = env(h, "default");
    const netlog = join(h, "net.json");
    const app: ChildProcess = spawn(electron(), [root, "--clover-headless", `--log-net-log=${netlog}`], { env: e, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    app.stdout?.on("data", (d) => (output += d));
    app.stderr?.on("data", (d) => (output += d));
    const exited = new Promise<number | null>((resolve) => app.on("exit", (code) => resolve(code)));
    const until = async (check: () => boolean, ms: number, what: string) => {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) throw new Error(`timed out: ${what}\n${output.slice(-4000)}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    const events = () => readCalls(h).map((c) => (c.event === "request" ? `request ${String(c.method)}` : c.event));
    const pidFile = join(h, "fake", "daemon.pid");
    try {
      await until(() => events().includes("request plugin.ui"), 40_000, "the app connected to the daemon it started");
      const first = Number(readFileSync(pidFile, "utf8"));
      process.kill(first, "SIGKILL");
      // No OS restarts the fake: the app starts it again after its 3 s wait.
      await until(() => events().filter((x) => x === "daemon-started").length >= 2, 30_000, "the app started the daemon again");
      await until(() => events().filter((x) => x === "request plugin.ui").length >= 2, 20_000, "the app reconnected and rebuilt from the daemon");
      const second = Number(readFileSync(pidFile, "utf8"));
      expect(second).not.toBe(first);
      // The launcher's Quit: a second instance with --quit.
      spawnSync(electron(), [root, "--clover-headless", "--quit"], { env: e, timeout: 30_000 });
      const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000))]);
      expect(code, output.slice(-4000)).toBe(0);
      await until(() => events().includes("daemon-quit"), 10_000, "the daemon stopped");
      expect(events().filter((x) => x === "autostart-start").length).toBe(2);
      // Nothing left the machine through the crash and the restart either.
      expectQuiet({ status: code as number | null, facts: undefined, output, all: output, home: h, netlog });
    } finally {
      if (app.exitCode === null) app.kill("SIGKILL");
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 120_000);
});
