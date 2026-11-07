// Login start on all three OSes (spec §3.1, plan §4 C M1). The core builds the mechanism; lane M's
// installers call `clover-core autostart enable|disable` to drive it. The OS starts `clover-core
// supervise` at login, not the daemon directly: Task Scheduler never restarts a crashed daemon, so
// `supervise` (same binary) is the restart loop, and the OS only (re)starts `supervise`. On a clean
// Quit it exits 0 and is not restarted until the next login, per §3.1.
//
// Each OS keeps two things apart: the daemon's definition, which lets either side of the pair start
// the other through the OS at any time (`launchctl kickstart`, `systemctl --user start`, `schtasks
// /Run`), and the login trigger, which is what `autostart disable` turns off. So turning login start
// off never stops the pair that is running, and never leaves the app unable to start the daemon.
//   macOS:   the plist in ~/Library/LaunchAgents is the login item; with login start off it is parked
//            in <home>/login/, from where it is bootstrapped on demand
//   Linux:   the unit file stays; `systemctl --user enable` / `disable` is the trigger
//   Windows: the task stays; its logon trigger is enabled or disabled
// The app's side, when the app is installed (`spec.app`): an on-demand unit (Linux) or task (Windows)
// the daemon starts it through, so the app never sits in the daemon's cgroup or job, and on Linux the
// XDG autostart entry that starts it with the desktop session. macOS needs neither: the daemon starts
// the app through Launch Services.
import { posix } from "node:path";
import { homedir as realHomedir } from "node:os";
import type { CloverProfile } from "../../profile";
import type { DaemonPlatform } from "../transport";

// macOS and Linux paths are POSIX whatever OS renders them (a test on Windows, say).
const join = posix.join;

/** What a login unit needs: the binary to run, the home it serves, the profile (dev carries
 *  `CLOVER_PROFILE`), and where its stdout/stderr go. `homedir` is injectable for hermetic tests. */
export interface LoginSpec {
  readonly os: DaemonPlatform;
  readonly bin: string;
  readonly home: string;
  readonly logsDir: string;
  readonly profile: CloverProfile;
  readonly homedir?: string;
  /** Windows: the account the logon trigger and the task belong to, as its SID (`windowsUserSid`).
   *  Without it the trigger would fire for any user's logon, which only an administrator may register. */
  readonly winUser?: string;
  /** The app, on a computer that runs it: its executable (macOS: the `.app` bundle). */
  readonly app?: { readonly bin: string };
  /** Windows, a server install: the binary the logon task falls back to when `bin` is missing or won't start
   *  (`<bin>.old`: a self-update's swap is two renames there, and a power cut between them leaves no `bin`). */
  readonly fallbackBin?: string;
}

/** The daemon's restart-loop subcommand; the login unit runs `<bin> supervise`. */
export const SUPERVISE_ARGS = ["supervise"] as const;

/** The reverse-DNS label, matching the Keychain service and the app (`com.waifucave.clover.core`,
 *  dev `.core.dev`). */
export function loginLabel(profile: CloverProfile): string {
  return profile === "dev" ? "com.waifucave.clover.core.dev" : "com.waifucave.clover.core";
}

/** The systemd user unit's file name. */
export function systemdUnitName(profile: CloverProfile): string {
  return profile === "dev" ? "clover-core-dev.service" : "clover-core.service";
}

/** The Task Scheduler task path (under a `\Clover` folder, one per profile). */
export function schtasksTaskName(profile: CloverProfile): string {
  return profile === "dev" ? "\\Clover\\clover-core-dev" : "\\Clover\\clover-core";
}

/** The app's on-demand systemd user unit (Linux). */
export function appUnitName(profile: CloverProfile): string {
  return profile === "dev" ? "clover-app-dev.service" : "clover-app.service";
}

/** The app's on-demand task (Windows). */
export function appTaskName(profile: CloverProfile): string {
  return profile === "dev" ? "\\Clover\\clover-app-dev" : "\\Clover\\clover-app";
}

function userHome(spec: Pick<LoginSpec, "homedir">): string {
  return spec.homedir ?? realHomedir();
}

/** `$XDG_CONFIG_HOME`, or `~/.config` (always the latter when `homedir` is injected, for tests). */
function xdgConfigHome(spec: Pick<LoginSpec, "homedir">): string {
  const env = process.env.XDG_CONFIG_HOME;
  return env && spec.homedir === undefined ? env : join(userHome(spec), ".config");
}

/** The systemd user unit directory this user writes to. */
export function systemdUserDir(spec: Pick<LoginSpec, "homedir">): string {
  return join(xdgConfigHome(spec), "systemd", "user");
}

/** The login item's file: the LaunchAgents plist (macOS) or the unit file (Linux); `null` on
 *  Windows, where Task Scheduler keeps the definition. */
export function loginUnitPath(spec: LoginSpec): string | null {
  if (spec.os === "darwin") return join(userHome(spec), "Library", "LaunchAgents", `${loginLabel(spec.profile)}.plist`);
  if (spec.os === "linux") return join(systemdUserDir(spec), systemdUnitName(spec.profile));
  return null;
}

/** macOS: where the daemon's plist is kept while login start is off (outside LaunchAgents, so launchd
 *  does not load it at login), and bootstrapped from when either side starts the daemon. */
export function parkedPlistPath(spec: Pick<LoginSpec, "home" | "profile">): string {
  return join(spec.home, "login", `${loginLabel(spec.profile)}.plist`);
}

/** Linux: the app's unit file. */
export function appUnitPath(spec: LoginSpec): string | null {
  return spec.os === "linux" ? join(systemdUserDir(spec), appUnitName(spec.profile)) : null;
}

/** Linux: the XDG autostart entry that starts the app with the desktop session (§3.1). */
export function xdgAutostartPath(spec: LoginSpec): string | null {
  if (spec.os !== "linux") return null;
  return join(xdgConfigHome(spec), "autostart", `${spec.profile === "dev" ? "com.waifucave.clover.dev" : "com.waifucave.clover"}.desktop`);
}

/** A path or value with a control character (a newline above all) would add lines to a unit or an entry
 *  (review M4): it is refused, never escaped. */
export function noControl(s: string): string {
  if (/[\x00-\x1f\x7f]/.test(s)) throw new Error("a login-start path may not hold a control character");
  return s;
}

function xmlEscape(s: string): string {
  return noControl(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One systemd command-line argument: double-quoted, with `\` and `"` escaped, `%` doubled (a
 *  specifier otherwise) and `$` doubled (a variable otherwise). Paths with spaces stay one argument. */
export function systemdArg(s: string): string {
  return `"${noControl(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/** A path as a unit-file value outside a command line (`ConditionPathExists=`): `%` doubled. */
function systemdPath(s: string): string {
  return noControl(s).replace(/%/g, "%%");
}

/** One `Environment=` assignment, quoted the same way (`$` is not expanded there). */
function systemdEnv(key: string, value: string): string {
  return `Environment="${noControl(`${key}=${value}`).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

/** A macOS LaunchAgent. `KeepAlive` is crash-only (`SuccessfulExit: false`), so a clean Quit holds
 *  until the next login (§3.1). `ThrottleInterval` 1: without it launchd waits up to 10 s before
 *  restarting a crashed job (S7 §5 measured a restart in 0.26–1.2 s with it). `CLOVER_APP` names the
 *  app bundle the daemon starts through Launch Services, when the installer gave one. */
export function renderLaunchdPlist(spec: LoginSpec): string {
  const vars: Array<[string, string]> = [["CLOVER_HOME", spec.home]];
  if (spec.profile === "dev") vars.push(["CLOVER_PROFILE", "dev"]);
  if (spec.app) vars.push(["CLOVER_APP", spec.app.bin]);
  const env = `<dict>${vars.map(([k, v]) => `<key>${k}</key><string>${xmlEscape(v)}</string>`).join("")}</dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${loginLabel(spec.profile)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(spec.bin)}</string>
    <string>${SUPERVISE_ARGS[0]}</string>
  </array>
  <key>EnvironmentVariables</key>
  ${env}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>1</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(join(spec.logsDir, "supervise.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(spec.logsDir, "supervise.err.log"))}</string>
</dict>
</plist>
`;
}

/** The daemon's `systemd --user` unit. `Restart=on-failure` is crash-only, matching launchd's
 *  `KeepAlive`, after 1 s as S7 measured (`supervise` restarts the daemon itself; this restarts
 *  `supervise`). `enable` hooks it to `default.target` (the login trigger); disabled, it can still be
 *  started with `systemctl --user start`. `ConditionPathExists` makes it inert once the binary is
 *  gone: a deb or rpm removal runs as root and can't reach the user's units (lane M). */
export function renderSystemdUnit(spec: LoginSpec): string {
  const env = [systemdEnv("CLOVER_HOME", spec.home)];
  if (spec.profile === "dev") env.push(systemdEnv("CLOVER_PROFILE", "dev"));
  return `[Unit]
Description=Clover daemon (clover-core)
ConditionPathExists=${systemdPath(spec.bin)}

[Service]
Type=simple
ExecStart=${systemdArg(spec.bin)} ${SUPERVISE_ARGS[0]}
${env.join("\n")}
Restart=on-failure
RestartSec=1

[Install]
WantedBy=default.target
`;
}

/** The app's `systemd --user` unit, started on demand by the daemon (`systemctl --user start`) and by
 *  the XDG autostart entry, so the app lives in its own cgroup and a daemon restart never takes it
 *  down (S7 §5). The daemon restarts it, so systemd does not; it stops with the graphical session. */
export function renderAppSystemdUnit(spec: LoginSpec): string {
  if (!spec.app) throw new Error("renderAppSystemdUnit needs spec.app");
  const env = [systemdEnv("CLOVER_HOME", spec.home)];
  if (spec.profile === "dev") env.push(systemdEnv("CLOVER_PROFILE", "dev"));
  return `[Unit]
Description=Clover app
ConditionPathExists=${systemdPath(spec.app.bin)}
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=${systemdArg(spec.app.bin)}
${env.join("\n")}
Restart=no
`;
}

/** The XDG autostart entry: starts the app's unit with the desktop session (§3.1: "On Linux the app
 *  … starts with the desktop session"). It names the unit, not the binary, so the app always runs in
 *  its own unit, the daemon's start of an app that is already running is a no-op, and no path needs
 *  Exec quoting. `TryExec` names the app, so the session skips the entry once the app is gone. */
export function renderXdgAutostart(spec: LoginSpec): string {
  // A Desktop Entry string value: backslash escaped; a leading space would need \s (an absolute path has none).
  const tryExec = spec.app ? `TryExec=${noControl(spec.app.bin).replace(/\\/g, "\\\\")}\n` : "";
  return `[Desktop Entry]
Type=Application
Name=${spec.profile === "dev" ? "Clover Dev" : "Clover"}
Comment=Starts Clover with the desktop session
${tryExec}Exec=systemctl --user start ${appUnitName(spec.profile)}
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

interface TaskXml {
  readonly description: string;
  readonly uri: string;
  readonly user: string | undefined;
  /** The logon trigger: on, present but disabled, or none (an on-demand task). */
  readonly logon: "on" | "off" | "none";
  readonly command: string;
  readonly args: string;
  /** The folder the command starts in (Task Scheduler expands `%VAR%` in it). */
  readonly workingDir?: string;
}

function renderTask(t: TaskXml): string {
  const userId = t.user ? `<UserId>${xmlEscape(t.user)}</UserId>` : "";
  const triggers = t.logon === "none"
    ? "  <Triggers />"
    : `  <Triggers>
    <LogonTrigger><Enabled>${t.logon === "on"}</Enabled>${userId}</LogonTrigger>
  </Triggers>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(t.description)}</Description>
    <URI>${xmlEscape(t.uri)}</URI>
  </RegistrationInfo>
${triggers}
  <Principals>
    <Principal id="Author">
      ${userId}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(t.command)}</Command>${t.args ? `
      <Arguments>${xmlEscape(t.args)}</Arguments>` : ""}${t.workingDir ? `
      <WorkingDirectory>${xmlEscape(t.workingDir)}</WorkingDirectory>` : ""}
    </Exec>
  </Actions>
</Task>
`;
}

/** The daemon's Task Scheduler definition for `schtasks /Create /XML`. A logon trigger for this user
 *  starts `supervise`, the daemon's restart loop: Task Scheduler's own restart on failure did not
 *  restart a killed task in S7 §5 (and cannot restart in under a minute), so it is not used. The
 *  defaults Task Scheduler gets wrong for a daemon are set explicitly: no time limit (default 72 h),
 *  not stopped or held back on battery, normal priority (5; the default 7 is below normal), and a
 *  second start ignored. With login start off the trigger stays but is disabled, so `schtasks /Run`
 *  still starts the daemon. */
export function renderSchtasksXml(spec: LoginSpec, loginOn = true): string {
  const fallback = spec.fallbackBin === undefined ? undefined : schtasksFallback(spec.bin, spec.fallbackBin, spec.homedir ?? realHomedir());
  return renderTask({
    description: `${spec.profile === "dev" ? "Clover (dev)" : "Clover"} daemon (clover-core supervise)`,
    uri: schtasksTaskName(spec.profile),
    user: spec.winUser,
    logon: loginOn ? "on" : "off",
    command: fallback?.command ?? spec.bin,
    args: fallback?.args ?? SUPERVISE_ARGS[0],
    ...(fallback ? { workingDir: fallback.workingDir } : {}),
  });
}

/** Windows path pieces, whatever OS renders them. */
const winDir = (p: string) => p.replace(/[\\/]+[^\\/]*$/, "");
const winBase = (p: string) => p.replace(/^.*[\\/]/, "");

/**
 * The logon task's command with a fallback (a server install on Windows, whose self-update swaps with two renames):
 * cmd.exe starts in the binary's folder and runs `.\<bin> supervise` when it is there, else `.\<fallback>
 * supervise` when that is. Only whether the file exists decides: a crash, or a refusal (exit 78), never runs the old
 * version. No path is ever parsed by cmd.exe (it has only the two fixed file names, with /v:off), so a folder name
 * with `&`, `^`, `!` or `%` is safe; the folder goes in the task's WorkingDirectory, written under `%USERPROFILE%`
 * when it lies in the user's profile, so a user name is never expanded. The one folder that can't be made safe, one
 * outside the profile holding a `%`, is refused with why (`schtasksFallbackProblem`), before anything is installed.
 */
export function schtasksFallback(bin: string, fallback: string, homedir: string): { command: string; args: string; workingDir: string } {
  const problem = schtasksFallbackProblem(bin, fallback, homedir);
  if (problem !== undefined) throw new Error(problem);
  const dir = winDir(bin), name = winBase(bin), old = winBase(fallback);
  const home = homedir.replace(/[\\/]+$/, "");
  const workingDir = dir.toLowerCase().startsWith(`${home.toLowerCase()}\\`) || dir.toLowerCase().startsWith(`${home.toLowerCase()}/`)
    ? `%USERPROFILE%${dir.slice(home.length).replace(/\//g, "\\")}`
    : dir;
  const run = `if exist .\\${name} (.\\${name} ${SUPERVISE_ARGS[0]}) else if exist .\\${old} (.\\${old} ${SUPERVISE_ARGS[0]})`;
  return { command: "%SystemRoot%\\System32\\cmd.exe", args: `/d /v:off /s /c "${run}"`, workingDir };
}

/** Why the logon task's fallback can't be written for these paths, or undefined. */
export function schtasksFallbackProblem(bin: string, fallback: string, homedir: string): string | undefined {
  if (/^[\\/]{2}/.test(bin)) return `${bin} is on a network share: a server installs on this computer's own disk (its logon task can start before the share is reachable, and a swap there isn't atomic)`;
  if (winDir(bin) !== winDir(fallback)) return `${fallback} isn't beside ${bin}`;
  for (const n of [winBase(bin), winBase(fallback)]) if (!/^[A-Za-z0-9._-]+$/.test(n)) return `${n}: not one of the daemon's file names`;
  const home = homedir.replace(/[\\/]+$/, "").toLowerCase();
  const dir = winDir(bin);
  const rest = dir.toLowerCase().startsWith(`${home}\\`) || dir.toLowerCase().startsWith(`${home}/`) ? dir.slice(home.length) : dir;
  if (rest.includes("%")) return `${dir} holds a %, which Task Scheduler would read as a variable: install the server under the user's profile (${homedir})`;
  return undefined;
}

/** The app's on-demand task (no trigger), which the daemon starts with `schtasks /Run`, so the app is
 *  never in the daemon's job object (S7 §5). */
export function renderAppSchtasksXml(spec: LoginSpec): string {
  if (!spec.app) throw new Error("renderAppSchtasksXml needs spec.app");
  return renderTask({
    description: `${spec.profile === "dev" ? "Clover (dev)" : "Clover"} app`,
    uri: appTaskName(spec.profile),
    user: spec.winUser,
    logon: "none",
    command: spec.app.bin,
    args: "",
  });
}
