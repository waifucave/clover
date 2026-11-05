// Starting the other half through the OS (spec §3.1): never as one's own child, so neither half's death or restart
// takes the other along.
//   the daemon:  launchctl kickstart (macOS) · systemctl --user start (Linux) · schtasks /Run (Windows)
//   the app:     open -a (Launch Services, macOS) · systemctl --user start of the app's unit (Linux) ·
//                schtasks /Run of the app's task, or a detached child, to compare (Windows)
// Plus installing, reading and removing the login items, for the runner. Works in Bun and in Electron's Node.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PairConfig, PairNames } from "./names.ts";
import { launchdPlist, systemdAppUnit, systemdCoreUnit, windowsTaskXml } from "./units.ts";

export interface OsResult { ok: boolean; how: string; code: number | null; out: string }

function run(cmd: string, args: string[], timeoutMs = 15_000): OsResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? ` ${r.error.message}` : ""}`.trim().slice(0, 2000);
  return { ok: r.status === 0, how: `${cmd} ${args.join(" ")}`, code: r.status, out };
}

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

let domain: string | undefined;
/** The launchd domain for user agents: the GUI session's (gui/<uid>) when there is one, else user/<uid>. */
export function launchdDomain(): string {
  if (domain === undefined) domain = run("launchctl", ["print", `gui/${uid()}`], 5000).ok ? `gui/${uid()}` : `user/${uid()}`;
  return domain;
}

export function plistPath(n: PairNames): string {
  return join(homedir(), "Library", "LaunchAgents", `${n.label}.plist`);
}

export function systemdDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
}

/** The .app bundle around an Electron executable (macOS). */
export function appBundleOf(electron: string): string {
  const i = electron.indexOf(".app/");
  return i < 0 ? electron : electron.slice(0, i + 4);
}

export function windowsUser(): string {
  const domain = process.env.USERDOMAIN ?? "";
  const user = process.env.USERNAME ?? "";
  return domain === "" ? user : `${domain}\\${user}`;
}

/** The app, started by the daemon (or by a user, with `asUser`), through the OS. */
export function startApp(cfg: PairConfig, n: PairNames, asUser = false): OsResult {
  const args = [cfg.appDir, `--home=${cfg.home}`];
  if (process.platform === "darwin") return run("open", ["-n", "-g", "-a", appBundleOf(cfg.electron), "--args", ...args]);
  if (process.platform === "linux") {
    if (!asUser) return run("systemctl", ["--user", "start", n.appUnit]);
    const child = spawn(cfg.electron, args, { detached: true, stdio: "ignore", env: { ...process.env, DISPLAY: cfg.display ?? process.env.DISPLAY ?? ":99" } });
    child.unref();
    return { ok: true, how: "spawn detached (as from a launcher)", code: 0, out: String(child.pid) };
  }
  if (!asUser && cfg.windowsAppStart === "task") return run("schtasks", ["/Run", "/TN", n.appTask]);
  const child = spawn(cfg.electron, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return { ok: true, how: "spawn detached", code: 0, out: String(child.pid) };
}

/** The daemon, started by the app through the OS. */
export function startDaemon(n: PairNames): OsResult {
  if (process.platform === "darwin") {
    const r = run("launchctl", ["kickstart", `${launchdDomain()}/${n.label}`]);
    if (r.ok || !existsSync(plistPath(n))) return r;
    return run("launchctl", ["bootstrap", launchdDomain(), plistPath(n)]);
  }
  if (process.platform === "linux") return run("systemctl", ["--user", "start", n.coreUnit]);
  return run("schtasks", ["/Run", "/TN", n.coreTask]);
}

/** Install the login item(s) and start the daemon the way a login would (RunAtLoad / enable --now / the task). */
export function installAndStart(cfg: PairConfig, n: PairNames, windowsLogon: "InteractiveToken" | "S4U" = "InteractiveToken"): OsResult[] {
  const steps: OsResult[] = [];
  mkdirSync(n.logsDir, { recursive: true });
  if (process.platform === "darwin") {
    const p = plistPath(n);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, launchdPlist(n, cfg.daemonBin, cfg.home));
    steps.push(run("plutil", ["-lint", p]));
    steps.push(run("launchctl", ["bootstrap", launchdDomain(), p]));
  } else if (process.platform === "linux") {
    const dir = systemdDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, n.coreUnit), systemdCoreUnit(n, cfg.daemonBin, cfg.home));
    writeFileSync(join(dir, n.appUnit), systemdAppUnit(n, cfg.electron, cfg.appDir, cfg.home));
    steps.push(run("systemctl", ["--user", "daemon-reload"]));
    if (cfg.display !== undefined) steps.push(run("systemctl", ["--user", "set-environment", `DISPLAY=${cfg.display}`]));
    steps.push(run("systemctl", ["--user", "enable", "--now", n.coreUnit]));
  } else {
    const user = windowsUser();
    const write = (file: string, text: string): void => { writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])); };
    const coreXml = join(cfg.home, "core-task.xml");
    const appXml = join(cfg.home, "app-task.xml");
    write(coreXml, windowsTaskXml({ user, command: cfg.daemonBin, args: `daemon "--home=${cfg.home}"`, description: "Clover core (S7 spike)", logon: true, logonType: windowsLogon }));
    write(appXml, windowsTaskXml({ user, command: cfg.electron, args: `"${cfg.appDir}" "--home=${cfg.home}"`, description: "Clover app (S7 spike)", logon: false, logonType: windowsLogon }));
    steps.push(run("schtasks", ["/Create", "/TN", n.coreTask, "/XML", coreXml, "/F"]));
    steps.push(run("schtasks", ["/Create", "/TN", n.appTask, "/XML", appXml, "/F"]));
    steps.push(run("schtasks", ["/Run", "/TN", n.coreTask]));
  }
  return steps;
}

/** Is the login item registered for the next login? */
export function registration(n: PairNames): OsResult {
  if (process.platform === "darwin") return run("launchctl", ["print", `${launchdDomain()}/${n.label}`]);
  if (process.platform === "linux") return run("systemctl", ["--user", "is-enabled", n.coreUnit]);
  return run("schtasks", ["/Query", "/TN", n.coreTask, "/XML"]);
}

/** The OS's view of the daemon's job (state, pid, restarts, last result). */
export function unitState(n: PairNames): OsResult {
  if (process.platform === "darwin") return run("launchctl", ["print", `${launchdDomain()}/${n.label}`]);
  if (process.platform === "linux") return run("systemctl", ["--user", "show", n.coreUnit, "-p", "ActiveState,SubState,MainPID,NRestarts,Result,ExecMainStatus"]);
  return run("schtasks", ["/Query", "/TN", n.coreTask, "/V", "/FO", "LIST"]);
}

export function uninstall(cfg: PairConfig, n: PairNames): OsResult[] {
  const steps: OsResult[] = [];
  if (process.platform === "darwin") {
    steps.push(run("launchctl", ["bootout", `${launchdDomain()}/${n.label}`]));
    rmSync(plistPath(n), { force: true });
  } else if (process.platform === "linux") {
    steps.push(run("systemctl", ["--user", "disable", "--now", n.coreUnit]));
    steps.push(run("systemctl", ["--user", "stop", n.appUnit]));
    rmSync(join(systemdDir(), n.coreUnit), { force: true });
    rmSync(join(systemdDir(), n.appUnit), { force: true });
    steps.push(run("systemctl", ["--user", "daemon-reload"]));
    steps.push(run("systemctl", ["--user", "reset-failed"]));
  } else {
    for (const t of [n.coreTask, n.appTask]) {
      steps.push(run("schtasks", ["/End", "/TN", t]));
      steps.push(run("schtasks", ["/Delete", "/TN", t, "/F"]));
    }
  }
  void cfg;
  return steps;
}

/** Kill a process hard (the crash). `tree` (Windows) takes its child processes too — right for the app's own
 *  Chromium helpers, wrong for the daemon, whose spawned app must be left to show whether it survives. */
export function killHard(pid: number, tree = false): OsResult {
  if (process.platform === "win32") return run("taskkill", ["/F", ...(tree ? ["/T"] : []), "/PID", String(pid)]);
  try {
    process.kill(pid, "SIGKILL");
    return { ok: true, how: `kill -9 ${pid}`, code: 0, out: "" };
  } catch (e) {
    return { ok: false, how: `kill -9 ${pid}`, code: 1, out: String(e) };
  }
}

export function alive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
