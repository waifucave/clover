// The spike's minimal Clover app (Electron main): just the pair's side, nothing else. No window — it lives in the
// menu bar or tray. One instance per user. It connects to the daemon and starts it through the OS when none
// answers; when the daemon goes away without saying so it reconnects, and starts it through the OS itself if the OS
// hasn't within 3 s; its Quit (the tray's menu) tells the daemon first and both stop. Everything it does is written
// to <home>/run/app.jsonl for the runner.
import { app, Menu, nativeImage, Tray } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pairNames } from "./names.ts";
import { Conn, dial } from "./ndjson.ts";
import { startDaemon } from "./oslaunch.ts";

const homeArg = process.argv.find((a) => a.startsWith("--home="))?.slice("--home=".length) ?? process.env.CLOVER_HOME ?? "";
const home = resolve(homeArg);
const n = pairNames(home);
mkdirSync(join(home, "run"), { recursive: true });

function note(event: string, extra: Record<string, unknown> = {}): void {
  appendFileSync(n.appLog, `${JSON.stringify({ t: Date.now(), pid: process.pid, event, ...extra })}\n`);
}

app.setPath("userData", join(home, "app-data"));
if (!app.requestSingleInstanceLock()) {
  note("second-instance-exit");
  app.exit(0);
}

let startedBy = "user";
let safeMode = false;
if (existsSync(n.appStartFile)) {
  try {
    const s = JSON.parse(readFileSync(n.appStartFile, "utf8")) as { by?: string; safeMode?: boolean; at?: number };
    if (Date.now() - (s.at ?? 0) < 60_000) { startedBy = s.by ?? "daemon"; safeMode = s.safeMode === true; }
  } catch { /* a torn file: a user start */ }
  rmSync(n.appStartFile, { force: true });
}
note("start", { startedBy, safeMode, argv: process.argv.slice(1) });

let conn: Conn | undefined;
let quitting = false;
let daemonQuitting = false;
let tray: Tray | undefined;

async function quitBoth(why: string): Promise<void> {
  quitting = true;
  note("quit", { why });
  const r = await conn?.request("pair.quit", { why }, 3000);
  note("quit-acked", { reply: r?.result ?? r?.error ?? null });
  app.exit(0);
}

async function connectOnce(): Promise<boolean> {
  const c = await dial(n.socket);
  if (c === undefined) return false;
  conn = c;
  c.onMessage = (m) => {
    if (m.method === "test.trayQuit") void quitBoth("tray");
    if (m.method === "pair.quitting") { daemonQuitting = true; note("daemon-quitting", { why: m.params?.why }); app.exit(0); }
  };
  c.onClose = () => {
    if (quitting || daemonQuitting) return;
    note("daemon-lost");
    void reconnect();
  };
  const r = await c.request("hello", { role: "app", pid: process.pid, startedBy, safeMode });
  note("connected", { daemon: r.result ?? null });
  return true;
}

async function reconnect(): Promise<void> {
  const lostAt = Date.now();
  let kicked = false;
  while (!quitting && Date.now() - lostAt < 180_000) {
    if (await connectOnce()) { note("reconnected", { afterMs: Date.now() - lostAt, kicked }); return; }
    if (!kicked && Date.now() - lostAt > 3000 && !existsSync(join(home, "run", "no-kick"))) {
      kicked = true;
      const r = startDaemon(n);
      note("start-daemon", { reason: "lost", ok: r.ok, how: r.how, out: r.out.slice(0, 300) });
    }
    await new Promise((res) => setTimeout(res, 500));
  }
}

async function firstConnect(): Promise<void> {
  if (await connectOnce()) return;
  const r = startDaemon(n);
  note("start-daemon", { reason: "none at start", ok: r.ok, how: r.how, out: r.out.slice(0, 300) });
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    await new Promise((res) => setTimeout(res, 300));
    if (await connectOnce()) return;
  }
  note("no-daemon");
}

app.on("window-all-closed", () => { /* no windows: keep running */ });
app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock?.hide();
  try {
    const icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVR42mNgoBH4jwNTpJkoQ/4TiSnSjNWQ/2TiUQOoaQDF0UiVhESVpEyVzEQSAADQgJtl5l/1yAAAAABJRU5ErkJggg==");
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("Clover (S7 spike)");
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "Quit Clover", click: () => void quitBoth("tray") }]));
    note("tray", { ok: true });
  } catch (e) {
    note("tray", { ok: false, error: String(e) });
  }
  void tray;
  await firstConnect();
});
