// Login start on all three OSes (spec §3.1, plan §4 C M1). The core builds the mechanism; lane M's
// installers call the `clover-core login` command that drives it. The OS starts `clover-core
// supervise` at login, not the daemon directly: Task Scheduler never restarts a crashed daemon, so
// `supervise` (same binary) is the restart loop, and the OS only (re)starts `supervise` — on a
// clean Quit it exits 0 and is not restarted until the next login, per §3.1.
import { join } from "node:path";
import { homedir as realHomedir } from "node:os";
import type { CloverProfile } from "../../profile";
import type { DaemonPlatform } from "../transport";

/** What a login unit needs: the binary to run, the home it serves, the profile (dev carries
 *  `CLOVER_PROFILE`), and where its stdout/stderr go. `homedir` is injectable for hermetic tests. */
export interface LoginSpec {
  readonly os: DaemonPlatform;
  readonly bin: string;
  readonly home: string;
  readonly logsDir: string;
  readonly profile: CloverProfile;
  readonly homedir?: string;
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

/** Where the login unit's file lives, or `null` on Windows (Task Scheduler keeps it, not a file). */
export function loginUnitPath(spec: LoginSpec): string | null {
  const home = spec.homedir ?? realHomedir();
  if (spec.os === "darwin") return join(home, "Library", "LaunchAgents", `${loginLabel(spec.profile)}.plist`);
  if (spec.os === "linux") {
    const base = process.env.XDG_CONFIG_HOME && spec.homedir === undefined ? process.env.XDG_CONFIG_HOME : join(home, ".config");
    return join(base, "systemd", "user", systemdUnitName(spec.profile));
  }
  return null;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A macOS LaunchAgent. `KeepAlive` is crash-only (`SuccessfulExit: false`), so a clean Quit holds
 *  until the next login (§3.1); `ThrottleInterval` bounds a crash loop. */
export function renderLaunchdPlist(spec: LoginSpec): string {
  const env = spec.profile === "dev"
    ? `<dict><key>CLOVER_HOME</key><string>${xmlEscape(spec.home)}</string><key>CLOVER_PROFILE</key><string>dev</string></dict>`
    : `<dict><key>CLOVER_HOME</key><string>${xmlEscape(spec.home)}</string></dict>`;
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
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(join(spec.logsDir, "supervise.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(spec.logsDir, "supervise.err.log"))}</string>
</dict>
</plist>
`;
}

/** A `systemd --user` unit. `Restart=on-failure` is crash-only, matching launchd's `KeepAlive`. */
export function renderSystemdUnit(spec: LoginSpec): string {
  const env = [`Environment=CLOVER_HOME=${spec.home}`];
  if (spec.profile === "dev") env.push("Environment=CLOVER_PROFILE=dev");
  return `[Unit]
Description=Clover daemon (clover-core)
After=default.target

[Service]
Type=simple
ExecStart=${spec.bin} ${SUPERVISE_ARGS[0]}
${env.join("\n")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** A Task Scheduler definition for `schtasks /Create /XML`. A logon trigger starts `supervise`;
 *  `RestartOnFailure` recovers `supervise` itself (Task Scheduler does not supervise the daemon it
 *  spawns, which is why `supervise` runs the daemon's own restart loop). */
export function renderSchtasksXml(spec: LoginSpec): string {
  const cmd = xmlEscape(spec.bin);
  const envNote = spec.profile === "dev" ? "Clover (dev)" : "Clover";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${envNote} daemon (clover-core supervise)</Description>
    <URI>${xmlEscape(schtasksTaskName(spec.profile))}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
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
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${cmd}</Command>
      <Arguments>${SUPERVISE_ARGS[0]}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
