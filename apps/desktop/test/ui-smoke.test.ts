// The app for real, in Electron, against the fake daemon: the default shell from lane F's plugins drawn in layers, a
// third-party part in a layer of its own, the packaged app, and the pair (the app starts the daemon, starts it again
// after a crash, and Quit stops both).
//
// CI runs it (CI=true and CLOVER_UI_TESTS=1, the app job in .github/workflows/ci.yml; Linux under xvfb). Locally it
// runs only when CLOVER_UI_LOCAL_ELECTRON names an Electron that can never come to the front (a copy with
// LSBackgroundOnly on macOS); every run is headless: no window shown, no Dock or tray icon, no focus (plan §8).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCalls } from "./fake-core/fake-daemon";
import { FIXTURES, REPO, alphaView, cloverViews, folderView } from "./fake-core/registry";

const root = join(import.meta.dir, "..");
const ci = process.env.CI === "true" && process.env.CLOVER_UI_TESTS === "1";
const localElectron = process.env.CLOVER_UI_LOCAL_ELECTRON;
const enabled = ci || (localElectron !== undefined && localElectron !== "");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const exe = process.platform === "win32" ? ".exe" : "";

interface Frame { origin: string; node: boolean; bridge: string; shell: boolean; sidebar: boolean; conversation: boolean; composer: boolean; frames: number; accent: string; insetTop: string; text: string; url: string; osPid: number; sandboxed: boolean | null }
interface Smoke { ok: boolean; frames: Frame[]; [key: string]: unknown }

let work: string;
let fakeCore: string;
const registries: Record<string, string> = {};
const homes: string[] = [];

function electron(): string {
  return localElectron !== undefined && localElectron !== "" ? localElectron : (createRequire(join(root, "package.json"))("electron") as string);
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

function smoke(executable: string, args: string[], registry: string, extra: Record<string, string> = {}): { status: number | null; facts: Smoke | undefined; output: string; home: string } {
  const h = home();
  const out = join(h, "smoke.json");
  const r = spawnSync(executable, [...args, "--clover-smoke"], { env: env(h, registry, { CLOVER_SMOKE_OUT: out, ...extra }), encoding: "utf8", timeout: 100_000 });
  const facts = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Smoke) : undefined;
  return { status: r.status, facts, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`.slice(-6000), home: h };
}

function expectShell(r: ReturnType<typeof smoke>): Frame {
  expect(r.facts, r.output).toBeDefined();
  const f = r.facts!;
  expect(f, r.output).toMatchObject({ ok: true, profile: "dist", appId: "com.waifucave.clover", name: "Clover", visibleWindows: 0, pair: "connected", safeMode: false });
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
  // The frame's variables reach the layer.
  expect(shell!.insetTop).toBe("45px");
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
});

afterAll(() => {
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
  }, 120_000);

  test("a third-party part renders in a layer of its own, in its own process, themed by its tab; surfaces and menus go through the core", () => {
    const r = smoke(electron(), [root], "fixture", { CLOVER_SMOKE_LAYERS: "1", CLOVER_SMOKE_WAIT_TEXT: "Menu:", CLOVER_TEST_MENU_PICK: "second" });
    const shell = expectShell(r);
    const part = r.facts!.frames.find((x) => x.origin === "clover-plugin://fixture-composer");
    expect(part, r.output).toMatchObject({ bridge: "object", node: false, text: "Send" });
    expect(part!.osPid).not.toBe(shell.osPid);
    // It sits in Alpha's tab, so it wears Alpha's theme; the shell around the tabs wears the base theme.
    const alpha = JSON.parse(readFileSync(join(REPO, "plugins", "alpha", "tab", "theme.json"), "utf8")) as { tokens: Record<string, string>; dark?: { tokens: Record<string, string> } };
    const accent = (r.facts!.appearance === "dark" ? alpha.dark?.tokens["color.accent"] : undefined) ?? alpha.tokens["color.accent"];
    if (typeof accent === "string" && accent !== "system") expect(part!.accent.toUpperCase()).toBe(accent.toUpperCase());
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
    // The composer's menu came from a frame inside the shell's frame: placed by each frame's offset, low in the window.
    const at = [...r.output.matchAll(/menu: 1 item\(s\) at (\d+),(\d+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    expect(at.length, r.output).toBeGreaterThan(0);
    expect(at[0]!.y).toBeGreaterThan(300);
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
    const r = smoke(executable!, [], "default");
    expectShell(r);
    expect(r.facts!).toMatchObject({ packaged: true, version });
    expectBothStopped(r);
  }, 120_000);

  test("the pair: a crashed daemon is started again, and the launcher's Quit stops both", async () => {
    const h = home();
    const e = env(h, "default");
    const app: ChildProcess = spawn(electron(), [root, "--clover-headless"], { env: e, stdio: ["ignore", "pipe", "pipe"] });
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
