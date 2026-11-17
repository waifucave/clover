// MOSS's main process (spec §1.2, §3.1, §3.4, §3.5, §5.5, §6.10): the app for bots, a fixed built-in window on the shared
// engine. It connects as the `app` role with `surface: "moss"`, mounts no plugin part and runs no plugin UI runtime: its
// one window is its own page (`moss-app://app/`), and the only other documents in it are the sealed card frames MOSS's
// own store mints (`moss-sealed://card/…`), whose presses MOSS's main process judges itself (press.ts) and answers with
// MOSS's own key (answer-key.ts). Quitting MOSS stops nothing: the engine, the host and every bot keep working.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, safeStorage, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebFrameMain } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BotFace as ProtocolBotFace, TOOL_AVAILABILITIES, type MossHelloResult, type ToolAvailability } from "@waifucave/moss-protocol";
import { daemonEndpoint, type DaemonClient } from "./client";
import { bundlePathOf, writeOwnRecord } from "./install-record";
import { EngineConnection, locateEngine, osLauncher, tokenPath, type ConnectionState } from "./connection";
import { MossEngine } from "./engine";
import type { BotEdit } from "../shared/view";
import { engineHome, MAIN_WINDOW_ID, mossIdentity, parseLaunchArgs, resolveProfile, WINDOW_PARTITION } from "./identity";
import { fileVault, memoryVault, ProgramAnswerKey, safeStorageVault, vaultChoice } from "./answer-key";
import { refusedLaunchSwitches } from "./debug-guard";
import { PresenceReporter } from "./presence";
import { answerPress, PressRecord } from "./press";
import { isOurProgram, loadWindowList, pressCover, windowIdOfMediaSource, type WindowList } from "./overlap";
import { OWN_ELEMENT, SealedFrames } from "./sealed";
import { ownCardPage } from "./sealed-pages";
import { alwaysSentence, summarize as summarizeCard } from "./card-summary";
import { isTalkKey, Talk } from "./voice";
import { runSmoke, runRender } from "./test-runs";

declare const __MOSS_TEST_BUILD__: string | false;

const here = dirname(fileURLToPath(import.meta.url));
const profile = resolveProfile(process.env);
const identity = mossIdentity(profile);
const args = parseLaunchArgs(process.argv);
const headless = args.headless;
const testBuild = typeof __MOSS_TEST_BUILD__ === "string";
// The dev overrides (the engine binary, the token, the user-data folder) count only in an unpackaged or dev run.
const devOverrides = !app.isPackaged || profile === "dev";
const home = engineHome(process.env);

app.setName(identity.productName);
if (process.platform === "win32") app.setAppUserModelId(identity.appId);
// Its own user data: never MOSS Code's, never a real one from a test (MOSS_USER_DATA, a dev or test run's temp folder).
const userDataOverride = devOverrides ? process.env.MOSS_USER_DATA : undefined;
if (userDataOverride !== undefined && userDataOverride !== "") app.setPath("userData", userDataOverride);
if (testBuild) {
  // A test build keeps off the login keychain (Chromium's mock keychain) and refuses a real user-data folder.
  app.commandLine.appendSwitch("use-mock-keychain");
  if (userDataOverride === undefined || userDataOverride === "") {
    console.error("moss: refusing to start: this is a test-marked build, and MOSS_USER_DATA isn't set to a temp folder");
    app.exit(2);
  }
}
if (headless) {
  // Nothing on the screen and no sound: no Dock icon, no window shown, every page muted.
  app.commandLine.appendSwitch("mute-audio");
  if (process.platform === "darwin") app.dock?.hide();
}

// No debugging door (debug-guard.ts): checked before any window or engine connection. A test-marked headless run that
// asks for its DevTools port (the acceptance's) takes `--remote-debugging-port` alone.
{
  const testDebug = typeof __MOSS_TEST_BUILD__ === "string" && headless && process.env.MOSS_TEST_DEBUG === "1";
  const refused = refusedLaunchSwitches({ argv: process.argv, hasSwitch: (n) => app.commandLine.hasSwitch(n), packaged: app.isPackaged, env: process.env, testDebug });
  if (refused.length > 0) {
    console.error(`moss: refusing to start with ${refused.map((n) => `--${n}`).join(", ")}: they would let another program drive MOSS's window`);
    app.exit(2);
  }
}

const APP_SCHEME = "moss-app";
const SEALED_SCHEME = "moss-sealed";
protocol.registerSchemesAsPrivileged([APP_SCHEME, SEALED_SCHEME].map((scheme) => ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } })));

const logLines: string[] = [];
function log(line: string): void {
  const text = `${new Date().toISOString()} ${line}`;
  logLines.push(text);
  if (logLines.length > 2_000) logLines.shift();
  console.log(`moss: ${line}`);
}

const sealed = new SealedFrames("moss");
const engine = new MossEngine(sealed, log);
const record = new PressRecord();
const presence = new PresenceReporter(log);
const answerKey = new ProgramAnswerKey((() => {
  // The acceptance's kept key is read only in a test-marked build (the label tested inline, so a real build has none of it).
  const testKeyFile = typeof __MOSS_TEST_BUILD__ === "string" ? process.env.MOSS_TEST_ANSWER_KEY : undefined;
  const linuxPlainText = process.platform === "linux" && app.isPackaged && !headless && !testBuild ? (() => { try { return safeStorage.getSelectedStorageBackend() === "basic_text"; } catch { return true; } })() : false;
  const choice = vaultChoice({ packaged: app.isPackaged, headless, testBuild, profile, platform: process.platform, ...(testKeyFile !== undefined && isAbsolute(testKeyFile) ? { testKeyFile } : {}), linuxPlainText });
  if (choice.kind === "file") return fileVault(choice.file);
  if (choice.kind === "dev-file") return fileVault(join(app.getPath("userData"), "answer-key.dev"));
  if (choice.kind === "safe-storage") return safeStorageVault(join(app.getPath("userData"), "answer-key"), safeStorage);
  return memoryVault();
})(), log);
let device: string | undefined;
let mainWindow: BrowserWindow | undefined;
/** What the window shows now, as its page said (checked against the bots the engine has). */
let showing: { bot: string } | { page: string } = { page: "none" };

const release = readRelease();
function readRelease(): string {
  // The app's version is the release (`VERSION`, stamped into package.json by the version scripts).
  return app.getVersion();
}

const connection = new EngineConnection({
  endpoint: daemonEndpoint(home),
  token: () => {
    const fromEnv = devOverrides ? process.env.MOSS_APP_TOKEN : undefined;
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    try {
      const t = readFileSync(tokenPath(home), "utf8").trim();
      return t === "" ? undefined : t;
    } catch {
      return undefined;
    }
  },
  release,
  pid: process.pid,
  ...(() => {
    const binary = locateEngine({ env: devOverrides ? process.env : {}, packaged: app.isPackaged, resourcesPath: process.resourcesPath });
    // A test build never starts an engine through the OS: its engine is the test's.
    return binary !== undefined && !testBuild ? { launcher: osLauncher(binary, home, profile) } : {};
  })(),
  log,
  onConnected: (client, hello) => connected(client, hello),
  onState: (s) => stateChanged(s),
  onEngineQuit: (reason) => {
    log(`the engine asked MOSS to leave (${reason})`);
    app.exit(0);
  },
});
connection.onNotification((method, params) => engine.notification(method, params));
connection.handle("app.show", () => {
  if (!headless) void openWindow();
  return { ok: true };
});

async function connected(client: DaemonClient, hello: MossHelloResult): Promise<void> {
  device = hello.device;
  engine.setConnection("connected", undefined, hello.release?.engine);
  presence.connected(client);
  answerKey.reset();
  void answerKey.register(client, hello.device, () => connection.client === client);
  void recordInstall(client);
  await engine.attach(client);
  pushPresence();
}

function stateChanged(s: ConnectionState): void {
  log(`connection: ${s.kind}`);
  if (s.kind !== "connected") presence.disconnected();
  engine.setConnection(s.kind, "reason" in s ? s.reason : s.kind === "behind" ? `MOSS needs release ${s.needs} to talk to this engine.` : undefined);
}

/** Where this copy of MOSS is (§3.1 "Where the copies are found"): written under the home before the first dial (install-record.ts;
 *  the engine reads it when this app, ahead of it, asks `release.bring`), and again through the engine once connected
 *  (`release.record`, lane RL's: the engine checks the program is this connection's own). */
function ownBundle(): string {
  return bundlePathOf({ packaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath, execPath: process.execPath, appPath: app.getAppPath() });
}
const carriesEngine = (): boolean => locateEngine({ env: {}, packaged: app.isPackaged, resourcesPath: process.resourcesPath }) !== undefined;
async function recordInstall(client: DaemonClient): Promise<void> {
  await client.request("release.record", { program: "moss", bundlePath: ownBundle(), release, carries: { engine: carriesEngine(), host: false } }, 10_000)
    .then(() => log("release: this copy of MOSS is recorded"))
    .catch((err: unknown) => log(`release: not recorded (${err instanceof Error ? err.message.slice(0, 120) : "refused"})`));
}

// -------------------------------------------------------------------------------------------------
// The window
// -------------------------------------------------------------------------------------------------

function windowFiles(): string {
  return join(here, "..", "renderer", "window");
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const COMMON_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=(), clipboard-read=()",
};
/** MOSS's own page: its own scripts and styles, pictures as data URLs (faces, live pictures), sealed card frames only. */
const WINDOW_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  `frame-src ${SEALED_SCHEME}:`, "connect-src 'none'", "form-action 'none'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
].join("; ");
const SEALED_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src 'self' data:", "connect-src 'none'",
  `frame-ancestors ${APP_SCHEME}:`, "form-action 'none'", "object-src 'none'", "base-uri 'none'",
].join("; ");

async function hardenSession(ses: Session): Promise<void> {
  ses.setSpellCheckerEnabled(false);
  if (process.platform !== "darwin") {
    ses.setSpellCheckerLanguages([]);
    ses.setSpellCheckerDictionaryDownloadURL("http://127.0.0.1:9/");
  }
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (e) => e.preventDefault());
  await ses.setProxy({ mode: "direct" });
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok = details.url.startsWith(`${APP_SCHEME}://`) || details.url.startsWith(`${SEALED_SCHEME}://`) || details.url.startsWith("data:") || details.url.startsWith("devtools:");
    if (!ok) log(`window: refused a request off MOSS's own schemes (${details.url.split(":")[0]})`);
    callback({ cancel: !ok });
  });
  ses.protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("not found", { status: 404, headers: COMMON_HEADERS });
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const root = windowFiles();
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep) || !existsSync(file)) return new Response("not found", { status: 404, headers: COMMON_HEADERS });
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    return new Response(readFileSync(file), { headers: { ...COMMON_HEADERS, "Content-Type": type, ...(type.startsWith("text/html") ? { "Content-Security-Policy": WINDOW_CSP } : {}) } });
  });
  ses.protocol.handle(SEALED_SCHEME, (request) => {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (url.host !== "card" || token === null || token === "" || token.length > 128) return new Response("forbidden", { status: 403, headers: COMMON_HEADERS });
    const serving = sealed.serve(token);
    if (serving === undefined || serving.element !== OWN_ELEMENT) {
      log("sealed: refusing a sealed load (no channel)");
      return new Response("forbidden", { status: 403, headers: COMMON_HEADERS });
    }
    const card = serving.card;
    const botName = card.bot !== undefined ? engine.view().bots.find((b) => b.id === card.bot)?.name : undefined;
    const summary = summarizeCard(card, botName, app.getPath("home"));
    const always = alwaysSentence(card, botName, app.getPath("home"));
    const html = ownCardPage({
      cardId: card.id, token, origin: card.origin, issuedAt: card.issuedAt, expiresAt: card.expiresAt, fields: card.fields, options: card.options, computer: card.computer,
      ...(summary !== undefined ? { summary } : {}), ...(always !== undefined ? { always } : {}),
      ...(card.pluginId !== undefined ? { who: { pluginId: card.pluginId } } : botName !== undefined ? { who: { bot: botName } } : {}),
      ...(card.kind === "plugin-ok" || (card.kind === "change" && card.change === "plugin-update") ? { reviewable: true } : {}),
    });
    return new Response(html, { headers: { ...COMMON_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": SEALED_CSP } });
  });
}

let windowSession: Session | undefined;

async function openWindow(): Promise<BrowserWindow> {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (!headless) { mainWindow.show(); mainWindow.focus(); }
    return mainWindow;
  }
  windowSession ??= session.fromPartition(WINDOW_PARTITION);
  // A test-marked headless run draws offscreen (a never-shown window paints nothing, and a card's visibility reading would
  // never say it shows); a real headless run is never one a person presses in.
  const offscreen = args.render !== undefined || args.smoke !== undefined || (testBuild && headless);
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 640, minHeight: 480, show: false, title: identity.productName,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#161A33" : "#F6F4EE",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    ...(headless ? { skipTaskbar: true, focusable: false } : {}),
    webPreferences: {
      preload: join(here, "preload.cjs"), session: windowSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: true, nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      spellcheck: false, navigateOnDragDrop: false, safeDialogs: true, autoplayPolicy: "user-gesture-required",
      backgroundThrottling: !headless, ...(offscreen ? { offscreen: true } : {}),
    },
  });
  mainWindow = win;
  const id = win.id;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.on("will-frame-navigate", (e) => {
    if (!e.url.startsWith(`${APP_SCHEME}://app/`) && !e.url.startsWith(`${SEALED_SCHEME}://card/`)) e.preventDefault();
  });
  // The press record: what MOSS's main process saw come to its window (§5.5), never a page's word.
  win.webContents.on("before-mouse-event", (_event, mouse) => {
    if (mouse.type === "mouseDown") record.mouseDown(id, { x: mouse.x, y: mouse.y });
  });
  win.webContents.on("before-input-event", (_event, input) => {
    if (isTalkKey(input) || (talk.holding && input.type === "keyUp" && input.code === "Space")) {
      // The talk key belongs to MOSS's main process: it reads the key here and never prevents it (Chromium would then drop
      // the key's release, and the hold would never end); the preload keeps it from every page (preload.ts).
      if (input.type === "keyDown" && !input.isAutoRepeat) talk.down("key");
      else if (input.type === "keyUp") talk.up();
      return;
    }
    if (input.type === "keyDown" && !input.isAutoRepeat) record.keyDown(id, frameKey(win.webContents.focusedFrame));
  });
  for (const e of ["focus", "blur", "show", "hide", "minimize", "restore"] as const) win.on(e as "focus", () => { if (e === "blur" || e === "hide" || e === "minimize") talk.cancel(); pushPresence(); });
  win.on("closed", () => {
    record.forget(id);
    talk.cancel();
    if (mainWindow === win) mainWindow = undefined;
    pushPresence();
  });
  win.once("ready-to-show", () => {
    if (!headless) win.show();
  });
  // A headless run puts nothing on the screen: should anything ever show this window, it says so (the tests look for it).
  win.on("show", () => { if (headless) log("window: shown while headless"); });
  await win.loadURL(`${APP_SCHEME}://app/index.html`);
  return win;
}

function frameKey(f: WebFrameMain | null | undefined): string | undefined {
  return f === null || f === undefined || f.detached ? undefined : `${f.processId}:${f.routingId}`;
}

/** The test build may say the window is in front while headless (the renders and the UI test place cards in it). */
const testFront = testBuild && process.env.MOSS_TEST_FRONT === "1";
/** A test-marked headless run's stand-in for the window coming to the front and going behind (a headless window is never
 *  the focused one): the file `MOSS_TEST_MAIN_FRONT_FILE` names holds `front` or `back`, read every 100 ms; each change
 *  is reported to the router at once. Compiled out of a real build (the label is tested inline). */
let testFrontSeam: boolean | undefined;
function startFrontSeam(): void {
  if (typeof __MOSS_TEST_BUILD__ === "string" && headless && process.env.MOSS_TEST_MAIN_FRONT_FILE) {
    const file = process.env.MOSS_TEST_MAIN_FRONT_FILE;
    setInterval(() => {
      let word = "";
      try { word = readFileSync(file, "utf8").trim(); } catch { return; }
      const next = word === "front" ? true : word === "back" ? false : undefined;
      if (next === undefined || next === testFrontSeam) return;
      testFrontSeam = next;
      log(`window: the test seam says MOSS's window is ${next ? "in front" : "not in front"}`);
      if (!next) talk.cancel();
      pushPresence();
    }, 100).unref?.();
  }
}

function standing(windowId: number): { window: string; visible: boolean; focused: boolean; minimized: boolean } | undefined {
  const w = mainWindow;
  if (w === undefined || w.isDestroyed() || w.id !== windowId) return undefined;
  if (testFrontSeam !== undefined) return { window: MAIN_WINDOW_ID, visible: true, focused: testFrontSeam, minimized: false };
  if (testFront) return { window: MAIN_WINDOW_ID, visible: true, focused: true, minimized: false };
  return { window: MAIN_WINDOW_ID, visible: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized() };
}

function pushPresence(): void {
  const w = mainWindow;
  if (w === undefined || w.isDestroyed()) return presence.update(undefined);
  const s = standing(w.id)!;
  const shows = "bot" in showing && engine.hasBot(showing.bot) ? { kind: "bot" as const, id: showing.bot } : null;
  presence.update({ focused: s.focused && s.visible && !s.minimized, visible: s.visible && !s.minimized, showing: shows });
}

// -------------------------------------------------------------------------------------------------
// The window's bridge: a fixed list of calls, each from MOSS's own page alone
// -------------------------------------------------------------------------------------------------

/** The sender must be MOSS's own page: its window's top frame, on its own scheme. */
function fromPage(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | undefined {
  const w = mainWindow;
  const f = event.senderFrame;
  if (w === undefined || w.isDestroyed() || event.sender !== w.webContents || f === null || f.detached) return undefined;
  if (f !== w.webContents.mainFrame || !f.url.startsWith(`${APP_SCHEME}://app/`)) return undefined;
  return w;
}

/** Pictures the person picked for the composer, by id, until sent (the window holds only their names). */
const picked = new Map<string, { name: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string }>();

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

function handle(channel: string, fn: (w: BrowserWindow, a: Record<string, unknown>) => unknown): void {
  ipcMain.handle(channel, (event, a) => {
    const w = fromPage(event);
    if (w === undefined) throw new Error("not MOSS's window");
    return fn(w, (a ?? {}) as Record<string, unknown>);
  });
}
function on(channel: string, fn: (w: BrowserWindow, a: Record<string, unknown>) => void): void {
  ipcMain.on(channel, (event, a) => {
    const w = fromPage(event);
    if (w !== undefined) fn(w, (a ?? {}) as Record<string, unknown>);
  });
}

/** A write the person makes in the window (a send, a new bot, holding the microphone): only right after their own press in
 *  MOSS's page (main's press record, the page's own frame), one write per press. */
function personPressed(w: BrowserWindow): boolean {
  const mainFrame = frameKey(w.webContents.mainFrame);
  if (mainFrame === undefined) return false;
  if (record.take(w.id, mainFrame) !== undefined) return true;
  return testBuild && process.env.MOSS_TEST_PRESSES === "1";
}

const talk = new Talk(async (held) => {
  const client = connection.client;
  // The active voice plugin's own held command (voice.ts `talkCommandOf`), read from the plugins' declarations.
  const command = engine.talkCommand();
  if (client === undefined || !("command" in command)) return false;
  try {
    await client.request("command.run", { name: command.command, held }, 10_000);
    return true;
  } catch {
    return false;
  }
}, log);

function wireBridge(): void {
  handle("moss:view", () => engine.view());
  on("moss:showing", (_w, a) => {
    showing = typeof a.bot === "string" ? { bot: a.bot } : { page: typeof a.page === "string" ? a.page : "none" };
    pushPresence();
  });
  handle("moss:conversation", (_w, a) => {
    const bot = str(a.bot, 64);
    if (bot === undefined) throw new Error("bad bot");
    return engine.conversation(bot, typeof a.before === "number" ? a.before : undefined);
  });
  handle("moss:send", async (w, a) => {
    const bot = str(a.bot, 64);
    const text = typeof a.text === "string" ? a.text.slice(0, 100_000).trim() : "";
    const ids = Array.isArray(a.images) ? a.images.filter((x): x is string => typeof x === "string").slice(0, 4) : [];
    const images = ids.flatMap((id) => { const p = picked.get(id); return p === undefined ? [] : [p]; });
    if (bot === undefined || (text === "" && images.length === 0)) return { ok: false, why: "Nothing to send." };
    if (!personPressed(w)) {
      log("send: refused (no press of the person's own just before)");
      return { ok: false, why: "Words go only right after your own key press or click." };
    }
    const r = await engine.send(bot, text === "" ? "(a picture)" : text, randomUUID(), images.map((p) => ({ mediaType: p.mediaType, data: p.data })));
    if (r.ok) for (const id of ids) picked.delete(id);
    return r;
  });
  handle("moss:pick-images", async (w) => {
    if (headless) return [];
    const r = await dialog.showOpenDialog(w, { properties: ["openFile", "multiSelections"], filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    if (r.canceled) return [];
    const out: { id: string; name: string }[] = [];
    for (const path of r.filePaths.slice(0, 4)) {
      const ext = extname(path).toLowerCase();
      const mediaType = ext === ".png" ? "image/png" as const : ext === ".webp" ? "image/webp" as const : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" as const : undefined;
      if (mediaType === undefined) continue;
      let bytes: Buffer;
      try { bytes = readFileSync(path); } catch { continue; }
      if (bytes.length > 10 * 1024 * 1024) continue;
      const id = randomUUID();
      picked.set(id, { name: basename(path), mediaType, data: bytes.toString("base64") });
      while (picked.size > 8) picked.delete(picked.keys().next().value!);
      out.push({ id, name: basename(path) });
    }
    return out;
  });
  handle("moss:create-bot", async (w, a) => {
    const name = typeof a.name === "string" ? a.name.trim().slice(0, 80) : "";
    if (name === "") return { ok: false, why: "A bot needs a name." };
    if (!personPressed(w)) return { ok: false, why: "A bot is made only right after your own key press or click." };
    return engine.createBot(name);
  });
  on("moss:mark-read", (_w, a) => {
    const bot = str(a.bot, 64);
    if (bot !== undefined) engine.markRead(bot, Date.now());
  });
  handle("moss:routines", (_w, a) => engine.routines(str(a.bot, 64) ?? ""));
  handle("moss:pictures", (_w, a) => engine.pictures(str(a.bot, 64) ?? ""));
  handle("moss:picture-open", (_w, a) => engine.openPicture(str(a.id, 64) ?? ""));
  on("moss:picture-close", (_w, a) => { const id = str(a.id, 64); if (id !== undefined) engine.closePicture(id); });
  handle("moss:card-frame", (w, a) => {
    const cardId = str(a.cardId, 64);
    if (cardId === undefined) return undefined;
    const placed = engine.view().cards.some((c) => c.id === cardId);
    if (!placed) return undefined;
    const mf = w.webContents.mainFrame;
    const made = sealed.mint(cardId, OWN_ELEMENT, { parent: { processId: mf.processId, routingId: mf.routingId } }, w.id);
    return made === undefined ? undefined : `${SEALED_SCHEME}://card/${encodeURIComponent(cardId)}/${OWN_ELEMENT}?token=${encodeURIComponent(made.token)}`;
  });
  on("moss:talk", (w, a) => {
    if (a.phase === "down") {
      if (personPressed(w)) talk.down("button");
      else log("voice: refused (no press of the person's own just before)");
    } else talk.up();
  });
  handle("moss:plugins", () => engine.plugins());
  handle("moss:set-availability", (w, a) => {
    const server = str(a.server, 256);
    const tool = str(a.tool, 256);
    const availability = (TOOL_AVAILABILITIES as readonly string[]).includes(String(a.availability)) ? a.availability as ToolAvailability : undefined;
    if (server === undefined || tool === undefined || availability === undefined || !personPressed(w)) return false;
    return engine.setAvailability(server, tool, availability);
  });
  handle("moss:add-plugin", async (w, a) => {
    if (a.file === true) {
      if (headless) return { ok: false, why: "No dialog in a headless run." };
      const r = await dialog.showOpenDialog(w, { properties: ["openDirectory"], title: "Add a plugin from a folder" });
      if (r.canceled || r.filePaths[0] === undefined) return { ok: false, why: "Nothing picked." };
      return engine.addPlugin({ folder: r.filePaths[0] });
    }
    const link = str(a.link, 2_000);
    return link === undefined ? { ok: false, why: "No link." } : engine.addPlugin({ link });
  });

  handle("moss:settings", () => engine.settings());
  handle("moss:bot-settings", (_w, a) => engine.botSettings(str(a.bot, 64) ?? ""));
  handle("moss:set-bot-setting", (w, a) => {
    const bot = str(a.bot, 64);
    const pluginId = str(a.pluginId, 200);
    const key = str(a.key, 128);
    if (bot === undefined || pluginId === undefined || key === undefined || !personPressed(w)) return false;
    return engine.setBotSetting(bot, pluginId, key, a.value ?? null);
  });
  handle("moss:set-level", (w, a) => {
    const computer = str(a.computer, 128);
    const level = str(a.level, 32);
    if (computer === undefined || level === undefined || !personPressed(w)) return false;
    return engine.setLevel(computer, level);
  });

  handle("moss:set-permission", (w, a) => {
    const server = str(a.server, 256);
    const tool = str(a.tool, 256);
    const permission = a.permission === "allow" || a.permission === "ask" || a.permission === "deny" ? a.permission : undefined;
    if (server === undefined || tool === undefined || permission === undefined || !personPressed(w)) return false;
    return engine.setPermission(server, tool, permission);
  });
  handle("moss:sign-in", async (w, a) => {
    const pluginId = str(a.pluginId, 200);
    const index = typeof a.index === "number" && Number.isInteger(a.index) && a.index >= 0 && a.index < 32 ? a.index : undefined;
    const key = typeof a.key === "string" && a.key.length > 0 && a.key.length <= 8192 ? a.key : undefined;
    if (pluginId === undefined || index === undefined) return { ok: false, why: "Not a sign-in." };
    if (!personPressed(w)) return { ok: false, why: "A sign-in starts only right after your own key press or click." };
    const r = await engine.signIn(pluginId, index, key);
    if ("authorizeUrl" in r && typeof r.authorizeUrl === "string") {
      // The browser sign-in's page opens in the person's own browser, from main; the window never sees the link.
      if (!headless && r.authorizeUrl.startsWith("https://")) void shell.openExternal(r.authorizeUrl);
      return { state: r.state };
    }
    return r;
  });
  handle("moss:sign-out", (w, a) => {
    const pluginId = str(a.pluginId, 200);
    const index = typeof a.index === "number" && Number.isInteger(a.index) && a.index >= 0 && a.index < 32 ? a.index : undefined;
    if (pluginId === undefined || index === undefined || !personPressed(w)) return false;
    return engine.signOut(pluginId, index);
  });
  handle("moss:bot-record", (_w, a) => engine.botRecord(str(a.id, 64) ?? ""));
  handle("moss:bot-instructions", (_w, a) => engine.botInstructions(str(a.id, 64) ?? ""));
  handle("moss:edit-bot", (w, a) => {
    const id = str(a.id, 64);
    const p = (a.patch ?? {}) as Record<string, unknown>;
    if (id === undefined || !personPressed(w)) return false;
    const patch: BotEdit = {};
    if (typeof p.name === "string" && p.name.trim() !== "") patch.name = p.name.trim().slice(0, 80);
    if (typeof p.instructions === "string") patch.instructions = p.instructions.slice(0, 200_000);
    for (const k of ["model", "effort"] as const) if (p[k] === null || typeof p[k] === "string") patch[k] = p[k] === null ? null : String(p[k]).slice(0, 200);
    if (p.face === null) patch.face = null;
    else if (p.face !== undefined) {
      // The record's own schema (four traits, the kit's names or a #rrggbb colour): anything else isn't sent.
      const face = ProtocolBotFace.safeParse(p.face);
      if (!face.success) return false;
      patch.face = face.data;
    }
    return engine.editBot(id, patch);
  });
  handle("moss:models", () => engine.models());
  handle("moss:archive-bot", (w, a) => {
    const id = str(a.id, 64);
    if (id === undefined || !personPressed(w)) return false;
    return engine.archiveBot(id);
  });
  handle("moss:archived-bots", () => engine.archivedBots());
  handle("moss:retry", (w, a) => {
    const bot = str(a.bot, 64);
    if (bot === undefined) return { ok: false, why: "No bot." };
    if (!personPressed(w)) return { ok: false, why: "Try again goes only right after your own click." };
    return engine.retry(bot);
  });
  handle("moss:restore-bot", (w, a) => {
    const id = str(a.id, 64);
    if (id === undefined || !personPressed(w)) return false;
    return engine.restoreBot(id);
  });
  // A bot's screen is watch only (§6.10): a click, key or scroll on it reaches nothing; main says so, and sends nothing.
  on("moss:picture-input", (_w, a) => {
    const kind = a.kind === "pointer" || a.kind === "key" || a.kind === "wheel" ? a.kind : "input";
    log(`picture: input refused (watch only): a ${kind} on the bot's screen reaches nothing`);
  });

  engine.onView((v) => {
    const w = mainWindow;
    if (w !== undefined && !w.isDestroyed()) w.webContents.send("moss:view", v);
    pushPresence();
  });
  engine.onMessage((bot, m) => mainWindow?.webContents.send("moss:message", bot, m));
  engine.onPictureFrame((f) => mainWindow?.webContents.send("moss:picture-frame", f));
}

// -------------------------------------------------------------------------------------------------
// The sealed frames' own channel (check 1 of press.ts; the rest is press.ts's)
// -------------------------------------------------------------------------------------------------

/** The sender is a sealed frame on its own token, bound as the mint said: its token and its binding key, or undefined. */
function sealedSender(event: IpcMainEvent | IpcMainInvokeEvent, token: unknown): { token: string; key: string; frame: string; windowId: number } | undefined {
  const f = event.senderFrame;
  const w = mainWindow;
  if (f === null || f.detached || w === undefined || w.isDestroyed() || event.sender !== w.webContents) return undefined;
  if (!f.url.startsWith(`${SEALED_SCHEME}://card/`)) return undefined;
  const t = str(token, 128);
  if (t === undefined || new URL(f.url).searchParams.get("token") !== t) return undefined;
  const key = f.parent !== null && !f.parent.detached ? `p:${f.parent.processId}:${f.parent.routingId}` : `m:${f.processId}:${f.routingId}`;
  if (sealed.boundOf(t) !== key) return undefined;
  return { token: t, key, frame: `${f.processId}:${f.routingId}`, windowId: w.id };
}

/** The tallest a card's frame grows (its own page's height, which it reports): high enough for a plugin's whole OK card,
 *  so its page never overflows its frame (a page that overflowed kept resizing and never read as ready); the list that
 *  holds a card (the conversation, the strip) scrolls instead. */
const CARD_MAX_HEIGHT = 4_000;

/** The OS-wide half of the overlap check (overlap.ts, R12): which of our programs' windows lies over the place the person
 *  just pressed in MOSS's window (another app's window never counts), named by which, or undefined. With no window list
 *  (Windows, Linux, a Mac without the add-on built) the in-page reading stands alone (said once). A headless run (a test's,
 *  among other runs' windows) counts its own windows only. MOSS has no surfaces of its own (no island, no pill). */
let windowList: WindowList | undefined | null = null;
let overlapUnread = false;
let overlapRead = false;
function osCoverOf(windowId: number, point: { x: number; y: number } | undefined): string | undefined {
  if (windowList === null) windowList = loadWindowList(join(here, "native", "screen.node"), log);
  const win = BrowserWindow.fromId(windowId);
  const id = win === null || win.isDestroyed() ? undefined : windowIdOfMediaSource(win.getMediaSourceId());
  if (windowList === undefined || win === null || id === undefined) {
    if (!overlapUnread) { overlapUnread = true; log(`overlap: the OS window list wasn't read for a press (${windowList === undefined ? "no window list here" : "no window id"}); the in-page check stands alone`); }
    return undefined;
  }
  const list = windowList;
  const content = win.getContentBounds();
  const above = list.above(id);
  const ours = (pid: number): boolean => pid === process.pid || (!headless && isOurProgram(list.bundleOf(pid)));
  const hit = pressCover({ point: point === undefined ? undefined : { x: content.x + point.x, y: content.y + point.y }, above, ours });
  if (!overlapRead) { overlapRead = true; log(`overlap: the OS window list read for a press (${above.length} above, ${above.filter((w) => w.pid === process.pid).length} of MOSS's own${headless ? "; headless: its own only" : ""}${point === undefined ? "; no point: a keyboard press" : ""})`); }
  if (hit === undefined) return undefined;
  return hit.pid === process.pid ? `one of MOSS's own windows (layer ${hit.layer})` : `another MOSS program's window (layer ${hit.layer})`;
}

function wireSealed(): void {
  ipcMain.on("moss:press-seen", (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    const f = frameKey(event.senderFrame);
    if (w !== null && f !== undefined) record.frameSaw(w.id, f);
  });
  ipcMain.handle("moss:sealed-answer", (event, a: { token?: unknown; option?: unknown; children?: unknown }) => {
    // The binding is the answer's own (the sender's parent frame), checked in the store; here the sender and its token.
    const f = event.senderFrame;
    const w = mainWindow;
    if (f === null || f.detached || w === undefined || event.sender !== w.webContents || !f.url.startsWith(`${SEALED_SCHEME}://card/`)) throw new Error("not a sealed frame");
    const t = str(a?.token, 128);
    if (t === undefined || new URL(f.url).searchParams.get("token") !== t) throw new Error("bad sealed answer");
    const key = f.parent !== null && !f.parent.detached ? `p:${f.parent.processId}:${f.parent.routingId}` : `m:${f.processId}:${f.routingId}`;
    const children = Array.isArray(a?.children) && a.children.every((c) => typeof c === "string") ? a.children as string[] : undefined;
    return answerPress({
      sealed, record, log,
      placementOf: (id) => engine.placementOf(id),
      standing,
      cover: osCoverOf,
      keyReady: (ms) => answerKey.ready(ms),
      signer: answerKey,
      device: () => device,
      answer: async (x) => {
        const client = connection.client;
        if (client === undefined) return { accepted: false, reason: "MOSS isn't connected to its engine" };
        return client.request<{ accepted: boolean; reason?: string }>("card.answer", x, 15_000);
      },
    }, { token: t, option: str(a?.option, 64), senderKey: key, frame: `${f.processId}:${f.routingId}`, windowId: w.id, ...(children !== undefined ? { children } : {}) });
  });
  ipcMain.on("moss:sealed-visible", (event, a: { token?: unknown; visible?: unknown }) => {
    const s = sealedSender(event, a?.token);
    if (s !== undefined && typeof a.visible === "boolean") sealed.markVisible(s.token, a.visible);
  });
  ipcMain.on("moss:sealed-fresh", (event, a: { token?: unknown; seen?: unknown }) => {
    const s = sealedSender(event, a?.token);
    if (s !== undefined && typeof a.seen === "boolean") sealed.noteFresh(s.token, a.seen);
  });
  ipcMain.on("moss:sealed-press", (event, a: { token?: unknown; what?: unknown }) => {
    const s = sealedSender(event, a?.token);
    if (s !== undefined && typeof a.what === "string") log(`sealed: press on ${sealed.cardOf(s.token) ?? "?"}: ${a.what.slice(0, 20)}`);
  });
  ipcMain.on("moss:sealed-size", (event, a: { token?: unknown; height?: unknown }) => {
    const s = sealedSender(event, a?.token);
    const cardId = s === undefined ? undefined : sealed.cardOf(s.token);
    if (cardId !== undefined && typeof a.height === "number" && Number.isFinite(a.height)) mainWindow?.webContents.send("moss:card-height", cardId, Math.max(60, Math.min(CARD_MAX_HEIGHT, Math.round(a.height))));
  });
  ipcMain.handle("moss:sealed-review", async (event, a: { token?: unknown; peek?: unknown }) => {
    const s = sealedSender(event, a?.token);
    const cardId = s === undefined ? undefined : sealed.cardOf(s.token);
    const client = connection.client;
    if (cardId === undefined || client === undefined) return { state: "failed", why: "This card can't be reviewed here." };
    return client.request("plugin.review", { card: cardId, ...(a.peek === true ? { peek: true } : {}) }, 15_000).catch(() => ({ state: "failed", why: "The review couldn't start." }));
  });
}

// -------------------------------------------------------------------------------------------------
// Start
// -------------------------------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", () => { if (!headless) void openWindow(); });
  // Closing the window only closes it; on macOS the app stays until quit, elsewhere it leaves. Neither stops any work.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" || headless) app.quit();
  });
  app.on("activate", () => { if (!headless) void openWindow(); });
  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (e) => e.preventDefault());
  });
  app.on("before-quit", () => {
    // Quitting MOSS stops nothing (§3.1, item 112): no pair.quit, no hand-over; the connection just closes.
    presence.stop();
    connection.stop();
  });
  void app.whenReady().then(async () => {
    if (headless) log("audio: muted (headless: every page muted)");
    startFrontSeam();
    windowSession = session.fromPartition(WINDOW_PARTITION);
    await hardenSession(windowSession);
    wireBridge();
    wireSealed();
    const win = await openWindow();
    // Where this copy is, under the home, before the first dial (a packaged run or a test build; a source run records nothing).
    if (app.isPackaged || testBuild) writeOwnRecord(home, { bundlePath: ownBundle(), release, carriesEngine: carriesEngine() }, log);
    void connection.start();
    if (testBuild && args.smoke !== undefined) void runSmoke({ win, engine, file: args.smoke, log, logLines, connection });
    else if (testBuild && args.render !== undefined) void runRender({ win, engine, dir: args.render, log, logLines });
  });
}

