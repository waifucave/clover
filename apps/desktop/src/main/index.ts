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
import { hostname, release as osRelease } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, dialog, nativeTheme, powerMonitor, screen, session, shell, systemPreferences, type Input, type MenuItemConstructorOptions } from "electron";
import { APP_METHODS, BROWSER_METHODS, CLOVER_PROTOCOL_VERSION, CORE_EVENT_NOTIFICATION, PairStatus, UiSettings, UiSettingsChangedEvent } from "@waifucave/clover-protocol";
import { systemAccentFromOs } from "@waifucave/clover-plugin-sdk";
import { BROWSER_ASSETS, createBrowserHost, isBrowserContents, type BrowserHost } from "./browser/index";
import { HangWatch } from "./hang";
import { appIdentity, daemonHome, parseLaunchArgs, resolveAppProfile, SMOKE_PREFIX, UI_PARTITION } from "./identity";
import { cliLauncher, locateDaemonBinary } from "./pair/login";
import { Pair, type PairState } from "./pair/pair";
import { quitQuestion, type QuitChoice } from "./pair/quit";
import { appHello, devOverridesAllowed, pairEnv, readAppToken, readStartInfo } from "./pair/start";
import { daemonEndpoint, type DaemonClient } from "./protocol/client";
import { appShortcut } from "./shortcuts";
import { AppTray } from "./tray";
import { readUiPlugins, type UiPluginExtras } from "./ui/model";
import { MenuGate, ViewFrames, checkRegions, inRegions, mayOpen, surfaceBounds, surfaceMayFloat, surfacePlacement, surfaceSize, type MenuItem, type Rect } from "./ui/brokers";
import type { OpenTarget, SurfaceEnvironment } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { guardContents, hardenSession, installIpc, installUiSession, registerSchemes, startCensus } from "./ui/electron";
import { LayerError, UiRuntime } from "./ui/runtime";
import type { Os } from "./ui/spots";
import { linuxSession, mainWindowPlan, surfaceWindowPlan, TITLE_BAR_HEIGHT, webPreferences, windowsHasAcrylic } from "./window";

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
// No proxy at all, from the first request: every session's own direct proxy comes too late for what Chromium does as it
// starts (the UI test's net log caught a `wpad` lookup on Windows).
app.commandLine.appendSwitch("no-proxy-server");
const session_ = linuxSession(process.env);
registerSchemes();

function log(line: string): void {
  process.stdout.write(`[clover-app] ${line}\n`);
}

// The dev overrides (the daemon binary, the app token) count only in a dev or unpackaged run.
const env = pairEnv(process.env, devOverridesAllowed({ packaged: app.isPackaged, profile: identity.profile }));
const start = readStartInfo(home, process.argv);
const safeMode = start.safeMode || args.safeMode;

let runtime: UiRuntime;
let pair: Pair;
let browser: BrowserHost | undefined;
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
  // The app's guards on every webContents but the Clover Browser's (its tabs, the windows its pages open and its
  // viewport pages), which lane L's own policy covers (ruling R11); `isBrowserContents` holds from creation on.
  app.on("web-contents-created", (_event, contents) => {
    if (!isBrowserContents(contents)) guardContents(contents, log);
  });
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

  runtime = new UiRuntime({ os, platform: process.platform, safeMode, log, onGone: (mount) => views.drop(mount) });
  // The UI test's positive control for the DNS probe: never in a packaged app.
  const unguarded = !app.isPackaged && headless ? (process.env.CLOVER_TEST_UNGUARDED_LAYERS ?? "").split(",").filter((l) => l !== "") : [];
  installUiSession(ui, runtime, dirs, log, { unguardedLayers: new Set(unguarded) });
  installIpc(runtime, {
    frameMetrics: (id, m) => runtime.setFrameMetrics(id, m),
    rootCommand: (_id, name) => {
      if (name === "restart-normally") void restart(false);
      if (name === "restart-safe-mode") void restart(true);
    },
    surface: (id, request) => steerSurface(id, request),
    surfaceEnvironment: (id) => surfaceEnvironment(id),
    open: (pluginId, target) => openFor(pluginId, target),
    viewFrame: (windowId, mount, name, bounds, used) => views.report(name, mount, windowId, bounds, used),
    menu: (id, items, point) => popupMenu(id, items, point),
  }, log);
  startCensus(runtime);
  syncAppearance();
  nativeTheme.on("updated", syncAppearance);
  if (process.platform === "win32") systemPreferences.on("accent-color-changed", syncAppearance);

  for (const e of ["display-metrics-changed", "display-added", "display-removed"] as const) screen.on(e as "display-added", () => tellSurfaces());
  startBrowser();
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
  const binary = locateDaemonBinary({ env, packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const p = new Pair({
    endpoint: daemonEndpoint(home),
    hello: () => {
      const token = readAppToken(home, env);
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
  // The Clover Browser (lane L): the daemon drives its tabs over the pair.
  p.handle("app.tab.open", async (params) => {
    const a = BROWSER_METHODS.appTabOpen.params.parse(params);
    return { tab: await browserHost().open(a) };
  });
  p.handle("app.tab.command", async (params) => {
    const a = BROWSER_METHODS.appTabCommand.params.parse(params);
    return { result: await browserHost().command(a.id, a.command) };
  });
  p.handle("app.tab.list", () => ({ tabs: browserHost().list() }));
  // The heartbeat (ruling R9): answered at once, from the main process, so a hung app goes unanswered.
  p.handle("app.ping", () => ({ ok: true }));
  p.handle("app.show", (params) => {
    const parsed = APP_METHODS.appShow.params.safeParse(params);
    if (!parsed.success) throw new Error("app.show needs a place to show");
    return show(parsed.data.what);
  });
  // Every message from the daemon is checked against lane B's schemas before it changes anything.
  p.onNotification((method, params) => {
    if (method !== CORE_EVENT_NOTIFICATION || params === null || typeof params !== "object") return;
    const type = (params as { type?: unknown }).type;
    if (type === "ui_settings_changed") {
      const parsed = UiSettingsChangedEvent.safeParse(params);
      if (parsed.success) runtime.setChoices(parsed.data.settings as never);
      else log("pair: ignored a ui_settings_changed event that isn't one");
    }
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
  const [ui, settingsRaw, statusRaw] = await Promise.all([
    client.request<unknown>("plugin.ui"),
    client.request<unknown>("ui.settings"),
    client.request<unknown>("pair.status").catch(() => undefined),
  ]);
  const views = ui !== null && typeof ui === "object" && Array.isArray((ui as { plugins?: unknown }).plugins) ? (ui as { plugins: unknown[] }).plugins : [];
  const settings = UiSettings.safeParse(settingsRaw);
  if (!settings.success) log("pair: the daemon's UI settings aren't valid; the defaults apply");
  const status = statusRaw === undefined ? undefined : PairStatus.safeParse(statusRaw);
  let extras: Record<string, UiPluginExtras> = {};
  try {
    const list = await client.request<{ plugins?: unknown }>("plugin.list");
    const rows = Array.isArray(list?.plugins) ? (list.plugins as { id?: unknown; source?: unknown }[]) : [];
    extras = Object.fromEntries(rows.filter((p) => typeof p?.id === "string").map((p) => [p.id as string, { source: p.source === "bundled" ? "bundled" : p.source === "dev" ? "dev" : "installed" } as UiPluginExtras]));
  } catch {
    // An older daemon, or the fake: the view's own fields, else the defaults.
  }
  if (status?.success === true && status.data.safeMode) runtime.setSafeMode(true);
  const plugins = readUiPlugins(views, extras, log);
  runtime.setRegistry(plugins);
  runtime.setChoices((settings.success ? settings.data : { picks: [], lists: [] }) as never);
  syncSurfaces();
  await client.request("events.subscribe", { areas: ["plugins", "app"] }).catch(() => undefined);
  log(`layers: ${plugins.length} plugin(s) with UI`);
}

function stateChanged(s: PairState): void {
  log(`pair: ${s.kind}${s.kind === "unavailable" ? ` (${s.reason})` : ""}`);
  const status = s.kind === "reconnecting" ? "Reconnecting to Clover…" : s.kind === "unavailable" ? "Clover isn't running" : s.kind === "starting-daemon" ? "Starting Clover…" : undefined;
  tray?.show({ safeMode: runtime.safeMode, ...(status !== undefined ? { status } : {}) });
}

/** The daemon asks the app to open a window or a place in it (§3.1, lane B's `app.show`), checked against its schema. */
async function show(what: { kind: string; url?: string; section?: string; item?: string; bot?: string }): Promise<{ ok: true }> {
  if (what.kind === "url" && typeof what.url === "string") {
    const url = new URL(what.url);
    if (url.protocol === "https:" || url.protocol === "http:") await shell.openExternal(url.toString());
    return { ok: true };
  }
  const win = await openMainWindow();
  if (win === undefined) return { ok: true };
  if (what.kind === "settings") runtime.command(win.id, "open-settings", { ...(what.section !== undefined ? { section: what.section } : {}), ...(what.item !== undefined ? { item: what.item } : {}) });
  if (what.kind === "bot" && what.bot !== undefined) runtime.command(win.id, "open-bot", { bot: what.bot });
  return { ok: true };
}

/** A part asks to open a place in the main window (the island's Usage and Devices tabs open Settings there). */
async function openFor(pluginId: string, target: OpenTarget): Promise<void> {
  if (!mayOpen(pluginId)) throw new LayerError("only the app's own parts open places in its window");
  log(`open: ${target.kind}${target.kind === "settings" && target.section !== undefined ? ` ${target.section}` : ""} for ${pluginId}`);
  await show(target);
}

/** Quit (§3.1): says what would stop, offers Hand over and quit, then stops both halves. */
async function requestQuit(source: string): Promise<void> {
  if (leaving) return;
  const client = pair?.client;
  let status: unknown;
  try {
    status = client === undefined ? undefined : await client.request<unknown>("pair.status", {}, 3_000);
  } catch {
    status = undefined;
  }
  // A status that isn't one falls back to a plain Quit.
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
  try {
    browser?.shutdown();
  } catch (err) {
    log(`browser: shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  watchWindow(win);
  runtime.openWindow(id, { material: plan.material });
  if (process.platform === "darwin") runtime.setFrameMetrics(id, { top: TITLE_BAR_HEIGHT, start: 80, end: 0 });
  win.on("closed", () => {
    runtime.closeWindow(id);
    if (mainWindow === win) mainWindow = undefined;
    syncActivation();
  });
  win.on("hide", syncActivation);
  // Windows ends the session (logoff, shutdown): let the app go without asking.
  win.on("session-end", () => {
    shuttingDown = true;
  });
  win.on("focus", () => runtime.focusReturned(id));
  win.webContents.on("before-input-event", (event, input) => shortcut(event, input, win));
  win.webContents.on("before-mouse-event", (_event, mouse) => {
    if (mouse.type === "mouseDown") menus.input(id);
  });
  win.once("ready-to-show", () => {
    if (headless) return;
    win.show();
    syncActivation();
  });
  await win.loadURL("clover-core://app/");
  return win;
}

// ------------------------------------------------------------------------------------------------
// Surface windows (`app.surface` entries with a `window`: the island, the pill). Each has its own core root, which
// mounts its one entry from its plugin's layer. They start hidden; the surface shows itself, sizes itself and says
// where it takes clicks (elsewhere clicks pass through to whatever is under it). Never shown in a headless run.
// ------------------------------------------------------------------------------------------------

interface Surface {
  win: BrowserWindow;
  ref: string;
  pluginId: string;
  placement?: string;
  regions: Rect[];
  poll?: ReturnType<typeof setInterval>;
}
const surfaces = new Map<string, Surface>();

function syncSurfaces(): void {
  const wanted = runtime.surfaceEntries();
  for (const [id, s] of [...surfaces]) {
    if (wanted.some((w) => w.id === id && w.ref === s.ref)) continue;
    clearInterval(s.poll);
    surfaces.delete(id);
    if (!s.win.isDestroyed()) s.win.destroy();
  }
  for (const w of wanted) {
    if (surfaces.has(w.id)) continue;
    // Only the clover tree's surfaces float above everything, on every Space (the review's ruling for 1.111.1).
    const floats = surfaceMayFloat(w.pluginId);
    const wayland = session_ === "wayland";
    const win = new BrowserWindow(surfaceWindowPlan({
      surface: { ...w.window, alwaysOnTop: floats && w.window.alwaysOnTop === true },
      title: `${identity.productName} ${w.id}`,
      webPreferences: webPreferences({ preload: join(here, "preload.cjs"), partition: UI_PARTITION, headless, offscreen: false }),
      wayland,
    }));
    watchWindow(win);
    // `skipTransformProcessType`: without it Electron hides the Dock icon while the window shows, which fights
    // `syncActivation`.
    if (process.platform === "darwin" && floats) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    if (floats && !wayland && w.window.alwaysOnTop === true) win.setAlwaysOnTop(true, process.platform === "darwin" ? "status" : "floating");
    const placement = w.window.placement?.[os];
    const s: Surface = { win, ref: w.ref, pluginId: w.pluginId, regions: [], ...(placement !== undefined ? { placement } : {}) };
    surfaces.set(w.id, s);
    const id = win.id;
    runtime.openWindow(id, { material: "none", surface: { id: w.id, ref: w.ref } });
    win.on("closed", () => {
      clearInterval(s.poll);
      runtime.closeWindow(id);
      if (surfaces.get(w.id) === s) surfaces.delete(w.id);
    });
    place(w.id, s, win.getSize());
    void win.loadURL(`clover-core://app/?surface=${encodeURIComponent(w.id)}`);
  }
}

function place(surface: string, s: Surface, [width, height]: number[]): void {
  const display = screen.getPrimaryDisplay();
  s.win.setBounds(surfacePlacement({ surface, ...(s.placement !== undefined ? { placement: s.placement } : {}), size: { width: width!, height: height! }, display: display.bounds, workArea: display.workArea }));
}

function steerSurface(windowId: number, request: Record<string, unknown>): void {
  const entry = [...surfaces].find(([, s]) => !s.win.isDestroyed() && s.win.id === windowId);
  if (entry === undefined) return;
  const [id, s] = entry;
  const trusted = surfaceMayFloat(s.pluginId);
  const wayland = session_ === "wayland";
  // A whole place on the screen, kept on its display (on Wayland the compositor may ignore where).
  const display = screen.getPrimaryDisplay();
  const bounds = request.bounds === undefined ? undefined : surfaceBounds(request.bounds, display, trusted);
  if (bounds !== undefined) {
    s.win.setBounds(bounds);
  } else if (request.width !== undefined || request.height !== undefined) {
    const [w, h] = s.win.getSize();
    const size = surfaceSize(request, { width: w!, height: h! }, { trusted: surfaceMayFloat(s.pluginId), workArea: screen.getPrimaryDisplay().workArea });
    place(id, s, [size.width, size.height]);
  }
  // On Wayland a surface is a normal window: it takes every click inside it.
  if (request.regions !== undefined && !wayland) {
    const [w, h] = s.win.getSize();
    s.regions = checkRegions(request.regions, { width: w!, height: h! });
  }
  if (request.visible === true && !headless) s.win.showInactive();
  if (request.visible === false) s.win.hide();
  clickThrough(s);
}

/** A surface window's environment: the OS, the display server, its display (the primary one, where surfaces sit), and
 *  the camera housing, which the native add-on reads (E-M2; null until then). */
function surfaceEnvironment(windowId: number): SurfaceEnvironment | undefined {
  if (![...surfaces.values()].some((s) => !s.win.isDestroyed() && s.win.id === windowId)) return undefined;
  const d = screen.getPrimaryDisplay();
  return { os, ...(session_ !== undefined ? { session: session_ } : {}), display: { bounds: d.bounds, workArea: d.workArea, notch: null } };
}

/** The displays changed: each surface's part hears its environment as it is now. */
function tellSurfaces(): void {
  for (const s of surfaces.values()) {
    if (s.win.isDestroyed()) continue;
    const environment = surfaceEnvironment(s.win.id);
    if (environment !== undefined) runtime.surfaceMessage(s.win.id, { type: "surface-environment", environment });
  }
}

/** Clicks pass through the surface outside its regions: while it shows with regions, the cursor's place decides. */
function clickThrough(s: Surface): void {
  clearInterval(s.poll);
  s.poll = undefined;
  if (s.win.isDestroyed() || !s.win.isVisible() || s.regions.length === 0) {
    if (!s.win.isDestroyed()) s.win.setIgnoreMouseEvents(false);
    return;
  }
  let ignoring: boolean | undefined;
  const tick = () => {
    if (s.win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const b = s.win.getBounds();
    const over = inRegions({ x: c.x - b.x, y: c.y - b.y }, s.regions);
    if (ignoring !== !over) {
      ignoring = !over;
      s.win.setIgnoreMouseEvents(ignoring, { forward: true });
    }
  };
  tick();
  s.poll = setInterval(tick, 50);
}

/** The menu broker's gate: menus open only right after the user's click or key press in that window, one at a time. */
const menus = new MenuGate();

/** Ruling R9: a window that stays unresponsive restarts the app into safe mode. */
const hangs = new HangWatch((windowId) => {
  log(`window ${windowId} stayed unresponsive: restarting in safe mode`);
  void restart(true);
});

/** Where each native view goes (ruling R8: the place the person used last), as the Clover Browser's `setView`. */
const views = new ViewFrames((name, target) => {
  if (browser === undefined) return;
  const win = target === undefined ? null : BrowserWindow.fromId(target.windowId);
  browser.setView(name, win === null || win.isDestroyed() ? undefined : { window: win, bounds: target!.bounds });
});

/** The Clover Browser in this process (lane L, spec §12.1): made once the app is ready; what it reports goes to the
 *  daemon over the pair. */
function startBrowser(): void {
  const send = (method: string, params: unknown) => {
    const c = pair?.client;
    if (c !== undefined) void c.request(method, params).catch((err) => log(`browser: ${method} failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  browser = createBrowserHost({
    computer: hostname().replace(/\.local$/, ""),
    report: (events) => send("browser.report", { events }),
    hold: (id, held) => send("browser.hold", { id, held }),
    assets: { preload: join(here, "..", "..", BROWSER_ASSETS.preload.out), html: join(here, "..", "..", BROWSER_ASSETS.html.out) },
  });
  void browser.start().catch((err) => log(`browser: start failed: ${err instanceof Error ? err.message : String(err)}`));
}

function browserHost(): BrowserHost {
  if (browser === undefined) throw new Error("the browser isn't started");
  return browser;
}

/** What the app watches in each of its own windows: the input the menu gate counts, hangs (R9), and the native views
 *  placed in it. (The guards come from `web-contents-created`.) */
function watchWindow(win: BrowserWindow): void {
  const id = win.id;
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" || input.type === "rawKeyDown") menus.input(id);
  });
  win.webContents.on("unresponsive", () => hangs.unresponsive(id));
  win.webContents.on("responsive", () => hangs.responsive(id));
  win.on("closed", () => {
    menus.forget(id);
    hangs.responsive(id);
    views.dropWindow(id);
  });
}

/** The menu broker's last step: a native menu at the point, in the window the asking frame is in. A headless run
 *  never shows it: it answers with `CLOVER_TEST_MENU_PICK` (the tests), else nothing. */
async function popupMenu(windowId: number, items: MenuItem[], point: { x: number; y: number }): Promise<string | null> {
  const win = BrowserWindow.fromId(windowId);
  if (win === null || win.isDestroyed()) return null;
  const gate = menus.take(windowId);
  if (!gate.ok) {
    log(`menu: refused (${gate.reason})`);
    throw new LayerError(gate.reason);
  }
  try {
    if (headless || !win.isVisible()) {
      log(`menu: ${items.length} item(s) at ${point.x},${point.y} (not shown: headless)`);
      return process.env.CLOVER_TEST_MENU_PICK ?? null;
    }
    return await nativeMenu(win, items, point);
  } finally {
    menus.done();
  }
}

function nativeMenu(win: BrowserWindow, items: MenuItem[], point: { x: number; y: number }): Promise<string | null> {
  return new Promise((resolve) => {
    let picked: string | null = null;
    const build = (list: MenuItem[]): MenuItemConstructorOptions[] => list.map((it) => (it.type === "separator"
      ? { type: "separator" }
      : {
        label: it.label ?? "",
        enabled: it.enabled !== false,
        ...(it.type === "checkbox" ? { type: "checkbox" as const, checked: it.checked === true } : {}),
        ...(it.submenu !== undefined ? { submenu: build(it.submenu) } : { click: () => (picked = it.id ?? null) }),
      }));
    Menu.buildFromTemplate(build(items)).popup({ window: win, x: point.x, y: point.y, callback: () => setTimeout(() => resolve(picked), 0) });
  });
}

/** The app's shortcuts, ahead of every layer (`shortcuts.ts`). */
function shortcut(event: Electron.Event, input: Input, win: BrowserWindow): void {
  const which = appShortcut(input, process.platform);
  if (which === undefined) return;
  event.preventDefault();
  if (which === "quit") void requestQuit("shortcut");
  else if (which === "close-window") win.close();
  else runtime.command(win.id, "open-settings");
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
        { label: "Settings…", accelerator: "Command+,", click: () => void show({ kind: "settings" }) },
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
    rendered: !!document.getElementById("clover-root")?.firstElementChild,
    accent: getComputedStyle(document.documentElement).getPropertyValue("--clover-color-accent").trim(),
    insetTop: getComputedStyle(document.documentElement).getPropertyValue("--clover-frame-inset-top").trim(),
    text: (document.body.innerText || "").slice(0, 200),
  }))()`;
  type Probe = { origin: string; node: boolean; bridge: string; shell: boolean; sidebar: boolean; conversation: boolean; composer: boolean; frames: number; rendered: boolean; accent: string; insetTop: string; text: string };
  type Probed = Probe & { url: string; osPid: number };
  const probeWindow = async (w: BrowserWindow): Promise<Probed[]> => {
    const out: Probed[] = [];
    for (const f of w.webContents.mainFrame.framesInSubtree) {
      try {
        out.push({ ...(await f.executeJavaScript(probe, true) as Probe), url: f.url.replace(/mount=[0-9a-f]+/, "mount=…"), osPid: f.osProcessId });
      } catch {
        // A frame still loading.
      }
    }
    return out;
  };
  let frames: Probed[] = [];
  let surfaceFacts: { id: string; visible: boolean; bounds: Rect; frames: Probed[] }[] = [];
  // Texts the run waits for, all of them (`|` between).
  const waitTexts = (process.env.CLOVER_SMOKE_WAIT_TEXT ?? "").split("|").filter((t) => t !== "");
  while (Date.now() < deadline) {
    frames = await probeWindow(win);
    surfaceFacts = [];
    for (const [id, s] of surfaces) if (!s.win.isDestroyed()) surfaceFacts.push({ id, visible: s.win.isVisible(), bounds: s.win.getBounds(), frames: await probeWindow(s.win) });
    const shell = frames.find((f) => f.origin === "clover-plugin://clover");
    const wanted = Number(process.env.CLOVER_SMOKE_LAYERS ?? "0");
    const layers = frames.filter((f) => f.origin.startsWith("clover-plugin://"));
    const others = new Set(layers.filter((f) => f.origin !== "clover-plugin://clover").map((f) => f.origin));
    const texts = [...frames, ...surfaceFacts.flatMap((x) => x.frames)].map((f) => f.text);
    const drawn = shell?.shell === true && shell.composer && others.size >= wanted && layers.every((f) => f.rendered);
    // Every layer's part has drawn, as many other layers as the run expects are there, and any text it waits for.
    if (drawn && waitTexts.every((w) => texts.some((t) => t.includes(w)))) break;
    // The UI test's user: once everything has drawn (so a part asking for a menu before has been refused), a Shift
    // press in each window, which the menu gate counts as the user's input.
    if (drawn && process.env.CLOVER_SMOKE_INPUT === "1") {
      for (const w of [win, ...[...surfaces.values()].map((x) => x.win)]) {
        if (w.isDestroyed()) continue;
        w.webContents.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
        w.webContents.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  // Time for what the parts set going to happen (the DNS probe's lookups).
  const settle = Number(process.env.CLOVER_SMOKE_SETTLE_MS ?? "0");
  if (settle > 0) await new Promise((r) => setTimeout(r, Math.min(settle, 10_000)));
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
    surfaces: surfaceFacts,
    captured,
  });
  if (process.env.CLOVER_SMOKE_KEEP === "1") return;
  await requestQuit("smoke");
}
