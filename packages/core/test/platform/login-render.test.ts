import { describe, expect, test } from "bun:test";
import {
  renderLaunchdPlist, renderSystemdUnit, renderSchtasksXml, renderAppSystemdUnit, renderAppSchtasksXml,
  renderXdgAutostart, loginLabel, loginUnitPath, parkedPlistPath, appUnitPath, xdgAutostartPath,
  systemdUnitName, schtasksTaskName, appTaskName, appUnitName, systemdArg, type LoginSpec,
} from "../../src/platform/login/render";

const base = (over: Partial<LoginSpec> = {}): LoginSpec => ({
  os: "darwin", bin: "/opt/clover/clover-core", home: "/home/x/.clover",
  logsDir: "/home/x/.clover/logs", profile: "dist", homedir: "/home/x", ...over,
});

describe("login renderers run supervise, crash-only", () => {
  test("launchd: supervise, crash-only KeepAlive, throttle, no CLOVER_PROFILE on dist", () => {
    const x = renderLaunchdPlist(base());
    expect(x).toContain("<string>supervise</string>");
    expect(x).not.toContain("<string>run</string>");
    expect(x).toContain("<key>SuccessfulExit</key><false/>");
    expect(x).toContain("<key>ThrottleInterval</key><integer>1</integer>");
    expect(x).toContain("com.waifucave.clover.core");
    expect(x).not.toContain("CLOVER_PROFILE");
  });

  test("launchd dev carries CLOVER_PROFILE=dev and the dev label", () => {
    const x = renderLaunchdPlist(base({ profile: "dev" }));
    expect(x).toContain("<key>CLOVER_PROFILE</key><string>dev</string>");
    expect(x).toContain("com.waifucave.clover.core.dev");
  });

  test("launchd names the app bundle for the daemon to start, when the installer gave one", () => {
    expect(renderLaunchdPlist(base({ app: { bin: "/Applications/Clover.app" } }))).toContain("<key>CLOVER_APP</key><string>/Applications/Clover.app</string>");
    expect(renderLaunchdPlist(base())).not.toContain("CLOVER_APP");
  });

  test("systemd: ExecStart supervise, crash-only restart after 1 s, home env", () => {
    const u = renderSystemdUnit(base({ os: "linux" }));
    expect(u).toContain('ExecStart="/opt/clover/clover-core" supervise');
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("RestartSec=1");
    expect(u).toContain('Environment="CLOVER_HOME=/home/x/.clover"');
    expect(u).toContain("WantedBy=default.target");
    expect(u).not.toContain("After=default.target"); // wanted by it; ordering after it would only delay
    expect(u).toContain("ConditionPathExists=/opt/clover/clover-core"); // inert once a root removal took the binary
  });

  test("systemd quoting keeps a path with spaces, quotes, % and $ one literal argument", () => {
    expect(systemdArg("/opt/My Apps/clover-core")).toBe('"/opt/My Apps/clover-core"');
    expect(systemdArg(String.raw`/a"b\c`)).toBe(String.raw`"/a\"b\\c"`);
    expect(systemdArg("/x/100%/$HOME")).toBe('"/x/100%%/$$HOME"');
    const u = renderSystemdUnit(base({ os: "linux", bin: "/opt/My Apps/clover-core", home: "/home/x/50% off/.clover" }));
    expect(u).toContain('ExecStart="/opt/My Apps/clover-core" supervise');
    expect(u).toContain('Environment="CLOVER_HOME=/home/x/50%% off/.clover"');
    expect(u).toContain("ConditionPathExists=/opt/My Apps/clover-core");
  });

  test("the app's unit and XDG entry (Linux): own cgroup, no systemd restart, starts with the session", () => {
    const spec = base({ os: "linux", app: { bin: "/opt/Clover/clover" } });
    const u = renderAppSystemdUnit(spec);
    expect(u).toContain('ExecStart="/opt/Clover/clover"');
    expect(u).toContain("Restart=no"); // the daemon restarts it
    expect(u).toContain("PartOf=graphical-session.target");
    expect(u).not.toContain("[Install]"); // started on demand, never enabled
    expect(u).toContain("ConditionPathExists=/opt/Clover/clover");
    const x = renderXdgAutostart(spec);
    expect(x).toContain("Exec=systemctl --user start clover-app.service");
    expect(x).toContain("Type=Application");
    expect(x).toContain("TryExec=/opt/Clover/clover\n"); // the session skips the entry once the app is gone
    expect(renderXdgAutostart(base({ os: "linux", profile: "dev" }))).toContain("clover-app-dev.service");
  });

  test("schtasks: logon trigger, supervise, and the defaults overridden for a daemon (S7 §5)", () => {
    const x = renderSchtasksXml(base({ os: "win32" }));
    expect(x).toContain("<LogonTrigger>");
    expect(x).toContain("<Arguments>supervise</Arguments>");
    expect(x).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(x).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(x).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(x).toContain("<Priority>5</Priority>");
    expect(x).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(x).not.toContain("<RestartOnFailure>"); // measured not to fire; supervise restarts
    expect(x).toContain("<Command>/opt/clover/clover-core</Command>");
    expect(x).toContain("<AllowStartOnDemand>true</AllowStartOnDemand>"); // the app's schtasks /Run
  });

  test("schtasks: the trigger and the principal name this user, so a standard user can register it", () => {
    const x = renderSchtasksXml(base({ os: "win32", winUser: "PC\\ana" }));
    expect(x).toMatch(/<LogonTrigger><Enabled>true<\/Enabled><UserId>PC\\ana<\/UserId><\/LogonTrigger>/);
    expect(x).toMatch(/<Principal id="Author">\s*<UserId>PC\\ana<\/UserId>/);
  });

  test("schtasks with login start off keeps the task, its trigger disabled", () => {
    const x = renderSchtasksXml(base({ os: "win32" }), false);
    expect(x).toContain("<LogonTrigger><Enabled>false</Enabled>");
  });

  test("the app's task (Windows) is on demand, with no trigger", () => {
    const x = renderAppSchtasksXml(base({ os: "win32", app: { bin: "C:\\Program Files\\Clover\\Clover.exe" } }));
    expect(x).toContain("<Triggers />");
    expect(x).not.toContain("LogonTrigger");
    expect(x).toContain("<Command>C:\\Program Files\\Clover\\Clover.exe</Command>");
    expect(x).not.toContain("<Arguments>");
    expect(x).toContain(`<URI>${appTaskName("dist").replace(/\\/g, "\\")}</URI>`);
  });

  test("paths are XML-escaped in the plist and the task, and never use a tilde", () => {
    const spec = base({ bin: "/a&b/clover-core", home: "/home/x<y>/.clover", logsDir: "/home/x<y>/.clover/logs" });
    const plist = renderLaunchdPlist(spec);
    expect(plist).toContain("/a&amp;b/clover-core");
    expect(plist).toContain("/home/x&lt;y&gt;/.clover");
    expect(plist).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;|quot;)/);
    expect(plist).not.toContain("~");
    expect(renderSchtasksXml({ ...spec, os: "win32" })).toContain("<Command>/a&amp;b/clover-core</Command>");
  });

  test("unit paths and names per OS", () => {
    expect(loginUnitPath(base())).toBe("/home/x/Library/LaunchAgents/com.waifucave.clover.core.plist");
    expect(loginUnitPath(base({ os: "linux" }))).toBe("/home/x/.config/systemd/user/clover-core.service");
    expect(loginUnitPath(base({ os: "win32" }))).toBeNull();
    expect(systemdUnitName("dev")).toBe("clover-core-dev.service");
    expect(schtasksTaskName("dist")).toBe("\\Clover\\clover-core");
    expect(loginLabel("dev")).toBe("com.waifucave.clover.core.dev");
    expect(parkedPlistPath(base())).toBe("/home/x/.clover/login/com.waifucave.clover.core.plist");
    expect(appUnitPath(base({ os: "linux" }))).toBe("/home/x/.config/systemd/user/clover-app.service");
    expect(appUnitPath(base())).toBeNull();
    expect(xdgAutostartPath(base({ os: "linux" }))).toBe("/home/x/.config/autostart/com.waifucave.clover.desktop");
    expect(xdgAutostartPath(base({ os: "linux", profile: "dev" }))).toBe("/home/x/.config/autostart/com.waifucave.clover.dev.desktop");
    expect(appUnitName("dev")).toBe("clover-app-dev.service");
  });
});
