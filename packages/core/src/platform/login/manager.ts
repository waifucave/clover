// `clover-core autostart enable|disable|status` (and `remove`, for an uninstaller), one mechanism
// across the three OSes. The OS registration is injected, so a test drives the whole flow against a
// temp directory and a recording runner and never touches real launchd, systemd or Task Scheduler.
//
// `enable` writes the daemon's definition (and the app's, when `spec.app` is set) and turns the login
// trigger on; `disable` turns only the trigger off, so the running pair keeps running and either side
// can still start the other through the OS; `remove` stops and removes everything.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  appTaskName, appUnitPath, loginLabel, loginUnitPath, parkedPlistPath, renderAppSchtasksXml,
  renderAppSystemdUnit, renderLaunchdPlist, renderSchtasksXml, renderSystemdUnit, renderXdgAutostart,
  schtasksTaskName, systemdUnitName, xdgAutostartPath, type LoginSpec,
} from "./render";

/** `enabled`: starts at login. `disabled`: installed, startable on demand, not at login. */
export type LoginState = "enabled" | "disabled" | "not-installed";
export interface LoginStatus {
  readonly state: LoginState;
  /** The login item's file (macOS LaunchAgents plist, Linux unit); `null` on Windows. */
  readonly unitPath: string | null;
  /** The OS's own view (`query` is "on"): the job is loaded (macOS), the unit is enabled (Linux), the
   *  task's logon trigger is on (Windows). */
  readonly registered: boolean;
  readonly label: string;
}

/** A Task Scheduler definition to register (Windows). */
export interface TaskDef { readonly name: string; readonly xml: string }

/** How the manager touches the OS. The live set runs launchctl/systemctl/schtasks; tests pass fakes. */
export interface LoginOsDeps {
  /** After the files are written, make the OS see them and set the login trigger.
   *  macOS: bootstrap the job when login start is on and it is not loaded (which starts it).
   *  Linux: `daemon-reload`, then `enable --now` the daemon's unit, or `disable` it (no `--now`).
   *  Windows: `schtasks /Create /F /XML` each task. Returns false on failure. */
  register(spec: LoginSpec, opts: { readonly loginOn: boolean; readonly tasks: readonly TaskDef[] }): Promise<boolean>;
  /** Uninstall: stop and unregister everything (bootout / `disable --now` / `schtasks /Delete`). */
  unregister(spec: LoginSpec): Promise<void>;
  /** The OS's view: "on" when the job is loaded (macOS), the unit enabled (Linux) or the daemon's
   *  task has its logon trigger on (Windows); "off" when installed but not; "absent" otherwise. */
  query(spec: LoginSpec): Promise<"on" | "off" | "absent">;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function remove(path: string | null): void {
  if (path !== null && existsSync(path)) { try { rmSync(path); } catch { /* raced */ } }
}

/** Write the definitions for the OS, with the login trigger on or off. */
function writeDefinitions(spec: LoginSpec, loginOn: boolean): TaskDef[] {
  if (spec.os === "darwin") {
    const item = loginUnitPath(spec)!;
    const parked = parkedPlistPath(spec);
    write(loginOn ? item : parked, renderLaunchdPlist(spec));
    remove(loginOn ? parked : item);
    return [];
  }
  if (spec.os === "linux") {
    write(loginUnitPath(spec)!, renderSystemdUnit(spec));
    if (spec.app) {
      write(appUnitPath(spec)!, renderAppSystemdUnit(spec));
      if (loginOn) write(xdgAutostartPath(spec)!, renderXdgAutostart(spec));
    }
    if (!loginOn) remove(xdgAutostartPath(spec));
    return [];
  }
  const tasks: TaskDef[] = [{ name: schtasksTaskName(spec.profile), xml: renderSchtasksXml(spec, loginOn) }];
  if (spec.app) tasks.push({ name: appTaskName(spec.profile), xml: renderAppSchtasksXml(spec) });
  return tasks;
}

/** Turn login start on: write the definitions and register them. Idempotent. */
export async function loginEnable(spec: LoginSpec, os: LoginOsDeps): Promise<LoginStatus> {
  const tasks = writeDefinitions(spec, true);
  const ok = await os.register(spec, { loginOn: true, tasks });
  return { state: ok ? "enabled" : "disabled", unitPath: loginUnitPath(spec), registered: ok, label: loginLabel(spec.profile) };
}

/** Turn login start off, keeping the daemon startable on demand and the running pair running. */
export async function loginDisable(spec: LoginSpec, os: LoginOsDeps): Promise<LoginStatus> {
  const tasks = writeDefinitions(spec, false);
  await os.register(spec, { loginOn: false, tasks });
  return { state: "disabled", unitPath: loginUnitPath(spec), registered: false, label: loginLabel(spec.profile) };
}

/** Uninstall: stop and remove the daemon's and the app's units, tasks and entries. Idempotent. */
export async function loginRemove(spec: LoginSpec, os: LoginOsDeps): Promise<LoginStatus> {
  await os.unregister(spec);
  remove(loginUnitPath(spec));
  if (spec.os === "darwin") remove(parkedPlistPath(spec));
  remove(appUnitPath(spec));
  remove(xdgAutostartPath(spec));
  return { state: "not-installed", unitPath: loginUnitPath(spec), registered: false, label: loginLabel(spec.profile) };
}

/** Whether login start is on, off, or not installed. */
export async function loginStatus(spec: LoginSpec, os: LoginOsDeps): Promise<LoginStatus> {
  const unitPath = loginUnitPath(spec);
  const q = await os.query(spec);
  let state: LoginState;
  if (spec.os === "darwin") state = existsSync(unitPath!) ? "enabled" : existsSync(parkedPlistPath(spec)) ? "disabled" : "not-installed";
  else if (spec.os === "linux") state = !existsSync(unitPath!) ? "not-installed" : q === "on" ? "enabled" : "disabled";
  else state = q === "on" ? "enabled" : q === "off" ? "disabled" : "not-installed";
  return { state, unitPath, registered: q === "on", label: loginLabel(spec.profile) };
}

/** Read a written unit back (diagnostics/tests). */
export function readUnit(spec: LoginSpec): string | null {
  const path = loginUnitPath(spec);
  if (path === null || !existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/** macOS: the plist to bootstrap the daemon from, whichever of the login item and the parked copy
 *  exists; `null` when neither does. */
export function launchdPlistToLoad(spec: LoginSpec): string | null {
  const item = loginUnitPath(spec);
  if (item !== null && existsSync(item)) return item;
  const parked = parkedPlistPath(spec);
  return existsSync(parked) ? parked : null;
}

export { schtasksTaskName, systemdUnitName };
