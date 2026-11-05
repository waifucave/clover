// Clover's desktop app, the M-M0 skeleton: one main process and one window, enough for CI to build and launch
// an unsigned app on every OS. Lane E takes this over at E-M1 (the tray, the always-on pair with the daemon, the
// shell plugins). It connects to no daemon and writes nothing outside its own user-data folder.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, session } from "electron";
import { appIdentity, parseLaunchArgs, resolveAppProfile, SMOKE_PREFIX, WEB_PREFERENCES, windowOptions } from "./identity";

const identity = appIdentity(resolveAppProfile(process.env));
const args = parseLaunchArgs(process.argv);
const rendererDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "renderer");

// The name also names the user-data folder, so "Clover" and "Clover Dev" never share one.
app.setName(identity.productName);
if (process.platform === "win32") app.setAppUserModelId(identity.appId);

let window: BrowserWindow | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window === undefined) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("window-all-closed", () => app.quit());
  // No page of this app ever needs a permission, a new window or a navigation away.
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  void app.whenReady().then(open);
}

async function open(): Promise<void> {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const timeout = args.smoke ? setTimeout(() => report({ ok: false, reason: "the page did not load within 30 s" }), 30_000) : undefined;
  window = new BrowserWindow(windowOptions(identity));
  window.once("ready-to-show", () => window?.show());
  try {
    await window.loadFile(join(rendererDir, "index.html"));
  } catch (err) {
    if (args.smoke) report({ ok: false, reason: `the page failed to load: ${err instanceof Error ? err.message : String(err)}` });
    else throw err;
    return;
  }
  if (!args.smoke) return;
  clearTimeout(timeout);
  const rendererPid = window.webContents.getOSProcessId();
  report({
    ok: true,
    profile: identity.profile,
    appId: identity.appId,
    name: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    windows: BrowserWindow.getAllWindows().length,
    title: window.getTitle(),
    heading: await window.webContents.executeJavaScript("document.querySelector('h1')?.textContent ?? null", true),
    // What the window was opened with, and what its renderer really is: no Node inside the page, and (where the
    // OS reports it: macOS and Windows) an OS-sandboxed process.
    options: { sandbox: WEB_PREFERENCES.sandbox, contextIsolation: WEB_PREFERENCES.contextIsolation, nodeIntegration: WEB_PREFERENCES.nodeIntegration },
    rendererHasNoNode: await window.webContents.executeJavaScript("typeof require === 'undefined' && typeof process === 'undefined'", true),
    rendererSandboxed: app.getAppMetrics().find((m) => m.pid === rendererPid)?.sandboxed ?? null,
  });
}

/** The smoke run's answer: on stdout, and in `CLOVER_SMOKE_OUT` when set (a GUI process's stdout is not always
 *  wired up on Windows), then exit. */
function report(facts: Record<string, unknown>): void {
  const line = JSON.stringify(facts);
  const out = process.env.CLOVER_SMOKE_OUT;
  if (out !== undefined && out !== "") writeFileSync(out, `${line}\n`);
  process.stdout.write(`${SMOKE_PREFIX}${line}\n`);
  app.exit(facts.ok === true ? 0 : 1);
}
