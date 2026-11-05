// `clover-core login enable|disable|status`, one mechanism across the three OSes. The OS-specific
// file write and registration are injected, so a test drives the whole flow against a temp
// directory and a recording runner and never touches real launchd, systemd or Task Scheduler.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  loginLabel, loginUnitPath, renderLaunchdPlist, renderSchtasksXml, renderSystemdUnit,
  schtasksTaskName, systemdUnitName, type LoginSpec,
} from "./render";

export type LoginState = "enabled" | "disabled";
export interface LoginStatus {
  readonly state: LoginState;
  /** The unit file on disk (macOS/Linux); `null` on Windows, where Task Scheduler holds it. */
  readonly unitPath: string | null;
  /** Whether the OS reports the unit registered (launchctl/systemctl/schtasks query). */
  readonly registered: boolean;
  readonly label: string;
}

/** How the manager touches the OS. The live set runs launchctl/systemctl/schtasks; tests pass fakes. */
export interface LoginOsDeps {
  /** Register the written unit with the OS (bootstrap / `systemctl --user enable --now` / `schtasks
   *  /Create`). `xml` is the Task Scheduler definition on Windows. Returns false on failure. */
  register(spec: LoginSpec, xml: string): Promise<boolean>;
  /** Remove the registration (bootout / disable / `schtasks /Delete`). Best-effort. */
  unregister(spec: LoginSpec): Promise<void>;
  /** Whether the OS currently has it registered. */
  isRegistered(spec: LoginSpec): Promise<boolean>;
}

/** Turn login start on: write the unit (macOS/Linux) and register it. Idempotent. */
export async function loginEnable(spec: LoginSpec, os: LoginOsDeps): Promise<LoginStatus> {
  const path = loginUnitPath(spec);
  if (path !== null) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, spec.os === "darwin" ? renderLaunchdPlist(spec) : renderSystemdUnit(spec));
  }
  const ok = await os.register(spec, spec.os === "win32" ? renderSchtasksXml(spec) : "");
  return { state: ok ? "enabled" : "disabled", unitPath: path, registered: ok, label: loginLabel(spec.profile) };
}

/** Turn login start off: unregister and remove the unit file. Idempotent. */
export async function loginDisable(spec: LoginSpec, os: LoginOsDeps): Promise<LoginStatus> {
  await os.unregister(spec);
  const path = loginUnitPath(spec);
  if (path !== null && existsSync(path)) { try { rmSync(path); } catch { /* raced */ } }
  return { state: "disabled", unitPath: path, registered: false, label: loginLabel(spec.profile) };
}

/** Report whether login start is on, by the OS registration and the unit file. */
export async function loginStatus(spec: LoginSpec, os: LoginOsDeps): Promise<LoginStatus> {
  const path = loginUnitPath(spec);
  const registered = await os.isRegistered(spec);
  const onDisk = path !== null && existsSync(path);
  return { state: registered || onDisk ? "enabled" : "disabled", unitPath: path, registered, label: loginLabel(spec.profile) };
}

/** Read a written unit back (diagnostics/tests). */
export function readUnit(spec: LoginSpec): string | null {
  const path = loginUnitPath(spec);
  if (path === null || !existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export { schtasksTaskName, systemdUnitName };
