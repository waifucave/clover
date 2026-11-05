// Clover's desktop app, the main process (spec §3.1, §5.5, §5.8; plan §4 E, M1): the windows, the menu-bar or tray
// icon, the app's side of the always-on pair with the daemon, the protocol client, and the plugin runtime that loads
// the shell's UI halves into layers.
//
// The app runs in the menu bar (the tray) with no window until the user opens one. A start by the user opens the main
// window; a start by the daemon or at login doesn't. Closing a window only closes it; Quit stops both halves.
//
// A headless run (`--clover-headless`, the smoke run, the tests) never shows a window, a Dock icon or a tray icon and
// never takes the focus: on macOS the app is an accessory from its first line, and everything it writes stays in its
// temporary home.
import { mkdirSync, writeFileSync } from "node:fs";
import { release as osRelease } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, dialog, nativeTheme, powerMonitor, session, shell, systemPreferences, type Input, type MenuItemConstructorOptions } from "electron";
import { CLOVER_PROTOCOL_VERSION, type PairStatus, type UiPluginView, type UiSettings } from "@waifucave/clover-protocol";
import { systemAccentFromOs } from "@waifucave/clover-plugin-sdk";
import { appIdentity, daemonHome, parseLaunchArgs, resolveAppProfile, SMOKE_PREFIX, UI_PARTITION } from "./identity";
import { cliLauncher, locateDaemonBinary } from "./pair/login";
import { Pair, type PairState } from "./pair/pair";
import { quitQuestion, type QuitChoice } from "./pair/quit";
import { appHello, readAppToken, readStartInfo } from "./pair/start";
import { daemonEndpoint, type DaemonClient } from "./protocol/client";
import { AppTray } from "./tray";
import { readUiPlugins, type UiPluginExtras } from "./ui/model";
import { guardContents, hardenSession, installIpc, installUiSession, registerSchemes, startCensus } from "./ui/electron";
import { UiRuntime } from "./ui/runtime";
import type { Os } from "./ui/spots";
import { mainWindowPlan, TITLE_BAR_HEIGHT, webPreferences, windowsHasAcrylic } from "./window";

const identity = appIdentity(resolveAppProfile(process.env));
const args = parseLaunchArgs(process.argv, process.env);
const headless = args.headless;
const home = daemonHome(process.env);
const here = dirname(fileURLToPath(import.meta.url));
const dirs = { core: join(here, "..", "renderer", "core"), layer: join(here, "..", "renderer", "layer") };
const os: Os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

// Before anything else: no Dock icon until a window is shown, and none at all in a headless run.
if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.setName(identity.productName);
if (process.platform === "win32") app.setAppUserModelId(identity.appId);
// A headless run keeps everything it writes in its own (temporary) home.
if (headless) {
  app.setPath("userData", join(home, "app-data", identity.profile));
  app.setPath("sessionData", join(home, "app-data", identity.profile, "session"));
}
// Every plugin origin in a process of its own (S9).
app.commandLine.appendSwitch("site-per-process");
registerSchemes();

function log(line: string): void {
  process.stdout.write(`[clover-app] ${line}\n`);
}

const start = readStartInfo(home, process.argv);
const safeMode = start.safeMode || args.safeMode;

let runtime: UiRuntime;
let pair: Pair;
let tray: AppTray | undefined;
let mainWindow: BrowserWindow | undefined;
let leaving = false;
let shuttingDown = false;

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", (_event, argv) => {
    const second = parseLaunchArgs(argv);
    if (second.quit) void requestQuit("launcher");
    else if (!headless) void openMainWindow();
  });
  app.on("window-all-closed", () => {
    // Closing a window only closes it: the app stays in the menu bar.
  });
  app.on("web-contents-created", (_event, contents) => guardContents(contents, log));
  app.on("before-quit", (event) => {
    if (leaving || shuttingDown) return;
    // The OS asked (the Dock's Quit): the app's own Quit stops both halves, so it asks first.
    event.preventDefault();
    void requestQuit("os");
  });
  void app.whenReady().then(ready).catch((err) => {
    log(`start failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    if (args.smoke) report({ ok: false, reason: `start failed: ${String(err)}` });
  });
}

async function ready(): Promise<void> {
  if (process.platform === "darwin") {
    app.setActivationPolicy("accessory");
    if (headless) app.dock?.hide();
  }
  powerMonitor.on("shutdown", () => {
    shuttingDown = true;
  });
  await hardenSession(session.defaultSession, log);
  const ui = session.fromPartition(UI_PARTITION);
  await hardenSession(ui, log);

  runtime = new UiRuntime({ os, platform: process.platform, safeMode, log });
  installUiSession(ui, runtime, dirs, log);
  installIpc(runtime, {
    frameMetrics: (id, m) => runtime.setFrameMetrics(id, m),
    rootCommand: (_id, name) => {
      if (name === "restart-normally") void restart(false);
      if (name === "restart-safe-mode") void restart(true);
    },
  }, log);
  startCensus(runtime);
  syncAppearance();
  nativeTheme.on("updated", syncAppearance);
  if (process.platform === "win32") systemPreferences.on("accent-color-changed", syncAppearance);

  pair = makePair();
  setMenu();
  if (!headless) {
    tray = new AppTray(join(here, "tray.png"), { open: () => void openMainWindow(), quit: () => void requestQuit("tray"), restart: (s) => void restart(s) }, log);
    tray.show({ safeMode });
  }
  // A start by the user opens the window; a start by the daemon or at login doesn't. A headless run opens it hidden.
  if (start.by === "user" || headless) void openMainWindow();
  await pair.start();
  if (args.smoke) await smoke();
}

// ------------------------------------------------------------------------------------------------
// The pair
// ------------------------------------------------------------------------------------------------

function makePair(): Pair {
  const binary = locateDaemonBinary({ env: process.env, packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const p = new Pair({
    endpoint: daemonEndpoint(home),
    hello: () => {
      const token = readAppToken(home, process.env);
      return token === undefined ? undefined : appHello(token, app.getVersion(), CLOVER_PROTOCOL_VERSION);
    },
    ...(binary !== undefined ? { launcher: cliLauncher({ binary, home, profile: identity.profile }) } : {}),
    log,
    onConnected: (client) => loadRegistry(client),
    onState: (s) => stateChanged(s),
    onDaemonQuit: (reason) => {
      log(`the daemon asked the app to quit (${reason})`);
      exitApp();
    },
  });
  p.handle("app.show", (params) => show(params));
  p.onNotification((method, params) => {
    if (method !== "core.event" || params === null || typeof params !== "object") return;
    const type = (params as { type?: unknown }).type;
    if (type === "ui_settings_changed") runtime.setChoices(((params as { settings: UiSettings }).settings) as never);
    if (type === "plugin_changed" || type === "plugin_removed" || type === "plugin_found") scheduleReload();
  });
  return p;
}

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReload(): void {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const c = pair.client;
    if (c !== undefined) void loadRegistry(c);
  }, 200);
}

/** The registry and the user's choices, on every connection (state is the core's: a reconnect rebuilds from it). */
async function loadRegistry(client: DaemonClient): Promise<void> {
  const [ui, settings, status] = await Promise.all([
    client.request<{ plugins: UiPluginView[] }>("plugin.ui"),
    client.request<UiSettings>("ui.settings"),
    client.request<PairStatus>("pair.status").catch(() => undefined),
  ]);
  let extras: Record<string, UiPluginExtras> = {};
  try {
    const list = await client.request<{ plugins: { id: string; source: string }[] }>("plugin.list");
    extras = Object.fromEntries(list.plugins.map((p) => [p.id, { source: p.source === "bundled" ? "bundled" : p.source === "dev" ? "dev" : "installed" } as UiPluginExtras]));
  } catch {
    // An older daemon, or the fake: the view's own fields, else the defaults.
  }
  if (status?.safeMode === true) runtime.setSafeMode(true);
  runtime.setRegistry(readUiPlugins(ui.plugins, extras));
  runtime.setChoices(settings as never);
  await client.request("events.subscribe", { areas: ["plugins", "app"] }).catch(() => undefined);
  log(`layers: ${ui.plugins.length} plugin(s) with UI`);
}

function stateChanged(s: PairState): void {
  log(`pair: ${s.kind}${s.kind === "unavailable" ? ` (${s.reason})` : ""}`);
  const status = s.kind === "reconnecting" ? "Reconnecting to Clover…" : s.kind === "unavailable" ? "Clover isn't running" : s.kind === "starting-daemon" ? "Starting Clover…" : undefined;
  tray?.show({ safeMode: runtime.safeMode, ...(status !== undefined ? { status } : {}) });
}

/** The daemon asks the app to open a window or a place in it (§3.1, lane B's `app.show`). */
async function show(params: unknown): Promise<{ ok: true }> {
  const what = (params as { what?: { kind?: string; url?: string; section?: string } } | undefined)?.what;
  if (what?.kind === "url" && typeof what.url === "string") {
    const url = new URL(what.url);
    if (url.protocol === "https:" || url.protocol === "http:") await shell.openExternal(url.toString());
    return { ok: true };
  }
  const win = await openMainWindow();
  if (win !== undefined && what?.kind === "settings") runtime.command(win.id, "open-settings");
  return { ok: true };
}

/** Quit (§3.1): says what would stop, offers Hand over and quit, then stops both halves. */
async function requestQuit(source: string): Promise<void> {
  if (leaving) return;
  const client = pair?.client;
  let status: PairStatus | undefined;
  try {
    status = client === undefined ? undefined : await client.request<PairStatus>("pair.status", {}, 3_000);
  } catch {
    status = undefined;
  }
  const q = quitQuestion(status);
  let choice: QuitChoice = "quit";
  if (q.ask) {
    if (headless) {
      const env = process.env.CLOVER_TEST_QUIT_CHOICE;
      choice = env === "handover" || env === "cancel" ? env : "quit";
    } else {
      const r = await dialog.showMessageBox({ type: "question", message: q.message, detail: q.detail, buttons: q.buttons.map((b) => b.label), defaultId: 0, cancelId: q.buttons.length - 1, noLink: true });
      choice = q.buttons[r.response]?.id ?? "cancel";
    }
  }
  log(`quit (${source}): ${choice}`);
  if (choice === "cancel") return;
  if (client !== undefined) await pair.quit(choice === "handover");
  exitApp();
}

/** Leaves on purpose for a restart (into safe mode or out of it), telling the daemon first (§3.1). */
async function restart(safe: boolean): Promise<void> {
  await pair.exiting("restart");
  const rest = process.argv.slice(1).filter((a) => a !== "--safe-mode" && !a.startsWith("--clover-started-by="));
  app.relaunch({ args: [...rest, ...(safe ? ["--safe-mode"] : [])] });
  exitApp();
}

function exitApp(): void {
  leaving = true;
  pair?.stop();
  tray?.destroy();
  app.exit(0);
}

// ------------------------------------------------------------------------------------------------
// Windows
// ------------------------------------------------------------------------------------------------

function syncAppearance(): void {
  const raw = process.platform === "darwin" || process.platform === "win32" ? systemPreferences.getAccentColor() : "";
  runtime?.setAppearance(nativeTheme.shouldUseDarkColors ? "dark" : "light", raw === "" ? undefined : systemAccentFromOs(raw));
}

/** macOS: a Dock icon only while a window shows (never in a headless run). */
function syncActivation(): void {
  if (process.platform !== "darwin" || headless) return;
  const visible = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible());
  app.setActivationPolicy(visible ? "regular" : "accessory");
}

async function openMainWindow(): Promise<BrowserWindow | undefined> {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (!headless) {
      mainWindow.show();
      syncActivation();
    }
    return mainWindow;
  }
  const dark = nativeTheme.shouldUseDarkColors;
  const plan = mainWindowPlan({
    platform: process.platform,
    acrylic: process.platform === "win32" && windowsHasAcrylic(osRelease()),
    title: identity.productName,
    dark,
    solid: dark ? "#202020" : "#F5F5F5",
    symbol: dark ? "#F2F2F2" : "#1F1F1F",
    webPreferences: webPreferences({ preload: join(here, "preload.cjs"), partition: UI_PARTITION, headless, offscreen: args.capture !== undefined }),
  });
  const win = new BrowserWindow(plan.options);
  mainWindow = win;
  const id = win.id;
  runtime.openWindow(id, { material: plan.material });
  if (process.platform === "darwin") runtime.setFrameMetrics(id, { top: TITLE_BAR_HEIGHT, start: 80, end: 0 });
  win.on("closed", () => {
    runtime.closeWindow(id);
    if (mainWindow === win) mainWindow = undefined;
    syncActivation();
  });
  win.on("hide", syncActivation);
  win.on("focus", () => runtime.focusReturned(id));
  win.webContents.on("before-input-event", (event, input) => shortcut(event, input, win));
  win.once("ready-to-show", () => {
    if (headless) return;
    win.show();
    syncActivation();
  });
  await win.loadURL("clover-core://app/");
  return win;
}

/** The app's shortcuts, ahead of every layer (S9: the host owns them through `before-input-event`). macOS's come
 *  from the menu's accelerators. */
function shortcut(event: Electron.Event, input: Input, win: BrowserWindow): void {
  if (input.type !== "keyDown" || process.platform === "darwin") return;
  if (!input.control || input.alt || input.meta) return;
  const key = input.key.toLowerCase();
  if (key === "q") {
    event.preventDefault();
    void requestQuit("shortcut");
  } else if (key === "w" && !input.shift) {
    event.preventDefault();
    win.close();
  } else if (key === ",") {
    event.preventDefault();
    runtime.command(win.id, "open-settings");
  }
}

function setMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: identity.productName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "Command+,", click: () => void show({ what: { kind: "settings" } }) },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: `Quit ${identity.productName}`, accelerator: "Command+Q", click: () => void requestQuit("menu") },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------------------------------------
// The smoke run (the UI test): draw the default shell headless, report what it is, then Quit both halves
// ------------------------------------------------------------------------------------------------

function report(facts: Record<string, unknown>): void {
  const line = JSON.stringify(facts);
  const out = process.env.CLOVER_SMOKE_OUT;
  if (out !== undefined && out !== "") {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${line}\n`);
  }
  process.stdout.write(`${SMOKE_PREFIX}${line}\n`);
}

async function smoke(): Promise<void> {
  const deadline = Date.now() + 45_000;
  const win = await openMainWindow();
  if (win === undefined) return report({ ok: false, reason: "no window" });
  const probe = `(() => ({
    origin: location.origin,
    node: typeof require !== "undefined" || typeof process !== "undefined",
    bridge: typeof window.cloverLayer,
    shell: !!document.querySelector(".cl-window"),
    sidebar: !!document.querySelector(".cl-window__sidebar *"),
    conversation: !!document.querySelector(".cl-bot-tab__conversation *"),
    composer: !!document.querySelector(".cl-bot-tab__composer textarea, .cl-bot-tab__composer [contenteditable], .cl-bot-tab__composer iframe"),
    frames: document.querySelectorAll("iframe").length,
    accent: getComputedStyle(document.documentElement).getPropertyValue("--clover-color-accent").trim(),
    insetTop: getComputedStyle(document.documentElement).getPropertyValue("--clover-frame-inset-top").trim(),
    text: (document.body.innerText || "").slice(0, 200),
  }))()`;
  type Probe = { origin: string; node: boolean; bridge: string; shell: boolean; sidebar: boolean; conversation: boolean; composer: boolean; frames: number; accent: string; insetTop: string; text: string };
  let frames: (Probe & { url: string; osPid: number })[] = [];
  while (Date.now() < deadline) {
    frames = [];
    for (const f of win.webContents.mainFrame.framesInSubtree) {
      try {
        frames.push({ ...(await f.executeJavaScript(probe, true) as Probe), url: f.url.replace(/mount=[0-9a-f]+/, "mount=…"), osPid: f.osProcessId });
      } catch {
        // A frame still loading.
      }
    }
    const shell = frames.find((f) => f.origin === "clover-plugin://clover");
    const wanted = Number(process.env.CLOVER_SMOKE_LAYERS ?? "0");
    const others = new Set(frames.filter((f) => f.origin.startsWith("clover-plugin://") && f.origin !== "clover-plugin://clover").map((f) => f.origin));
    if (shell?.shell && shell.composer && others.size >= wanted) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const metrics = app.getAppMetrics();
  const shellFrame = frames.find((f) => f.origin === "clover-plugin://clover");
  let captured: string | undefined;
  if (args.capture !== undefined) {
    try {
      const image = await win.webContents.capturePage();
      writeFileSync(args.capture, image.toPNG());
      captured = args.capture;
    } catch (err) {
      captured = `failed: ${String(err)}`;
    }
  }
  report({
    ok: shellFrame?.shell === true,
    profile: identity.profile,
    appId: identity.appId,
    name: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    windows: BrowserWindow.getAllWindows().length,
    visibleWindows: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
    title: win.getTitle(),
    pair: pair.state.kind,
    appearance: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    safeMode: runtime.safeMode,
    material: runtime ? (process.platform === "darwin" ? "vibrancy" : process.platform === "win32" ? (windowsHasAcrylic(osRelease()) ? "acrylic" : "none") : "none") : "none",
    frames: frames.map((f) => ({ ...f, sandboxed: metrics.find((m) => m.pid === f.osPid)?.sandboxed ?? null })),
    mounts: runtime.stats(),
    captured,
  });
  if (process.env.CLOVER_SMOKE_KEEP === "1") return;
  await requestQuit("smoke");
}
