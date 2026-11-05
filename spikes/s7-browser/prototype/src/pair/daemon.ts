#!/usr/bin/env bun
// The spike's minimal clover-core: just the pair (spec §3.1), nothing else.
//   clover-core-s7 daemon --home=<dir>   run (the login item runs this)
//   clover-core-s7 status --home=<dir>   print the pair's state
//   clover-core-s7 quit --home=<dir>     quit both halves (the daemon side's Quit)
// It holds an OS lock on its home for its life, listens on <home>/run/core.sock (a named pipe on Windows), starts the
// app through the OS when none is connected, restarts a crashed app with growing delays (safe mode after three crashes
// in two minutes), and on the app's Quit — told first — exits 0, so its login item does not restart it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, resolve } from "node:path";
import { takeLock, type HeldLock } from "./lock.ts";
import { pairNames, restartPlan, type PairConfig } from "./names.ts";
import { Conn, dial, type Msg } from "./ndjson.ts";
import { startApp, type OsResult } from "./oslaunch.ts";

const argv = process.argv.slice(1);
const command = argv.find((a) => a === "daemon" || a === "status" || a === "quit") ?? "daemon";
const homeArg = argv.find((a) => a.startsWith("--home="))?.slice("--home=".length) ?? process.env.CLOVER_HOME;
if (homeArg === undefined || homeArg === "") {
  console.error("clover-core-s7: --home=<dir> (or CLOVER_HOME) is required");
  process.exit(2);
}
const home = resolve(homeArg);
const n = pairNames(home);

function log(line: string): void {
  const text = `${new Date().toISOString()} [core ${process.pid}] ${line}`;
  console.log(text);
  try { mkdirSync(n.logsDir, { recursive: true }); appendFileSync(`${n.logsDir}/daemon.log`, `${text}\n`); } catch { /* logging only */ }
}

if (command === "status" || command === "quit") {
  const c = await dial(n.socket);
  if (c === undefined) { console.log(JSON.stringify({ running: false })); process.exit(1); }
  await c.request("hello", { role: "test", pid: process.pid });
  const r = await c.request(command === "status" ? "test.status" : "test.quitDaemon", {});
  console.log(JSON.stringify(r.result ?? r));
  c.close();
  process.exit(0);
}

// --- the daemon --------------------------------------------------------------------------------------------------
mkdirSync(dirname(n.lockFile), { recursive: true });
const taken = await takeLock(n.lockFile);
if ("busy" in taken) {
  log(`another daemon holds this home (${taken.detail}); exiting`);
  process.exit(0); // not a crash: the login item must not restart this one
}
const lock: HeldLock = taken;
const cfg = JSON.parse(readFileSync(n.configFile, "utf8")) as PairConfig;
const bootedAt = Date.now();
writeFileSync(n.pidFile, String(process.pid));
appendFileSync(n.bootsFile, `${JSON.stringify({ t: bootedAt, pid: process.pid, ppid: process.ppid })}\n`);
log(`up (lock: ${lock.kind}, ppid ${process.ppid})`);

interface AppState { conn: Conn; pid: number; startedBy: string; safeMode: boolean; connectedAt: number }
let app: AppState | undefined;
let appLeaving = false;
let quitting = false;
const crashes: number[] = [];
const appStarts: Array<{ at: number; safeMode: boolean; reason: string; result: OsResult }> = [];
let restartTimer: ReturnType<typeof setTimeout> | undefined;
const clients = new Set<Conn>();

function startAppNow(safeMode: boolean, reason: string): void {
  if (quitting || cfg.electron === "") return;
  writeFileSync(n.appStartFile, JSON.stringify({ by: "daemon", safeMode, reason, at: Date.now() }));
  const result = startApp(cfg, n);
  appStarts.push({ at: Date.now(), safeMode, reason, result });
  log(`started the app (${reason}${safeMode ? ", safe mode" : ""}): ${result.how} → ${result.ok ? "ok" : `failed ${result.code} ${result.out}`}`);
}

function status(): Record<string, unknown> {
  return {
    daemon: { pid: process.pid, ppid: process.ppid, bootedAt, lock: lock.kind },
    app: app === undefined ? null : { pid: app.pid, startedBy: app.startedBy, safeMode: app.safeMode, connectedAt: app.connectedAt, connected: !app.conn.closed },
    crashes,
    appStarts: appStarts.map((s) => ({ at: s.at, safeMode: s.safeMode, reason: s.reason, ok: s.result.ok, how: s.result.how, out: s.result.out.slice(0, 300) })),
    restartPending: restartTimer !== undefined,
  };
}

function shutdown(code: number, why: string): void {
  log(`exiting ${code}: ${why}`);
  quitting = true;
  for (const c of clients) c.send({ method: "pair.quitting", params: { why } });
  setTimeout(() => {
    try { server.close(); } catch { /* closing */ }
    if (process.platform !== "win32") rmSync(n.socket, { force: true });
    rmSync(n.pidFile, { force: true });
    lock.release();
    process.exit(code);
  }, 300);
}

function onMessage(c: Conn, m: Msg): void {
  const p = m.params ?? {};
  switch (m.method) {
    case "hello":
      if (p.role === "app") {
        if (restartTimer !== undefined) { clearTimeout(restartTimer); restartTimer = undefined; }
        app = { conn: c, pid: Number(p.pid), startedBy: String(p.startedBy ?? "user"), safeMode: p.safeMode === true, connectedAt: Date.now() };
        appLeaving = false;
        log(`app ${app.pid} connected (started by ${app.startedBy}${app.safeMode ? ", safe mode" : ""})`);
      }
      c.reply(m, { daemonPid: process.pid, bootedAt });
      return;
    case "pair.quit":
      // The app's Quit (the tray's, or ⌘Q): both stop. Reply first, then exit 0 so the login item leaves us down.
      c.reply(m, { ok: true });
      quitting = true;
      shutdown(0, `the app's Quit (${String(p.why ?? "")})`);
      return;
    case "app.leaving":
      appLeaving = true; // the app exits on purpose without quitting the pair (an update, say)
      c.reply(m, { ok: true });
      return;
    case "test.status":
      c.reply(m, status());
      return;
    case "test.trayQuit":
      app?.conn.send({ method: "test.trayQuit" });
      c.reply(m, { forwarded: app !== undefined });
      return;
    case "test.quitDaemon":
      c.reply(m, { ok: true });
      shutdown(0, "the daemon side's Quit");
      return;
    default:
      c.reply(m, { error: `unknown ${m.method}` });
  }
}

function onClose(c: Conn): void {
  clients.delete(c);
  if (app === undefined || app.conn !== c) return;
  const pid = app.pid;
  app = undefined;
  if (quitting) return;
  if (appLeaving) { log(`app ${pid} left on purpose`); appLeaving = false; return; }
  const now = Date.now();
  crashes.push(now);
  const plan = restartPlan(crashes, now);
  log(`app ${pid} went away without saying so: restart in ${plan.delayMs} ms${plan.safeMode ? " in safe mode" : ""}`);
  restartTimer = setTimeout(() => { restartTimer = undefined; startAppNow(plan.safeMode, "crash"); }, plan.delayMs);
}

if (process.platform !== "win32" && existsSync(n.socket)) rmSync(n.socket, { force: true }); // we hold the lock: it is stale
const server: Server = createServer((sock) => {
  const c = new Conn(sock);
  clients.add(c);
  c.onMessage = (m) => onMessage(c, m);
  c.onClose = () => onClose(c);
});
server.on("error", (e) => { log(`listen error: ${e.message}`); process.exit(1); });
server.listen(n.socket, () => log(`listening on ${n.socket}`));

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => shutdown(0, sig));

// At start (the login, or a restart after a crash): no app within the grace period → start one.
setTimeout(() => { if (app === undefined) startAppNow(false, "daemon start"); }, cfg.appGraceMs);
