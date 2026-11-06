// The login items, one per OS (pure generators, unit-tested):
//   macOS:   a launchd user agent — RunAtLoad, and KeepAlive {SuccessfulExit: false}: restarted after a crash or a
//            non-zero exit, never after a clean Quit
//   Linux:   a systemd --user unit — Restart=on-failure, WantedBy=default.target; plus an app unit the daemon starts,
//            so the app lives in its own cgroup and a daemon restart never takes it down
//   Windows: a Task Scheduler task — a logon trigger for this user, interactive token, least privilege, no time
//            limit, not stopped on battery, normal priority, restart on failure; plus an on-demand app task
import type { PairNames } from "./names.ts";

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function launchdPlist(n: PairNames, daemonBin: string, home: string, throttleSec = 1): string {
  const args = [daemonBin, "daemon", `--home=${home}`].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(n.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${throttleSec}</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLOVER_HOME</key>
    <string>${xml(home)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(`${n.logsDir}/daemon.out.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(`${n.logsDir}/daemon.err.log`)}</string>
</dict>
</plist>
`;
}

/** systemd quoting: one argument in double quotes, with \ and " escaped. */
function sq(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function systemdCoreUnit(n: PairNames, daemonBin: string, home: string): string {
  return `[Unit]
Description=Clover core (S7 spike ${n.suffix})

[Service]
Type=simple
ExecStart=${sq(daemonBin)} daemon ${sq(`--home=${home}`)}
Environment=${sq(`CLOVER_HOME=${home}`)}
Restart=on-failure
RestartSec=1

[Install]
WantedBy=default.target
`;
}

export function systemdAppUnit(n: PairNames, electron: string, appDir: string, home: string): string {
  return `[Unit]
Description=Clover app (S7 spike ${n.suffix})

[Service]
Type=simple
ExecStart=${sq(electron)} ${sq(appDir)} ${sq(`--home=${home}`)}
Environment=${sq(`CLOVER_HOME=${home}`)}
Restart=no
`;
}

/** Task Scheduler XML. `logon` adds the logon trigger and the restart-on-failure setting (the daemon's task). */
export function windowsTaskXml(opts: { user: string; command: string; args: string; description: string; logon: boolean; logonType?: "InteractiveToken" | "S4U" }): string {
  const triggers = opts.logon
    ? `  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(opts.user)}</UserId>
    </LogonTrigger>
  </Triggers>
`
    : "  <Triggers />\n";
  const restart = opts.logon
    ? `    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
`
    : "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(opts.description)}</Description>
  </RegistrationInfo>
${triggers}  <Principals>
    <Principal id="Author">
      <UserId>${xml(opts.user)}</UserId>
      <LogonType>${opts.logonType ?? "InteractiveToken"}</LogonType>
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
${restart}  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(opts.command)}</Command>
      <Arguments>${xml(opts.args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** The XDG autostart entry the app would install on Linux desktops (the app starts with the desktop session). */
export function xdgAutostart(electron: string, appDir: string, home: string): string {
  const q = (s: string) => `"${s.replace(/(["`$\\])/g, "\\$1")}"`;
  return `[Desktop Entry]
Type=Application
Name=Clover (S7 spike)
Exec=${q(electron)} ${q(appDir)} ${q(`--home=${home}`)}
X-GNOME-Autostart-enabled=true
NoDisplay=true
`;
}
