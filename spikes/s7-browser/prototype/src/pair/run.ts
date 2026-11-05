#!/usr/bin/env bun
// Question 5: the app and daemon pair on this OS, end to end, with timings. CI only (it installs a login item and
// starts an app).
//   bun run src/pair/run.ts --daemon-bin=<compiled clover-core-s7> --electron=<electron executable>
//                           --app-dir=<out/pair/app> --out=<file> [--display=:99] [--windows-app-start=task|spawn]
// Steps: install the login item and start it as a login would → the daemon starts the app → a second daemon on the
// same home is refused by the lock → the app crashes (and again, three times in two minutes: safe mode) → the daemon
// crashes → the tray's Quit stops both, and they stay down → a user starts the app, which starts the daemon → the
// daemon side's Quit stops both → uninstall.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pairNames, type PairConfig } from "./names.ts";
import { dial } from "./ndjson.ts";
import { alive, installAndStart, killHard, registration, startApp, uninstall, unitState, type OsResult } from "./oslaunch.ts";
import { errorText, rounded, sleep } from "../shared/stats.ts";

if (process.env.CI !== "true" && process.env.S7_ALLOW_LOCAL !== "1") {
  console.error("pair: refusing to run here — it installs a login item and starts an app. It runs in CI.");
  process.exit(2);
}

function arg(name: string, fallback = ""): string {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a === undefined ? fallback : a.slice(p.length);
}
const outFile = resolve(arg("out", "out/results/pair.json"));
const home = mkdtempSync(join(tmpdir(), "clover-s7-pair-"));
const cfg: PairConfig = {
  home,
  daemonBin: resolve(arg("daemon-bin")),
  electron: resolve(arg("electron")),
  appDir: resolve(arg("app-dir")),
  appGraceMs: 2000,
  windowsAppStart: arg("windows-app-start", "task") === "spawn" ? "spawn" : "task",
  display: arg("display") || undefined,
};
const n = pairNames(home);
mkdirSync(join(home, "run"), { recursive: true });
writeFileSync(n.configFile, JSON.stringify(cfg, null, 2));

const started = Date.now();
const log = (s: string): void => console.log(`[pair ${((Date.now() - started) / 1000).toFixed(1)}s] ${s}`);
const steps: Array<Record<string, unknown>> = [];

interface Status {
  daemon: { pid: number; ppid: number; bootedAt: number; lock: string };
  app: null | { pid: number; startedBy: string; safeMode: boolean; connectedAt: number; connected: boolean };
  crashes: number[];
  appStarts: Array<{ at: number; safeMode: boolean; reason: string; ok: boolean; how: string; out: string }>;
}

async function status(): Promise<Status | undefined> {
  const c = await dial(n.socket, 500);
  if (c === undefined) return undefined;
  try {
    await c.request("hello", { role: "test", pid: process.pid }, 1000);
    const r = await c.request("test.status", {}, 1000);
    return r.result as Status | undefined;
  } finally {
    c.close();
  }
}

async function until<T>(f: () => Promise<T | undefined>, ms: number, every = 100): Promise<{ v?: T; ms: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await f().catch(() => undefined);
    if (v !== undefined) return { v, ms: Date.now() - t0 };
    await sleep(every);
  }
  return { ms: Date.now() - t0 };
}

function appEvents(since: number): Array<Record<string, unknown>> {
  if (!existsSync(n.appLog)) return [];
  return readFileSync(n.appLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => Number(e.t) >= since);
}

function short(r: OsResult): Record<string, unknown> {
  return { ok: r.ok, how: r.how, code: r.code, out: r.out.slice(0, 600) };
}

async function step(name: string, f: () => Promise<Record<string, unknown>>): Promise<void> {
  log(`step ${name}`);
  try {
    const r = await f();
    steps.push({ step: name, ...r });
    log(`  ${JSON.stringify(rounded(r, 0)).slice(0, 600)}`);
  } catch (e) {
    steps.push({ step: name, error: errorText(e) });
    log(`  ERROR ${errorText(e)}`);
  }
  write("running");
}

const appUp = async (notPid = 0, wantSafe?: boolean): Promise<Status | undefined> => {
  const s = await status();
  if (s?.app?.connected !== true || s.app.pid === notPid) return undefined;
  if (wantSafe !== undefined && s.app.safeMode !== wantSafe) return undefined;
  return s;
};

async function main(): Promise<void> {
  log(`home ${home}, daemon ${cfg.daemonBin}, electron ${cfg.electron}`);

  await step("login start", async () => {
    let t0 = Date.now();
    const install = installAndStart(cfg, n).map(short);
    let daemon = await until(status, 20_000);
    let windowsFallback: Record<string, unknown> | undefined;
    if (daemon.v === undefined && process.platform === "win32") {
      // "Run only when the user is logged on" needs an interactive session for this user; without one, try S4U
      // (runs in session 0, no desktop) so the restart semantics can still be measured.
      windowsFallback = { interactiveTokenFailed: short(unitState(n)), reregisteredAs: "S4U" };
      uninstall(cfg, n);
      t0 = Date.now();
      windowsFallback.install = installAndStart(cfg, n, "S4U").map(short);
      daemon = await until(status, 20_000);
    }
    const both = await until(() => appUp(), 30_000);
    const tBoth = Date.now() - t0;
    return {
      install,
      windowsFallback,
      daemonUpMs: daemon.v !== undefined ? daemon.ms : undefined,
      daemonUp: daemon.v !== undefined,
      appConnectedMs: both.v !== undefined ? tBoth : undefined,
      appStartedBy: both.v?.app?.startedBy,
      appStart: both.v?.appStarts.at(-1),
      daemonParent: both.v?.daemon.ppid,
      registeredForLogin: short(registration(n)),
    };
  });

  await step("second daemon on the same home", async () => {
    const t0 = Date.now();
    const r = spawnSync(cfg.daemonBin, ["daemon", `--home=${home}`], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    const s = await status();
    return { exitCode: r.status, ms: Date.now() - t0, said: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(-300), firstStillServing: s !== undefined };
  });

  await step("app crash", async () => {
    const s0 = await status();
    const pid = s0?.app?.pid ?? 0;
    const t0 = Date.now();
    const kill = short(killHard(pid, true));
    const back = await until(() => appUp(pid), 30_000);
    return { killed: pid, kill, restartedMs: back.v !== undefined ? back.ms : undefined, newPid: back.v?.app?.pid, startedBy: back.v?.app?.startedBy, safeMode: back.v?.app?.safeMode, how: back.v?.appStarts.at(-1)?.how, eventsSinceKill: appEvents(t0).map((e) => e.event) };
  });

  await step("app crash loop → safe mode", async () => {
    const rounds: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 2; i++) {
      const s0 = await status();
      const pid = s0?.app?.pid ?? 0;
      killHard(pid, true);
      const back = await until(() => appUp(pid), 45_000);
      rounds.push({ killed: pid, restartedMs: back.v !== undefined ? back.ms : undefined, safeMode: back.v?.app?.safeMode, crashesInDaemon: back.v?.crashes.length });
    }
    return { rounds, thirdRestartInSafeMode: rounds[1]?.safeMode === true };
  });

  const daemonCrash = async (osAlone: boolean): Promise<Record<string, unknown>> => {
    const noKick = join(home, "run", "no-kick");
    if (osAlone) writeFileSync(noKick, "the runner measures the OS's own restart");
    try {
      const s0 = await status();
      const dpid = s0?.daemon.pid ?? 0;
      const apid = s0?.app?.pid ?? 0;
      const t0 = Date.now();
      const kill = short(killHard(dpid, false));
      const back = await until(async () => { const s = await status(); return s !== undefined && s.daemon.pid !== dpid ? s : undefined; }, osAlone ? 150_000 : 60_000, 200);
      if (osAlone && back.v === undefined) {
        // the OS did not restart it: let the app do it, so the run goes on
        rmSync(noKick, { force: true });
      }
      const reconnected = await until(() => appUp(), 60_000);
      const ev = appEvents(t0);
      const kicked = ev.find((e) => e.event === "start-daemon");
      return {
        killed: dpid, kill, daemonBackMs: back.v !== undefined ? back.ms : undefined, newDaemonPid: back.v?.daemon.pid,
        appSurvived: alive(apid), appPidAfter: reconnected.v?.app?.pid, samePid: reconnected.v?.app?.pid === apid,
        appStartedTheDaemon: kicked !== undefined ? { atMs: Number(kicked.t) - t0, ok: kicked.ok, how: kicked.how } : false,
        appEvents: ev.map((e) => `${Number(e.t) - t0}ms ${String(e.event)}`),
        unit: short(unitState(n)),
      };
    } finally {
      rmSync(noKick, { force: true });
    }
  };
  await step("daemon crash, restarted by the OS alone", () => daemonCrash(true));
  await step("daemon crash, the app helps after 3 s", () => daemonCrash(false));

  await step("tray Quit stops both, and they stay down", async () => {
    const s0 = await status();
    const dpid = s0?.daemon.pid ?? 0, apid = s0?.app?.pid ?? 0;
    const c = await dial(n.socket);
    await c?.request("hello", { role: "test", pid: process.pid });
    const t0 = Date.now();
    const fwd = await c?.request("test.trayQuit", {});
    c?.close();
    const down = await until(async () => (!alive(dpid) && !alive(apid) && (await status()) === undefined ? true : undefined), 15_000);
    let restarted = false;
    for (let i = 0; i < 12; i++) { await sleep(1000); if ((await status()) !== undefined) { restarted = true; break; } }
    return { forwarded: fwd?.result, bothDownMs: down.v ? down.ms : undefined, restartedWithin12s: restarted, appEvents: appEvents(t0).map((e) => String(e.event)), unit: short(unitState(n)) };
  });

  await step("a user starts the app → it starts the daemon", async () => {
    const t0 = Date.now();
    const r = short(startApp(cfg, n, true));
    const both = await until(() => appUp(), 45_000);
    const ev = appEvents(t0);
    return { start: r, bothUpMs: both.v !== undefined ? both.ms : undefined, startedBy: both.v?.app?.startedBy, appStartedTheDaemon: ev.filter((e) => e.event === "start-daemon").map((e) => ({ ok: e.ok, how: e.how, out: e.out })), appEvents: ev.map((e) => String(e.event)) };
  });

  await step("the daemon side's Quit stops both", async () => {
    const s0 = await status();
    const dpid = s0?.daemon.pid ?? 0, apid = s0?.app?.pid ?? 0;
    const c = await dial(n.socket);
    await c?.request("hello", { role: "test", pid: process.pid });
    await c?.request("test.quitDaemon", {});
    c?.close();
    const down = await until(async () => (!alive(dpid) && !alive(apid) ? true : undefined), 15_000);
    let restarted = false;
    for (let i = 0; i < 8; i++) { await sleep(1000); if ((await status()) !== undefined) { restarted = true; break; } }
    return { bothDownMs: down.v ? down.ms : undefined, restartedWithin8s: restarted };
  });
}

function write(state: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  const daemonLog = existsSync(join(n.logsDir, "daemon.log")) ? readFileSync(join(n.logsDir, "daemon.log"), "utf8").split("\n").slice(-80) : [];
  writeFileSync(outFile, JSON.stringify(rounded({
    meta: { state, platform: process.platform, arch: process.arch, osRelease: release(), seconds: (Date.now() - started) / 1000, names: n, windowsAppStart: cfg.windowsAppStart },
    steps,
    daemonLog,
  }, 0), null, 2));
}

try {
  await main();
} finally {
  log("uninstall");
  const u = uninstall(cfg, n).map(short);
  steps.push({ step: "uninstall", results: u });
  // anything left (the runner never leaves a process behind)
  for (const e of appEvents(0)) if (typeof e.pid === "number" && alive(e.pid)) killHard(e.pid, true);
  write("done");
  rmSync(home, { recursive: true, force: true });
  log("done");
}
process.exit(0);
