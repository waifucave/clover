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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname, release as osRelease } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, Notification, clipboard, dialog, nativeTheme, powerMonitor, safeStorage, screen, session, shell, systemPreferences, webFrameMain, type Input, type MenuItemConstructorOptions } from "electron";
import { APP_METHODS, BROWSER_METHODS, CLOVER_PROTOCOL_VERSION, CORE_EVENT_NOTIFICATION, CardRequestedEvent, CardResolvedEvent, PairStatus, UiSettings, UiSettingsChangedEvent } from "@waifucave/clover-protocol";
import { systemAccentFromOs } from "@waifucave/clover-plugin-sdk";
import { BROWSER_ASSETS, createBrowserHost, isBrowserContents, type BrowserHost } from "./browser/index";
import { housingFor, loadScreens } from "./housing";
import { HANG_COMPOSITOR_MS, HANG_PING_MS, HangWatch, hangVerdict, type PingResult } from "./hang";
import { appIdentity, daemonHome, parseLaunchArgs, resolveAppProfile, SMOKE_PREFIX, UI_PARTITION } from "./identity";
import { cliLauncher, locateDaemonBinary } from "./pair/login";
import { Pair, type PairState } from "./pair/pair";
import { quitQuestion, type QuitChoice } from "./pair/quit";
import { appHello, devOverridesAllowed, pairEnv, readAppToken, readStartInfo } from "./pair/start";
import { daemonEndpoint, dial as dialDaemon, type DaemonClient } from "./protocol/client";
import { anyReady, listProviders, pageCall, type CorePage } from "./core-pages";
import { AnswerKey, memoryVault, safeStorageVault } from "./answer-key";
import { LayerLinks } from "./layer-links";
import { KeyLog, PasteModes, keyBytes, preparePaste } from "./terminal-input";
import { SealedFrames } from "./sealed";
import { ownCardPage } from "./sealed-pages";
import { translate } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { Notifications } from "./notify";
import { appShortcut, sealedInputAllowed } from "./shortcuts";
import { InstallGate, installKindOf, startUpdater, writeInstallMarker, type Updater } from "./updater";
import { AppTray } from "./tray";
import { readUiPlugins, type UiPluginExtras } from "./ui/model";
import { CLICK_THROUGH_POLL_MS, ClickThrough, MenuGate, SendGate, sendImages, sendTarget, PointerLog, ViewFrames, checkRegions, mayOpen, surfaceBounds, surfaceMayFloat, surfacePlacement, surfaceSize, type MenuItem, type Rect } from "./ui/brokers";
import type { OpenTarget, SurfaceEnvironment } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { guardContents, hardenSession, installIpc, installUiSession, registerSchemes, startCensus } from "./ui/electron";
import { LayerError, UiRuntime } from "./ui/runtime";
import { WebViews, isWebViewContents, webSpec } from "./ui/web-views";
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
let updater: Updater | undefined;
/** When a downloaded update installs (updater.ts): at the daemon's first idle moment, or at the user's Quit. */
const installs = new InstallGate({
  status: async () => {
    const r = await pair?.client?.request<{ idle?: unknown; busy?: unknown }>("update.status", {}, 5_000);
    return typeof r?.idle === "boolean" ? { idle: r.idle, busy: Array.isArray(r.busy) ? r.busy.map(String) : [] } : undefined;
  },
  apply: async () => {
    const r = await pair?.client?.request<{ at?: unknown }>("update.apply", {}, 15_000);
    return r?.at === "now" || r?.at === "when-idle" ? r.at : undefined;
  },
  exiting: () => pair.exiting("update"),
  stopApp: () => leaveApp(),
  daemonGone: () => daemonGone(15_000),
  install: (relaunch) => updater?.install(relaunch) ?? false,
  // The app's side is down and no install came: start again (the pair comes back with it), or end a Quit with an error.
  recover: (relaunch, why) => {
    log(`updater: ${why}; ${relaunch ? "starting again" : "quitting"}`);
    if (relaunch) app.relaunch();
    app.exit(relaunch ? 0 : 1);
  },
  after: (ms, fn) => { setTimeout(fn, ms); },
  every: (ms, fn) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
  log: (line) => log(line),
});

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
    // Web page entries' views keep to their own origin instead (web-views.ts).
    if (!isBrowserContents(contents) && !isWebViewContents(contents)) guardContents(contents, log);
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
  // A laptop suspends: the lease goes without leaving, so the bots are taken while this computer sleeps (§6.4,
  // lane H's ask). The daemon decides who takes them; on a wake this machine takes them back itself.
  powerMonitor.on("suspend", () => {
    if (!shuttingDown) void pair?.handOver().then((took) => log(`pair: main.handOver at suspend: ${took ? "ok" : "no"}`));
  });
  await hardenSession(session.defaultSession, log);
  const ui = session.fromPartition(UI_PARTITION);
  await hardenSession(ui, log);

  runtime = new UiRuntime({
    os, platform: process.platform, safeMode, log,
    sealed,
    onGone: (mount) => {
      views.drop(mount);
      webViews.drop(mount);
    },
    systemLanguage: app.getPreferredSystemLanguages()[0] ?? app.getLocale(),
  });
  // The UI test's positive control for the DNS probe: never in a packaged app.
  const unguarded = !app.isPackaged && headless ? (process.env.CLOVER_TEST_UNGUARDED_LAYERS ?? "").split(",").filter((l) => l !== "") : [];
  installUiSession(ui, runtime, dirs, log, { unguardedLayers: new Set(unguarded) });
  installIpc(runtime, {
    frameMetrics: (id, m) => runtime.setFrameMetrics(id, m),
    rootCommand: (_id, name) => {
      if (name === "restart-normally") void restart(false);
      if (name === "restart-safe-mode") void restart(true);
    },
    rootCall: (_id, name, params) => pageCall(name, params, pageDeps),
    surface: (id, request) => steerSurface(id, request),
    surfaceEnvironment: (id) => surfaceEnvironment(id),
    open: (pluginId, target) => openFor(pluginId, target),
    // A part's word that the person used its view counts only after main saw their mouse-down there.
    viewFrame: (windowId, mount, name, bounds, used) => views.report(name, mount, windowId, bounds, used && bounds !== undefined && pointers.pressedIn(windowId, bounds)),
    menu: (id, items, point) => popupMenu(id, items, point),
    api: (pluginId, method, params) => layerLinks.call(pluginId, method, params),
    terminalInput: (windowId, frameId, pluginId, terminalId, input) => terminalInput(windowId, frameId, pluginId, terminalId, input),
    // The sealed path (E-M3): the frame's own channel; the click's are the frame's own gates (IOv2, the trusted press,
    // the hour it stood visible), and here the app signs with the answer key over the card's id and hash and takes the
    // core's answer. The computer-use gate runs here in the main process, on both this button path and the fallback
    // (B3): fail closed — anything the core can't answer about it, the answer is refused.
    sealedAnswer: async (token, option, senderKey, children) => {
      const key = answerKeyValue;
      if (key === undefined) { log(`sealed: answer refused (no answer key)`); return { accepted: false, reason: "the answer key isn't there" }; }
      const client = pair.client;
      if (client === undefined) { log(`sealed: answer refused (no client)`); return { accepted: false, reason: "Clover isn't running" }; }
      // The gate first, before anything else moves: any computer use driving this desktop's computer, no.
      const acting = await client.request<{ running?: boolean }>("computer.acting", {}, 3_000).catch(() => undefined);
      if (acting === undefined) { log(`sealed: answer refused (computer-use check failed)`); return { accepted: false, reason: "the computer-use check couldn't run" }; }
      if (acting.running === true) { log(`sealed: answer refused (computer use acting)`); return { accepted: false, reason: "computer use is acting right now" }; }
      const option_ = option ?? sealed.optionOf(token);
      if (option_ === undefined) { log(`sealed: answer refused (no option)`); return { accepted: false, reason: "no option named" }; }
      const out = sealed.buildAnswer(token, option_, children, senderKey, key, signedDevice ?? "");
      if ("error" in out) { log(`sealed: answer refused (${out.error})`); return { accepted: false, reason: out.error }; }
      disarmFallback(out.card.id); // a part's own button answered first: the fallback's timer is gone.
      const r = await client.request<{ accepted: boolean; reason?: string }>("card.answer", { id: out.card.id, hash: out.card.hash, option: option_, proof: out.proof, ...(children !== undefined ? { children } : {}) }, 15_000).catch((err: unknown) => ({ accepted: false, reason: err instanceof Error ? err.message.slice(0, 200) : "refused" }));
      if (r.accepted !== true) { sealed.confirmedAnswer(out.card.id, false); log(`sealed: core refused answer (${typeof r.reason === "string" ? r.reason.slice(0, 120) : "no reason"})`); return { accepted: false, ...(typeof r.reason === "string" ? { reason: r.reason.slice(0, 200) } : {}) }; }
      sealed.confirmedAnswer(out.card.id, true);
      log(`sealed: answer accepted for ${out.card.id}`);
      return { accepted: true };
    },
    // A sealed frame's page reports its own visibility (IOv2). When a card's approve and deny buttons both show,
    // the fallback's timer is disarmed (§5.5: only show the fallback when no plugin has both buttons visible within
    // 2 s). When either stops being visible, the timer starts again.
    sealedVisible: (token: string, visible: boolean) => {
      sealed.markVisible(token, visible === true);
      const cardId = sealed.cardOf(token);
      if (cardId === undefined) return;
      if (visible === true) {
        if (sealed.buttonsVisible(cardId)) disarmFallback(cardId);
      } else {
        const own = fallbacks.get(cardId);
        if (own?.win === undefined || (own.win !== undefined && own.win.isDestroyed())) {
          if (sealed.get(cardId) !== undefined) void armFallback(cardId);
        }
      }
    },
    userSend: async (windowId, to, message) => {
      // One key press or click the main process saw come to the window covers one send (§5.5).
      if (!sends.take(windowId)) throw new LayerError("the user's words go only right after their own key press or click");
      const target = sendTarget(to);
      if (target === undefined) throw new LayerError("not a place the user's words go");
      const images = sendImages(message.images);
      if ("error" in images) throw new LayerError(images.error);
      const client = pair.client;
      if (client === undefined) throw new LayerError("Clover isn't running");
      return client.request<{ seq?: number }>("pill.send", { to: target, text: message.text, ...(images.length > 0 ? { images } : {}), clientMessageId: randomUUID() }, 30_000);
    },
    activeSession: (windowId, session) => {
      activeSessions.set(windowId, session);
    },
    webFrame: (windowId, mount, web, bounds) => {
      const spec = webSpec(web.web);
      if (spec === undefined) {
        log(`web: ${web.plugin.id}'s page isn't one the app shows (a URL or a page in its folder, and a partition)`);
        return;
      }
      void webViews.place(windowId, mount, web.plugin, spec, bounds).catch((err) => log(`web: ${err instanceof Error ? err.message : String(err)}`));
    },
  }, log);
  startCensus(runtime);
  syncAppearance();
  nativeTheme.on("updated", syncAppearance);
  if (process.platform === "win32") systemPreferences.on("accent-color-changed", syncAppearance);

  for (const e of ["display-metrics-changed", "display-added", "display-removed"] as const) screen.on(e as "display-added", () => tellSurfaces());
  startBrowser();
  pair = makePair();
  setMenu();
  // The install marker: this home's daemon is the app's (or a package's), so it never updates itself (updater.ts).
  if (app.isPackaged) writeInstallMarker(home, installKindOf(process.platform, process.env), log);
  if (!headless) {
    // The app's own updates (updater.ts): packaged builds only, never a headless or test run (no network from those).
    void startUpdater({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      log,
      onReady: (version) => {
        const t = (key: string) => translate(runtime.coreStrings(), `clover.core.update.ready.${key}`, { version });
        new Notification({ title: t("title"), body: t("body") }).show();
        void installs.downloaded(version);
      },
    }).then((u) => { updater = u; }).catch((err: unknown) => log(`updater: ${err instanceof Error ? err.message : String(err)}`));
    tray = new AppTray(join(here, "tray.png"), { open: () => void openMainWindow(), quit: () => void requestQuit("tray"), restart: (s) => void restart(s), managePlugins: () => void openPage("plugins") }, log);
    tray.show({ safeMode, strings: runtime.coreStrings() });
  }
  // A start by the user opens the window; a start by the daemon or at login doesn't. A headless run opens it hidden.
  if (start.by === "user" || headless) void openMainWindow();
  await pair.start();
  if (args.smoke) await smoke();
}

// ------------------------------------------------------------------------------------------------
// The pair
// ------------------------------------------------------------------------------------------------

// The sealed frames' store (spec §5.5; E-M3): cards in through the app's role events, frame channels and answers out,
// signed by the answer key. The store holds them; the sealed scheme serves the frames; nothing logs the fields.
const sealed = new SealedFrames();
let signedDevice: string | undefined;
// The app's own fallback card (§5.5): whose 2-second timers run, which window stands before the user, and the card's
// own page answers on its own channel.
const fallbacks = new Map<string, { timer: ReturnType<typeof setTimeout>; win?: Electron.BrowserWindow; token?: string }>();
const FALLBACK_DELAY_MS = 2_000;

/** A card's own 2-second timer: once it runs, the app's own card page stands before the user (shown, never brought in
 *  front). A part's own button disarms its card's: its own `sealedAnswer` burns the store's channel and calls here. */
async function armFallback(cardId: string): Promise<void> {
  disarmFallback(cardId);
  const timer = setTimeout(() => void showFallbackCard(cardId), FALLBACK_DELAY_MS);
  timer.unref?.();
  fallbacks.set(cardId, { timer });
}

function disarmFallback(cardId: string): void {
  const own = fallbacks.get(cardId);
  if (own === undefined) return;
  clearTimeout(own.timer);
  if (own.win !== undefined && !own.win.isDestroyed()) own.win.close();
  fallbacks.delete(cardId);
}

/** The app's own card page: the whole card, its fields and buttons, from the app's own scheme (its own single-use
 *  channel), shown without taking the focus (the user's own app in front stays). */
async function showFallbackCard(cardId: string): Promise<void> {
  const card = sealed.get(cardId);
  if (card === undefined) return;
  const mint = sealed.mint(cardId, "own");
  if (mint === undefined) return;
  const url = `clover-sealed://card/${encodeURIComponent(cardId)}/own?token=${encodeURIComponent(mint.token)}`;
  const plan = mainWindowPlan({
    platform: process.platform,
    acrylic: false,
    title: "Clover",
    dark: nativeTheme.shouldUseDarkColors,
    solid: nativeTheme.shouldUseDarkColors ? "#202020" : "#FFFFFF",
    symbol: nativeTheme.shouldUseDarkColors ? "#F2F2F2" : "#1F1F1F",
    webPreferences: webPreferences({ preload: join(here, "preload.cjs"), partition: UI_PARTITION, headless, offscreen: false }),
  });
  const win = new BrowserWindow({ ...plan.options, width: 460, height: 360, useContentSize: true, skipTaskbar: true });
  watchWindow(win);
  win.on("closed", () => {
    const own = fallbacks.get(cardId);
    if (own?.win === win) fallbacks.delete(cardId);
  });
  // Keep the fallback away from the cursor so a plugin can't time a click onto it (S3, check 3): place it within
  // the cursor's display's work area before showing it, never after, so it never appears first in its default place.
  try {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const area = display.workArea;
    const bounds = win.getBounds();
    const awayX = cursor.x < area.x + area.width / 2 ? area.x + area.width - bounds.width - 16 : area.x + 16;
    const awayY = Math.min(Math.max(cursor.y - bounds.height - 32, area.y + 16), area.y + area.height - bounds.height - 16);
    const placedX = Math.min(Math.max(awayX, area.x), area.x + Math.max(0, area.width - bounds.width));
    const placedY = Math.min(Math.max(awayY, area.y), area.y + Math.max(0, area.height - bounds.height));
    win.setBounds({ x: Math.round(placedX), y: Math.round(placedY), width: bounds.width, height: bounds.height });
  } catch { /* best effort */ }
  // Bind the fallback's channel to its window's main frame once the page loads (B3): a plugin can't guess the
  // window's frame ids, and a frame from another window can't answer with this token.
  win.loadURL(url).then(() => {
    if (win.isDestroyed()) return;
    const main = win.webContents.mainFrame;
    sealed.bindChannel(mint.token, `m:${main.processId}:${main.routingId}`);
    if (!win.isDestroyed()) win.showInactive();
  }).catch(() => win.close());
  const own = fallbacks.get(cardId);
  if (own !== undefined) { own.win = win; own.token = mint.token; }
}

function makePair(): Pair {
  const binary = locateDaemonBinary({ env, packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const p = new Pair({
    endpoint: daemonEndpoint(home),
    hello: () => {
      const token = readAppToken(home, env);
      return token === undefined ? undefined : appHello(token, app.getVersion(), CLOVER_PROTOCOL_VERSION);
    },
    ...(binary !== undefined ? { launcher: cliLauncher({ binary, home, profile: identity.profile }) } : {}),
    // The token goes only to this user's own daemon, which proves it holds it (lane C's protocol.prove): on Windows a
    // pipe's name is in a namespace every user shares.
    prove: { pid: process.pid },
    log,
    onConnected: (client, hello) => {
      // This desktop's answer key, registered on every connection (lane H's `device.answerKey.set`).
      void answerKey().register(client, hello.device);
      signedDevice = hello.device;
      // The pending cards, and their outcomes as they come: the store's own copy of the sealed ones, and the
      // fallback's 2-second timers arm on each (a part's own button disarms its card's before the core's fires).
      void client.request<unknown>("card.list").catch(() => undefined).then((r) => {
        for (const c of (r as { cards?: unknown[] })?.cards ?? []) { sealed.fromCore(c); armFallback(String((c as { id?: unknown }).id ?? "")); }
      });
      return loadRegistry(client);
    },
    onState: (s) => stateChanged(s),
    onDaemonQuit: (reason) => {
      log(`the daemon asked the app to quit (${reason})`);
      exitApp();
    },
  });
  // The Clover Browser (lane L): the daemon drives its tabs over the pair. The protocol's tab owner names a plugin by
  // its `plugin` field, as the browser host's own contract does (lane L's `contract.ts`), so it passes through as is.
  p.handle("app.tab.open", async (params) => {
    const a = BROWSER_METHODS.appTabOpen.params.parse(params);
    return { tab: await browserHost().open({ id: a.id, owner: a.owner, ...(a.url !== undefined ? { url: a.url } : {}), place: a.place }) };
  });
  p.handle("app.tab.command", async (params) => {
    const a = BROWSER_METHODS.appTabCommand.params.parse(params);
    return { result: await browserHost().command(a.id, a.command) };
  });
  p.handle("app.tab.list", () => ({ tabs: browserHost().list() }));
  // The heartbeat (ruling R9): answered at once, from the main process, so a hung app goes unanswered.
  p.handle("app.ping", () => ({ ok: true }));
  // Desktop notifications for the bundled notifier (lane G): shown unless the app is in front showing that session.
  p.handle("app.notify", (params) => {
    const raw = (params ?? {}) as Record<string, unknown>;
    const parsed = APP_METHODS.appNotify.params.safeParse(raw);
    if (!parsed.success) throw new Error("app.notify needs an id and a title");
    const r = notifications.notify({ ...parsed.data, ...(raw.urgent === true ? { urgent: true } : {}) }, front());
    return { ok: true, ...r };
  });
  p.handle("app.notify.close", (params) => {
    const id = (params as { id?: unknown } | undefined)?.id;
    notifications.close(typeof id === "string" ? id : undefined);
    return { ok: true };
  });
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
    if (type === "card_requested") {
      const parsed = CardRequestedEvent.safeParse(params);
      if (parsed.success) {
        sealed.fromCore(parsed.data.card);
        armFallback(parsed.data.card.id);
      } else log("pair: ignored a card_requested event that isn't one");
    }
    if (type === "card_resolved") {
      const parsed = CardResolvedEvent.safeParse(params);
      if (parsed.success) {
        sealed.resolvedOutcome(parsed.data.id, parsed.data.outcome);
        disarmFallback(parsed.data.id);
      }
    }
    // The app's role sees the cards whole; the store's own copy feeds the sealed frames and the fallback. A card_pending
    // goes only to layers; the app hears card_requested. Nothing else here.
  });
  return p;
}

/** The answer key (a headless run's in memory: it never touches the OS's store) and the no-prompt rule's limits: an
 *  unpackaged app keeps it in memory alone (S4: no Keychain or keyring dialog from a dev build), and a Linux whose
 *  safeStorage would fall back to `basic_text` — no secret store at all — keeps it in memory, said once (S3). */
let answerKeyValue: AnswerKey | undefined;
function answerKey(): AnswerKey {
  if (answerKeyValue === undefined) {
    if (headless || !app.isPackaged) answerKeyValue = new AnswerKey(memoryVault("none"), log);
    else if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
      log("answer key: this computer's secret store is plain text (no Secret Service); the key stays in memory");
      answerKeyValue = new AnswerKey(memoryVault("none"), log);
    } else answerKeyValue = new AnswerKey(safeStorageVault(join(app.getPath("userData"), "answer-key"), safeStorage), log);
  }
  return answerKeyValue;
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
  void maybeWelcome(client);
}

// ------------------------------------------------------------------------------------------------
// The core's own pages in the main window's root: the welcome setup guide and safe mode's plugin manager (§5.8)
// ------------------------------------------------------------------------------------------------

let corePage: CorePage | null = null;
const welcomeFlag = () => join(app.getPath("userData"), "welcome-done");

const pageDeps = {
  client: () => pair?.client,
  lang: () => runtime.language,
  openExternal: async (url: string) => {
    // A headless run opens nothing on the screen.
    if (headless) log(`open: would open a page in the browser (${new URL(url).host})`);
    else await shell.openExternal(url);
  },
  welcomeDone: () => {
    try {
      mkdirSync(dirname(welcomeFlag()), { recursive: true });
      writeFileSync(welcomeFlag(), `${new Date().toISOString()}\n`);
    } catch (err) {
      log(`welcome: couldn't note it's done: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
  page: () => corePage,
  closePage: () => {
    corePage = null;
  },
};

/** Shows one of the core's pages in the main window (opening it if need be). */
async function openPage(page: CorePage): Promise<void> {
  corePage = page;
  const win = await openMainWindow();
  if (win !== undefined) runtime.rootMessage(win.id, { type: "core-page", page });
}

/** The welcome guide opens by itself on a start with no model provider signed in, until it is done or skipped. */
async function maybeWelcome(client: DaemonClient): Promise<void> {
  if (runtime.safeMode || corePage !== null || existsSync(welcomeFlag())) return;
  try {
    const providers = await listProviders(client, runtime.language);
    if (anyReady(providers)) return;
  } catch {
    // A daemon that can't list them (an older one, the fake): no guide.
    return;
  }
  log("welcome: no model provider is signed in; the guide opens");
  await openPage("welcome");
}

function stateChanged(s: PairState): void {
  // The layers' connections go with the pair's; each opens again on its plugin's next call.
  if (s.kind !== "connected") layerLinks.closeAll();
  log(`pair: ${s.kind}${s.kind === "unavailable" ? ` (${s.reason})` : ""}`);
  const status = s.kind === "reconnecting" ? "Reconnecting to Clover…" : s.kind === "unavailable" ? "Clover isn't running" : s.kind === "starting-daemon" ? "Starting Clover…" : s.kind === "unverified" ? "Can't verify the Clover daemon" : undefined;
  tray?.show({ safeMode: runtime.safeMode, strings: runtime.coreStrings(), ...(status !== undefined ? { status } : {}) });
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
  // With an update downloaded, the Quit installs it (the pair has stopped: nothing runs), without starting the app again.
  if (await installs.quitting()) return;
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
  leaveApp();
  app.exit(0);
}

/** Everything of leaving but the exit itself (an update's install quits the app its own way). */
function leaveApp(): void {
  leaving = true;
  installs.stop();
  updater?.stop();
  try {
    browser?.shutdown();
  } catch (err) {
    log(`browser: shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  pair?.stop();
  tray?.destroy();
  tray = undefined;
}

/** Resolves once the daemon's endpoint stops answering (it stopped with the pair), or after `maxMs`. */
async function daemonGone(maxMs: number): Promise<void> {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const c = await dialDaemon(daemonEndpoint(home), 500);
    if (c === undefined) return;
    c.close();
    await new Promise((r) => setTimeout(r, 250));
  }
  log(`updater: the daemon was still answering after ${maxMs} ms; installing anyway`);
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
  clicks: ClickThrough;
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
    const s: Surface = {
      win, ref: w.ref, pluginId: w.pluginId, regions: [], ...(placement !== undefined ? { placement } : {}),
      // macOS and Windows forward the cursor's moves to a window that ignores the mouse (`forward`).
      clicks: new ClickThrough((ignore) => {
        if (!win.isDestroyed()) win.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
      }),
    };
    // Where the OS forwards them, the cursor's moves decide click-through: no timer.
    win.webContents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseMove" || mouse.type === "mouseEnter") s.clicks.move({ x: mouse.x, y: mouse.y });
      else if (mouse.type === "mouseLeave") s.clicks.move(undefined);
    });
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

/** The screen add-on (macOS), for the camera housing; undefined where there is none. */
let screens: ReturnType<typeof loadScreens> | null = null;

/** A surface window's environment: the OS, the display server, its display (the primary one, where surfaces sit), and
 *  the camera housing, which the screen add-on reads (null where there is none). */
function surfaceEnvironment(windowId: number): SurfaceEnvironment | undefined {
  if (![...surfaces.values()].some((s) => !s.win.isDestroyed() && s.win.id === windowId)) return undefined;
  const d = screen.getPrimaryDisplay();
  if (screens === null) screens = loadScreens(join(here, "native", "screen.node"), log);
  return { os, ...(session_ !== undefined ? { session: session_ } : {}), display: { bounds: d.bounds, workArea: d.workArea, notch: housingFor(d.id, screens) } };
}

/** The displays changed: each surface's part hears its environment as it is now. */
function tellSurfaces(): void {
  for (const s of surfaces.values()) {
    if (s.win.isDestroyed()) continue;
    const environment = surfaceEnvironment(s.win.id);
    if (environment !== undefined) runtime.surfaceMessage(s.win.id, { type: "surface-environment", environment });
  }
}

/** Clicks pass through the surface outside its regions (ClickThrough): the cursor's moves decide on macOS and Windows,
 *  which forward them to a window that ignores the mouse; Linux, which doesn't, reads the cursor's place now and then. */
function clickThrough(s: Surface): void {
  clearInterval(s.poll);
  s.poll = undefined;
  if (s.win.isDestroyed()) return;
  const cursor = () => {
    const c = screen.getCursorScreenPoint();
    const b = s.win.getBounds();
    const at = { x: c.x - b.x, y: c.y - b.y };
    return at.x >= 0 && at.y >= 0 && at.x < b.width && at.y < b.height ? at : undefined;
  };
  s.clicks.set(s.regions, s.win.isVisible(), cursor());
  if (process.platform === "linux" && s.clicks.active) {
    s.poll = setInterval(() => {
      if (!s.win.isDestroyed()) s.clicks.move(cursor());
    }, CLICK_THROUGH_POLL_MS);
  }
}

/** The menu broker's gate: menus open only right after the user's click or key press in that window, one at a time. */
const menus = new MenuGate();

/** Each plugin layer's own connection to the core (its plugin API). */
const layerLinks = new LayerLinks({
  appClient: () => pair?.client,
  dial: () => dialDaemon(daemonEndpoint(home)),
  appToken: () => readAppToken(home, env),
  pid: process.pid,
  appVersion: app.getVersion(),
  onEvent: (pluginId, method, params) => {
    const e = params as { type?: unknown; terminalId?: unknown; data?: unknown; exited?: unknown } | undefined;
    if (method === CORE_EVENT_NOTIFICATION && e?.type === "terminal_output" && typeof e.terminalId === "string") {
      pasteModes.output(e.terminalId, typeof e.data === "string" ? e.data : "", e.exited !== undefined);
    }
    runtime.pluginMessage(pluginId, { type: "api-event", pluginId, method, params });
  },
  log,
});

/** The terminals' trusted input: each window's key presses as the main process saw them, and each terminal's paste
 *  mode from its output (terminal-input.ts). The record is per focused frame (the review's S2), and a frame's record
 *  goes with the frame: each WebContents recent frame ids are kept, so a navigation (the same frame, a new document)
 *  and a gone renderer both forget them, beside each entry's own second. */
const keys = new KeyLog();
const pasteModes = new PasteModes();
/** The frame ids a WebContents's own pages saw keys in, keyed by the window's id, for forgetting them whole. */
const keyFrames = new Map<number, Set<string>>();

async function terminalInput(windowId: number, frameId: string, pluginId: string, terminalId: string, input: { kind: "key"; key: string } | { kind: "paste" }): Promise<void> {
  if (input.kind === "key") {
    const seen = keys.take(frameId, input.key);
    if (seen === undefined) throw new LayerError("only a key press the app saw in this frame reaches a terminal");
    const data = keyBytes(seen, process.platform);
    if (data !== undefined) await layerLinks.hand(pluginId, "terminal.write", { terminalId, data });
    return;
  }
  // The paste door: the chord the app saw in this frame, the clipboard the app reads, bracketed when the program
  // asked, and the user's OK before more than one line goes.
  if (!keys.takePaste(frameId, process.platform)) throw new LayerError("only a paste the app saw in this frame reaches a terminal");
  const text = await clipboard.readText();
  if (text === "") return;
  const paste = preparePaste(text, pasteModes.bracketed(terminalId));
  if (paste.needsOk && !(await okToPaste(windowId, paste.lines))) {
    log("terminal: a paste of several lines was turned down");
    return;
  }
  await layerLinks.hand(pluginId, "terminal.write", { terminalId, data: paste.data, paste: true });
}

/** Asks before a paste of more than one line goes to a terminal (a headless run answers with CLOVER_TEST_PASTE_OK). */
async function okToPaste(windowId: number, lines: number): Promise<boolean> {
  if (headless) return process.env.CLOVER_TEST_PASTE_OK === "1";
  const t = (key: string, params?: Record<string, string | number>) => translate(runtime.coreStrings(), `clover.core.${key}`, params);
  const win = BrowserWindow.fromId(windowId);
  const options = { type: "question" as const, message: t("terminal.paste-title", { count: lines }), detail: t("terminal.paste-detail"), buttons: [t("terminal.paste"), t("terminal.cancel")], defaultId: 1, cancelId: 1, noLink: true };
  const r = win !== null && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return r.response === 0;
}

/** Sends counted as the user's: one key press or click per send (the user-send gate). */
const sends = new SendGate();

/** The person's mouse-downs, by window (the view-frame gate). */
const pointers = new PointerLog();

/** Ruling R9: a core root that stays unresponsive restarts the app into safe mode; so does a window that stays
 *  unresponsive while its documents answer, after a longer window (the smoke run's hang test may shorten it). */
const hangs = new HangWatch((windowId) => {
  log(`window ${windowId} stayed unresponsive: restarting in safe mode`);
  if (args.smoke && process.env.CLOVER_SMOKE_NO_RESTART === "1") {
    log("smoke: the restart is left out");
    return;
  }
  void restart(true);
});

/** A window went unresponsive: which of its documents? Each is pinged; a plugin layer that doesn't answer has its
 *  process killed (its parent then shows "This part stopped" with a reload), and only a core root that doesn't answer
 *  starts the countdown to a safe-mode restart. */
async function diagnoseHang(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  const docs = runtime.documents().filter((d) => d.windowId === win.id);
  const results: (PingResult & { mount: string; layer: string })[] = await Promise.all(docs.map(async (d) => {
    const f = webFrameMain.fromId(d.frame.processId, d.frame.routingId);
    const base = { kind: d.layer === "core" ? "root" as const : "layer" as const, mount: d.mount, layer: d.layer, ...(d.frame.osPid !== undefined ? { osPid: d.frame.osPid } : {}) };
    if (f === undefined || f === null || f.detached) return { ...base, answered: true };
    const answered = await Promise.race([
      f.executeJavaScript("0").then(() => true, () => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), HANG_PING_MS)),
    ]);
    return { ...base, answered };
  }));
  const verdict = hangVerdict(results, process.pid);
  const silent = results.filter((r) => !r.answered).map((r) => `${r.layer} (${r.mount})`);
  log(`window ${win.id} went unresponsive; not answering: ${silent.length === 0 ? "none" : silent.join(", ")}`);
  for (const pid of verdict.kill) {
    log(`layers: stopping a hung layer's process (${pid})`);
    try {
      process.kill(pid, "SIGKILL");
    } catch (err) {
      log(`layers: could not stop process ${pid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (verdict.restart) hangs.unresponsive(win.id);
  // Every document answers, yet the window doesn't (the GPU process or the compositor, or a hang killing a layer
  // didn't end): it gets the longer window to come back.
  else if (verdict.later) {
    log(`window ${win.id}: every document answers; it has ${Math.round(compositorMs / 1000)} s to come back`);
    hangs.unresponsive(win.id, compositorMs);
  }
}

/** The longer window; the smoke run's test of it shortens it (unpackaged runs only). */
const compositorMs = args.smoke && !app.isPackaged && Number(process.env.CLOVER_SMOKE_COMPOSITOR_MS ?? "0") > 0 ? Number(process.env.CLOVER_SMOKE_COMPOSITOR_MS) : HANG_COMPOSITOR_MS;

/** Where each native view goes (ruling R8: the place the person used last), as the Clover Browser's `setView`. */
const views = new ViewFrames((name, target) => {
  if (browser === undefined) return;
  const win = target === undefined ? null : BrowserWindow.fromId(target.windowId);
  browser.setView(name, win === null || win.isDestroyed() ? undefined : { window: win, bounds: target!.bounds });
});

/** The session each window shows, as its shell said (the notifications' "in front" check). */
const activeSessions = new Map<number, string | null>();

function front(): { focused: boolean; session?: string | null } {
  const w = BrowserWindow.getFocusedWindow();
  if (w === null || w.isDestroyed() || !w.isVisible()) return { focused: false };
  return { focused: true, session: activeSessions.get(w.id) ?? null };
}

const notifications = new Notifications((req, onClick) => {
  // A headless run shows nothing and plays nothing.
  if (headless || !Notification.isSupported()) {
    log(`notify: ${headless ? "a headless run shows no notification" : "this desktop has no notifications"} (${req.id})`);
    return undefined;
  }
  const n = new Notification({ title: req.title, ...(req.body !== undefined ? { body: req.body } : {}), ...(process.platform === "linux" && req.urgent === true ? { urgency: "critical" as const } : {}) });
  n.on("click", onClick);
  n.show();
  return n;
}, (session) => {
  void (async () => {
    const win = await openMainWindow();
    if (win !== undefined && session !== undefined) runtime.command(win.id, "open-session", { session });
  })();
});

/** Web page entries' views (§5.5 "Web pages"), each in its plugin's own session. */
const webViews = new WebViews((windowId) => {
  const w = BrowserWindow.fromId(windowId);
  return w === null || w.isDestroyed() ? undefined : w;
}, log);

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
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" || input.type === "rawKeyDown") {
      menus.input(id);
      sends.input(id);
      // The record is per focused frame (the review's S2), the frame the key came to: the part that hands it over
      // idents itself from that same frame. No focused frame records nothing.
      const f = win.webContents.focusedFrame;
      if (f === null || f.detached) return;
      const frameId = `${f.processId}:${f.routingId}`;
      let seen = keyFrames.get(id);
      if (seen === undefined) keyFrames.set(id, (seen = new Set()));
      seen.add(frameId);
      keys.saw(frameId, { key: input.key, code: input.code, control: input.control, alt: input.alt, shift: input.shift, meta: input.meta });
    }
  });
  win.webContents.on("before-mouse-event", (_event, mouse) => {
    if (mouse.type !== "mouseDown") return;
    menus.input(id);
    sends.input(id);
    pointers.down(id, mouse.x, mouse.y);
  });
  win.webContents.on("did-frame-navigate", (_event, _url, _code, _text, _main, frameProcessId, frameRoutingId) => {
    // A frame that navigated is a document of its own from now on (the review's S2): its old record must not serve it.
    keys.forget(`${frameProcessId}:${frameRoutingId}`);
  });
  win.webContents.on("render-process-gone", () => {
    // A renderer gone takes its frames' records with it; its new render starts empty.
    const gone = keyFrames.get(id);
    if (gone !== undefined) {
      for (const frameId of gone) keys.forget(frameId);
      keyFrames.delete(id);
    }
  });
  win.webContents.on("unresponsive", () => void diagnoseHang(win));
  win.webContents.on("responsive", () => hangs.responsive(id));
  win.on("closed", () => {
    menus.forget(id);
    sends.forget(id);
    pointers.forget(id);
    hangs.responsive(id);
    views.dropWindow(id);
    webViews.dropWindow(id);
    activeSessions.delete(id);
    keyFrames.delete(id);
    // The keys' and pastes' record is per frame and expires within a second anyway; the window's gone frames are
    // left to that.
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
  const deadline = Date.now() + Number(process.env.CLOVER_SMOKE_DEADLINE_MS ?? "45000");
  const win = await openMainWindow();
  if (win === undefined) return report({ ok: false, reason: "no window" });
  // A sealed run delivers real input into out-of-process frames: CDP input routes through the browser's compositor
  // hit-test, which a hidden window never produces (its views draw nothing to route by) — the press then lands
  // nowhere, or stops a frame early, depending on the platform. Showing the window inactive (never focusing it)
  // starts every frame compositing long before the press, so the router can target the sealed frame. Test-only like
  // the presses themselves; headless otherwise stays hidden, and under CI's virtual display no human screen is
  // touched.
  if ((process.env.CLOVER_SMOKE_SEALED_CLICK !== undefined || process.env.CLOVER_SMOKE_SEALED_FALLBACK === "1") && sealedInputAllowed({ packaged: app.isPackaged, headless }) && !win.isVisible()) {
    win.showInactive();
    log(`sealed-click: main window shown for input routing`);
  }
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
    sheets: document.querySelectorAll("style[data-clover-sheet]").length,
    themed: getComputedStyle(document.documentElement).textRendering,
    text: (document.body.innerText || "").slice(0, location.protocol === "clover-core:" ? 2000 : 200),
  }))()`;
  type Probe = { origin: string; node: boolean; bridge: string; shell: boolean; sidebar: boolean; conversation: boolean; composer: boolean; frames: number; rendered: boolean; accent: string; insetTop: string; sheets: number; themed: string; text: string };
  type Probed = Probe & { url: string; osPid: number };
  const probeWindow = async (w: BrowserWindow): Promise<Probed[]> => {
    const out: Probed[] = [];
    for (const f of w.webContents.mainFrame.framesInSubtree) {
      try {
        // A hung frame never answers: it is left out of this look.
        const facts = await Promise.race([f.executeJavaScript(probe, true) as Promise<Probe>, new Promise<undefined>((r) => setTimeout(() => r(undefined), 1_000))]);
        if (facts !== undefined) out.push({ ...facts, url: f.url.replace(/mount=[0-9a-f]+/, "mount=…"), osPid: f.osProcessId });
      } catch {
        // A frame still loading.
      }
    }
    return out;
  };
  let frames: Probed[] = [];
  let surfaceFacts: { id: string; visible: boolean; bounds: Rect; frames: Probed[] }[] = [];
  let sealedClicked = false;
  type WebFact = { mount: string; url: string; visible: boolean; text: string };
  let webFacts: WebFact[] = [];
  const probeWeb = async (): Promise<WebFact[]> => Promise.all(webViews.list().map(async (v) => {
    const text = await Promise.race([v.contents.executeJavaScript("document.body ? document.body.innerText : ''", true).then((t) => String(t), () => ""), new Promise<string>((r) => setTimeout(() => r(""), 1_000))]);
    // A page's text is readable before its URL is (the commit window): the URL comes a beat later, so wait for it.
    let url = v.url;
    const end = Date.now() + 2_000;
    while (url === "" && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
      url = v.contents.getURL();
    }
    return { mount: v.mount, url, visible: v.visible, text: text.slice(0, 200) };
  }));
  // Texts the run waits for, all of them (`|` between), and mounts it waits for (per kind, "kind:n" each, `,` between):
  // a part's frames are placed a beat after its document draws, so a test that counts mounts waits for its own counts.
  const waitTexts = (process.env.CLOVER_SMOKE_WAIT_TEXT ?? "").split("|").filter((t) => t !== "");
  const waitMounts = Object.fromEntries((process.env.CLOVER_SMOKE_WAIT_MOUNTS ?? "").split(",").filter((t) => t.includes(":")).map((t) => [t.slice(0, t.indexOf(":")), Number(t.slice(t.indexOf(":") + 1))])) as Partial<Record<"root" | "frame" | "inline" | "web", number>>;
  let hung = false;
  // The UI test's user on the core's own pages (unpackaged runs only): a page to open once everything has drawn, and
  // steps in the root, one a turn, each once its element is there (a click, a tick, text typed into a field).
  const smokePage = process.env.CLOVER_SMOKE_PAGE;
  let pageOpened = false;
  type Step = { click?: string; check?: string; fill?: string; value?: string };
  const steps: Step[] = !app.isPackaged ? (JSON.parse(process.env.CLOVER_SMOKE_ROOT_STEPS ?? "[]") as Step[]) : [];
  while (Date.now() < deadline) {
    frames = await probeWindow(win);
    surfaceFacts = [];
    for (const [id, s] of surfaces) if (!s.win.isDestroyed()) surfaceFacts.push({ id, visible: s.win.isVisible(), bounds: s.win.getBounds(), frames: await probeWindow(s.win) });
    const shell = frames.find((f) => f.origin === "clover-plugin://clover");
    const wanted = Number(process.env.CLOVER_SMOKE_LAYERS ?? "0");
    const layers = frames.filter((f) => f.origin.startsWith("clover-plugin://"));
    const others = new Set(layers.filter((f) => f.origin !== "clover-plugin://clover").map((f) => f.origin));
    webFacts = await probeWeb();
    const texts = [...[...frames, ...surfaceFacts.flatMap((x) => x.frames)].map((f) => f.text), ...webFacts.map((w) => w.text)];
    const drawn = shell?.shell === true && shell.composer && others.size >= wanted && layers.every((f) => f.rendered);
    // The compositor case (`CLOVER_SMOKE_UNRESPONSIVE=1`): the main window is said to be unresponsive while every
    // document in it answers.
    if (drawn && !hung && process.env.CLOVER_SMOKE_UNRESPONSIVE === "1") {
      hung = true;
      win.webContents.emit("unresponsive");
    }
    // Every layer's part has drawn, as many other layers as the run expects are there, and any text it waits for.
    // A sealed run (E-M3) breaks once its click landed, even if the shell's composer never draws: the click needs
    // only the fixture layer's sealed frames laid out, not the shell.
    const sealedWait = process.env.CLOVER_SMOKE_SEALED_CLICK !== undefined || process.env.CLOVER_SMOKE_SEALED_FALLBACK === "1";
    if (sealedWait && sealedClicked) break;
    if (drawn && waitTexts.every((w) => texts.some((t) => t.includes(w))) && Object.entries(waitMounts).every(([k, v]) => Number((runtime.stats() as Record<string, unknown>)[k] ?? 0) >= v) && (!sealedWait || sealedClicked)) break;
    // The hang test (`CLOVER_SMOKE_HANG=<surface>`): once everything has drawn and the named surface's own layer has
    // rendered (its frames aren't in the main window's, so `drawn` doesn't wait for it), the surface's layer is made
    // to hang (its own mouse-down handler never returns), then the window is told it went unresponsive. Chromium says
    // so only after its hang timeout with input waiting for that frame, and input doesn't reach a hidden window's
    // out-of-process frames, so the test raises the event itself; everything after it is the app's own path.
    const hangOn = process.env.CLOVER_SMOKE_HANG;
    const target = hangOn === undefined ? undefined : surfaces.get(hangOn)?.win;
    const targetFact = hangOn === undefined ? undefined : surfaceFacts.find((x) => x.id === hangOn);
    const targetLayer = targetFact?.frames.find((f) => f.url.startsWith("clover-plugin://"));
    if (drawn && !hung && target !== undefined && !target.isDestroyed() && targetLayer !== undefined && targetLayer.rendered) {
      const layer = target.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith("clover-plugin://"));
      if (layer !== undefined) {
        hung = true;
        void layer.executeJavaScript("document.querySelector('[data-fixture=spin]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))", true).catch(() => undefined);
        setTimeout(() => {
          if (!target.isDestroyed()) target.webContents.emit("unresponsive");
        }, 500);
      }
    }
    if (drawn && smokePage !== undefined && !pageOpened && (smokePage === "welcome" || smokePage === "plugins")) {
      pageOpened = true;
      void openPage(smokePage);
    }
    if (drawn && steps.length > 0) {
      const step = steps[0]!;
      const sel = JSON.stringify(step.click ?? step.check ?? step.fill ?? "");
      const js = step.fill !== undefined
        ? `(() => { const e = document.querySelector(${sel}); if (!e || e.disabled) return false; e.value = ${JSON.stringify(step.value ?? "")}; e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`
        : step.check !== undefined
          ? `(() => { const e = document.querySelector(${sel}); if (!e) return false; e.checked = true; e.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`
          : `(() => { const e = document.querySelector(${sel}); if (!e || e.disabled) return false; e.click(); return true; })()`;
      const done = await win.webContents.mainFrame.executeJavaScript(js, true).catch(() => false);
      if (done === true) steps.shift();
    }
    // The sealed UI test's click: click the named sealed frame's button so its answer rides `card.answer` to the
    // fake daemon (unpackaged runs only). Driven with `webContents.sendInputEvent` at the button's real coordinates,
    // which produces trusted events (no `trust` knob in production). The sealed iframe sits inside the plugin's layer
    // frame, not the root document, so offsets are summed up through each frame. Gated on the sealed frames
    // themselves, not the shell's composer (which a sealed run never needs).
    if (!sealedClicked) {
      const spec = process.env.CLOVER_SMOKE_SEALED_CLICK;
      if (spec !== undefined) {
        try {
          const {
            cardId, element, cover, opacity, doubleClick,
          } = JSON.parse(spec) as {
            cardId?: string; element?: string; cover?: boolean; opacity?: number; doubleClick?: boolean;
          };
          const frame: Electron.WebFrameMain | undefined = win.webContents.mainFrame.framesInSubtree.find((f) =>
            f.url.startsWith("clover-sealed://") &&
            (cardId === undefined || f.url.includes(cardId)) &&
            (element === undefined || f.url.includes(element) || (element !== undefined && f.url.includes(encodeURIComponent(element)))));
          if (frame !== undefined) {
            // URLs carry single-use tokens (?token=, ?mount=): the logs keep origin and path only, never the token.
            log(`sealed-click: frame found ${frame.url.split("?")[0]!.slice(0, 80)}`);
            // Optionally cover the button or dim it, to test that covered / semi-transparent presses don't answer.
            if (cover === true) {
              await frame.executeJavaScript(`(() => {
                const b = document.querySelector('.seal-button');
                if (!b) return;
                const c = document.createElement('div');
                c.style.position = 'absolute';
                c.style.inset = '0';
                c.style.zIndex = '9999';
                b.parentElement?.insertBefore(c, b);
              })()`, true).catch(() => undefined);
            }
            if (opacity !== undefined) {
              await frame.executeJavaScript(`(() => {
                const b = document.querySelector('.seal-button');
                if (!b) return;
                b.style.opacity = ${Number(opacity)};
              })()`, true).catch(() => undefined);
            }
            // Let the IntersectionObserver register the visibility change (trackVisibility, delay 200 ms), and the
            // button's own 500 ms visible + 400 ms open gates pass before the press.
            await new Promise((r) => setTimeout(r, 800));
            const buttonRaw = await frame.executeJavaScript(
              `(() => { const b = document.querySelector('.seal-button'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`, true).catch(() => null) as { x: number; y: number; width: number; height: number } | null;
            const buttonRect = buttonRaw !== null && typeof buttonRaw === "object" && typeof (buttonRaw as { x?: unknown }).x === "number" ? buttonRaw as { x: number; y: number; width: number; height: number } : null;
            // Sum the iframe offsets from the sealed frame up to the main frame: the sealed iframe lives in the
            // plugin's layer document, which itself lives in the root document.
            let offsetX = 0;
            let offsetY = 0;
            let chainOk = true;
            // Build the chain from the live frame tree: sealed frame, then each parent up to the main frame.
            let cursor: { parent: unknown } | null | undefined = frame as unknown as { parent: unknown } | null;
            const ordered: Electron.WebFrameMain[] = [frame];
            while (cursor !== null && cursor !== undefined && (cursor as { parent?: unknown }).parent !== null && (cursor as { parent?: unknown }).parent !== undefined) {
              const parent = (cursor as { parent: Electron.WebFrameMain }).parent;
              if ((parent as unknown as { detached?: boolean }).detached === true) break;
              ordered.push(parent);
              if (parent === win.webContents.mainFrame) break;
              cursor = parent as unknown as { parent: unknown } | null;
              if (ordered.length > 8) break;
            }
            ordered.reverse();
            for (let i = 0; i + 1 < ordered.length; i++) {
              const parent = ordered[i]!;
              const child = ordered[i + 1]!;
              const childUrl: string = child.url;
              let token = childUrl;
              try { token = new URL(childUrl).searchParams.get("token") ?? childUrl; } catch { /* use full url */ }
              const base = (() => { try { return new URL(childUrl).origin + new URL(childUrl).pathname; } catch { return childUrl.split("?")[0] ?? childUrl; } })();
              const probe = `(() => {
                const want = ${JSON.stringify(token)};
                const baseWant = ${JSON.stringify(base)};
                const frames = [...document.querySelectorAll('iframe')];
                const all = frames.map((f) => ({ src: f.src.split("?")[0].slice(0, 80), x: Math.round(f.getBoundingClientRect().x), y: Math.round(f.getBoundingClientRect().y) }));
                let el = frames.find((f) => f.src.includes(want));
                if (!el && baseWant !== "") el = frames.find((f) => f.src.includes(baseWant));
                if (!el) return { found: null, all };
                const r = el.getBoundingClientRect();
                return { found: { x: r.x, y: r.y }, all };
              })()`;
              const rectRaw = await parent.executeJavaScript(probe, true).catch(() => null) as { found: { x: number; y: number } | null; all?: unknown } | null;
              if (rectRaw !== null && typeof rectRaw === "object" && Array.isArray((rectRaw as { all?: unknown }).all)) log(`sealed-click: iframes in parent: ${JSON.stringify((rectRaw as { all?: unknown }).all).slice(0, 500)}`);
              if (rectRaw === null || typeof rectRaw !== "object" || (rectRaw as { found?: unknown }).found === null || typeof (rectRaw as { found?: { x?: unknown } | null }).found !== "object" || typeof ((rectRaw as { found: { x?: unknown } }).found as { x?: unknown }).x !== "number") { chainOk = false; break; }
              const rect = (rectRaw as { found: { x: number; y: number } }).found;
              offsetX += rect.x;
              offsetY += rect.y;
            }
            if (!chainOk) log(`sealed-click: no offset chain for ${frame.url.split("?")[0]!.slice(0, 80)}`);
            // Report how the label renders, so the markup case proves text, not HTML (check 3).
            const labelRaw = await frame.executeJavaScript(
              `(() => { const s = document.querySelector('.seal-button .label'); if (!s) return null; return { html: s.innerHTML.slice(0, 200), hasBold: s.querySelector('b') !== null, sealed: typeof window.cloverSealed, btn: typeof document.querySelector('.seal-button') }; })()`, true).catch(() => null) as { html: string; hasBold: boolean } | null;
            if (labelRaw !== null && typeof labelRaw === "object") log(`sealed-click: label html=${String((labelRaw as { html?: unknown }).html ?? "")} hasBold=${String((labelRaw as { hasBold?: unknown }).hasBold ?? "")} sealed=${String((labelRaw as { sealed?: unknown }).sealed ?? "")}`);
            if (buttonRect !== null && chainOk) {
              if (buttonRect.width <= 0 || buttonRect.height <= 0) {
                log(`sealed-click: button has no size yet, retrying`);
              } else {
              const centerX = Math.round(offsetX + buttonRect.x + buttonRect.width / 2);
              const centerY = Math.round(offsetY + buttonRect.y + buttonRect.height / 2);
              log(`sealed-click: button rect=${buttonRect.x},${buttonRect.y} ${buttonRect.width}x${buttonRect.height} offset=${offsetX},${offsetY}`);
              log(`sealed-click: press sent at ${centerX},${centerY}`);
              const hit = await win.webContents.executeJavaScript(
                `(() => { const els = document.elementsFromPoint(${Math.round(centerX)}, ${Math.round(centerY)}); return JSON.stringify(els.slice(0, 5).map((el) => { const tag = el.tagName; const src = el.tagName === "IFRAME" ? el.src.split("?")[0].slice(0, 60) : (el.className !== undefined ? String(el.className).slice(0, 40) : null); const r = el.getBoundingClientRect(); const pe = getComputedStyle(el).pointerEvents; return { tag, src, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), pe }; })); })()`, true).catch(() => null) as string | null;
              log(`sealed-click: root hit-test: ${String(hit ?? "failed").slice(0, 600)}`);
              const cloverFrame = win.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith("clover-plugin://clover/"));
              if (cloverFrame !== undefined) {
                const cloverHit = await cloverFrame.executeJavaScript(
                  `(() => { const els = document.elementsFromPoint(${Math.round(centerX)}, ${Math.round(centerY)}); return JSON.stringify(els.slice(0, 4).map((el) => ({ tag: el.tagName, src: el.tagName === "IFRAME" ? el.src.split("?")[0].slice(0, 60) : null }))); })()`, true).catch(() => null) as string | null;
                log(`sealed-click: clover hit-test: ${String(cloverHit ?? "failed").slice(0, 400)}`);
                await cloverFrame.executeJavaScript(`(() => { window.__cloverPresses = []; document.addEventListener('pointerdown', (e) => window.__cloverPresses.push([e.clientX, e.clientY, e.isTrusted]), true); })()`, true).catch(() => null);
                const cloverPe = await cloverFrame.executeJavaScript(`(() => { const f = document.querySelector('iframe'); return f ? getComputedStyle(f).pointerEvents : "no-iframe"; })()`, true).catch(() => null) as string | null;
                log(`sealed-click: clover iframe pointer-events: ${String(cloverPe ?? "failed")}`);
              }
              await frame.executeJavaScript(`(() => { window.__sealedPresses = []; document.addEventListener('pointerdown', (e) => window.__sealedPresses.push([e.clientX, e.clientY, e.isTrusted]), true); })()`, true).catch(() => null);
              await win.webContents.executeJavaScript(`(() => { window.__rootPresses = []; document.addEventListener('pointerdown', (e) => window.__rootPresses.push([e.clientX, e.clientY, e.isTrusted]), true); })()`, true).catch(() => null);
              // Drive the press over CDP input (unpackaged smoke only): sendInputEvent's mouse path does not reach
              // out-of-process sealed iframes in this Electron, while CDP-dispatched input is still trusted. Test-only
              // on every axis (B1): a packaged app never attaches the debugger, whatever env vars it started with.
              const inputAllowed = sealedInputAllowed({ packaged: app.isPackaged, headless });
              let cdp = false;
              if (inputAllowed) {
                try {
                  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.1");
                  cdp = win.webContents.debugger.isAttached();
                } catch { /* fall back to sendInputEvent */ }
              }
              const dispatch = !inputAllowed
                ? async (_kind: "mouseMoved" | "mousePressed" | "mouseReleased") => { /* refused: test input stays in test runs */ }
                : cdp
                  ? async (kind: "mouseMoved" | "mousePressed" | "mouseReleased") => { await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: kind, x: centerX, y: centerY, ...(kind === "mouseMoved" ? {} : { button: "left", clickCount: 1 }) }).catch(() => undefined); }
                  : async (kind: "mouseMoved" | "mousePressed" | "mouseReleased") => { void win.webContents.sendInputEvent({ type: kind === "mouseMoved" ? "mouseMove" : kind === "mousePressed" ? "mouseDown" : "mouseUp", x: centerX, y: centerY, ...(kind === "mouseMoved" ? {} : { button: "left" as const }) }); };
              log(`sealed-click: input via ${!inputAllowed ? "refused" : cdp ? "cdp" : "sendInputEvent"}`);
              await dispatch("mouseMoved");
              await new Promise((r) => setTimeout(r, 120));
              await dispatch("mousePressed");
              await dispatch("mouseReleased");
              if (doubleClick === true) {
                // A second press while the first answer is still in flight must not land (should-fix 3).
                await new Promise((r) => setTimeout(r, 300));
                await dispatch("mousePressed");
                await dispatch("mouseReleased");
              }
              if (cdp) {
                try {
                  win.webContents.debugger.detach();
                } catch { /* quitting soon anyway */ }
              }
              sealedClicked = true;
              await new Promise((r) => setTimeout(r, 1000));
              const after = await frame.executeJavaScript(
                `(() => { const s = document.querySelector('.state'); return { state: s ? s.textContent : null, answered: document.body.dataset.answered ?? null, presses: (window.__sealedPresses ?? []).slice(0, 4) }; })()`, true).catch(() => null) as { state: string | null; answered: string | null } | null;
              if (after !== null && typeof after === "object") log(`sealed-click: after press state=${String((after as { state?: unknown }).state ?? "")} answered=${String((after as { answered?: unknown }).answered ?? "")} presses=${JSON.stringify((after as { presses?: unknown }).presses ?? [])}`);
              const rootAfter = await win.webContents.executeJavaScript(
                `(() => ({ presses: (window.__rootPresses ?? []).slice(0, 4) }))()`, true).catch(() => null) as { presses: unknown } | null;
              if (rootAfter !== null && typeof rootAfter === "object") log(`sealed-click: root presses=${JSON.stringify((rootAfter as { presses?: unknown }).presses ?? [])}`);
              if (cloverFrame !== undefined) {
                const cloverAfter = await cloverFrame.executeJavaScript(
                  `(() => ({ presses: (window.__cloverPresses ?? []).slice(0, 4) }))()`, true).catch(() => null) as { presses: unknown } | null;
                if (cloverAfter !== null && typeof cloverAfter === "object") log(`sealed-click: clover presses=${JSON.stringify((cloverAfter as { presses?: unknown }).presses ?? [])}`);
              }
              }
            } else {
              log(`sealed-click: no button rect (button=${buttonRect === null ? "null" : "ok"} chain=${chainOk ? "ok" : "null"})`);
            }
          } else {
            log(`sealed-click: no sealed frame`);
          }
        } catch { /* bad spec: no click */ }
      }
    }
    // The fallback card: if no sealed frame was clicked and the fallback run is enabled, click the fallback window's
    // Approve button so its answer rides `card.answer` to the fake daemon (unpackaged runs only). Gated on the
    // fallback window itself, not the shell.
    if (!sealedClicked && process.env.CLOVER_SMOKE_SEALED_FALLBACK === "1") {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w === win || w.isDestroyed()) continue;
        if (!w.webContents.getURL().startsWith("clover-sealed://")) continue;
        log(`sealed-click: fallback frame found ${w.webContents.getURL().split("?")[0]!.slice(0, 80)}`);
        const frame = w.webContents.mainFrame;
        const fallbackRaw = await frame.executeJavaScript(
          `(() => { const b = document.querySelector('.seal-button'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`, true).catch(() => null) as { x: number; y: number; width: number; height: number } | null;
        const buttonRect = fallbackRaw !== null && typeof fallbackRaw === "object" && typeof (fallbackRaw as { x?: unknown }).x === "number" ? fallbackRaw as { x: number; y: number; width: number; height: number } : null;
        if (buttonRect !== null) {
          // Viewport coordinates for this window's own webContents (not screen coordinates).
          const centerX = Math.round(buttonRect.x + buttonRect.width / 2);
          const centerY = Math.round(buttonRect.y + buttonRect.height / 2);
          // Record what the fallback page hears, so a silent gate shows up in the log (the part path's presses=).
          await frame.executeJavaScript(`(() => { window.__fbEvents = []; for (const t of ["pointerover", "pointerdown", "click"]) document.addEventListener(t, (e) => window.__fbEvents.push([t, Math.round(e.clientX), Math.round(e.clientY), e.isTrusted, e.target instanceof Element ? (e.target.closest(".seal-button") !== null ? "button" : e.target.tagName) : "?"]), true); })()`, true).catch(() => null);
          // The fallback's own gates: the pointer must enter after the window shows, and a second after it shows.
          // Move there first so pointerover fires, wait out the 1 s, then press. A second move right before the
          // press covers a first one lost while the page still loaded. CDP input (like the part path): sendInputEvent
          // does not reach the page here. Test-only on every axis (B1): a packaged app never attaches the debugger,
          // whatever env vars it started with.
          const fbInputAllowed = sealedInputAllowed({ packaged: app.isPackaged, headless });
          let fbCdp = false;
          if (fbInputAllowed) {
            try {
              if (!w.webContents.debugger.isAttached()) w.webContents.debugger.attach("1.1");
              fbCdp = w.webContents.debugger.isAttached();
            } catch { /* fall back to sendInputEvent */ }
          }
          const fbDispatch = !fbInputAllowed
            ? async (_kind: "mouseMoved" | "mousePressed" | "mouseReleased") => { /* refused: test input stays in test runs */ }
            : fbCdp
              ? async (kind: "mouseMoved" | "mousePressed" | "mouseReleased") => { await w.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: kind, x: centerX, y: centerY, ...(kind === "mouseMoved" ? {} : { button: "left", clickCount: 1 }) }).catch(() => undefined); }
              : async (kind: "mouseMoved" | "mousePressed" | "mouseReleased") => { void w.webContents.sendInputEvent({ type: kind === "mouseMoved" ? "mouseMove" : kind === "mousePressed" ? "mouseDown" : "mouseUp", x: centerX, y: centerY, ...(kind === "mouseMoved" ? {} : { button: "left" as const }) }); };
          log(`sealed-click: fallback input via ${!fbInputAllowed ? "refused" : fbCdp ? "cdp" : "sendInputEvent"}`);
          await fbDispatch("mouseMoved");
          await new Promise((r) => setTimeout(r, 1300));
          if (w.isDestroyed()) break;
          log(`sealed-click: fallback press sent at ${centerX},${centerY}`);
          await fbDispatch("mouseMoved");
          await new Promise((r) => setTimeout(r, 120));
          if (w.isDestroyed()) break;
          await fbDispatch("mousePressed");
          await fbDispatch("mouseReleased");
          if (fbCdp) {
            try {
              w.webContents.debugger.detach();
            } catch { /* quitting soon anyway */ }
          }
          sealedClicked = true;
          await new Promise((r) => setTimeout(r, 1000));
          const fbAfter = await frame.executeJavaScript(
            `(() => ({ events: (window.__fbEvents ?? []).slice(0, 8), answered: document.body.dataset.answered ?? null }))()`, true).catch(() => null) as { events: unknown; answered: string | null } | null;
          if (fbAfter !== null && typeof fbAfter === "object") log(`sealed-click: fallback after press events=${JSON.stringify((fbAfter as { events?: unknown }).events ?? [])} answered=${String((fbAfter as { answered?: unknown }).answered ?? "")}`);
        }
        break;
      }
    }
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
    web: webFacts,
    housing: (() => {
      if (screens === null) screens = loadScreens(join(here, "native", "screen.node"), log);
      return { addOn: screens !== undefined, notch: housingFor(screen.getPrimaryDisplay().id, screens) };
    })(),
    captured,
  });
  if (process.env.CLOVER_SMOKE_KEEP === "1") return;
  await requestQuit("smoke");
}
