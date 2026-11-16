import { describe, expect, test } from "bun:test";
import { parseProfileImagePath } from "../../src/platform/login/live";
import {
  renderLaunchdPlist, renderSystemdUnit, renderSchtasksXml, renderAppSystemdUnit, renderAppSchtasksXml,
  renderXdgAutostart, loginLabel, loginUnitPath, parkedPlistPath, appUnitPath, xdgAutostartPath,
  systemdUnitName, schtasksTaskName, appTaskName, appUnitName, systemdArg, schtasksFallback, schtasksFallbackProblem, type LoginSpec,
} from "../../src/platform/login/render";

const base = (over: Partial<LoginSpec> = {}): LoginSpec => ({
  os: "darwin", bin: "/opt/moss/moss-core", home: "/home/x/.moss",
  logsDir: "/home/x/.moss/logs", profile: "dist", homedir: "/home/x", ...over,
});

describe("login renderers run supervise, crash-only", () => {
  test("launchd: supervise, crash-only KeepAlive, throttle, no MOSS_PROFILE on dist", () => {
    const x = renderLaunchdPlist(base());
    expect(x).toContain("<string>supervise</string>");
    expect(x).not.toContain("<string>run</string>");
    expect(x).toContain("<key>SuccessfulExit</key><false/>");
    expect(x).toContain("<key>ThrottleInterval</key><integer>1</integer>");
    expect(x).toContain("com.waifucave.moss.core");
    expect(x).not.toContain("MOSS_PROFILE");
  });

  test("launchd dev carries MOSS_PROFILE=dev and the dev label", () => {
    const x = renderLaunchdPlist(base({ profile: "dev" }));
    expect(x).toContain("<key>MOSS_PROFILE</key><string>dev</string>");
    expect(x).toContain("com.waifucave.moss.core.dev");
  });

  test("launchd names the app bundle for the daemon to start, when the installer gave one", () => {
    expect(renderLaunchdPlist(base({ app: { bin: "/Applications/MOSS Code.app" } }))).toContain("<key>MOSS_APP</key><string>/Applications/MOSS Code.app</string>");
    expect(renderLaunchdPlist(base())).not.toContain("MOSS_APP");
  });

  test("systemd: ExecStart supervise, crash-only restart after 1 s, home env", () => {
    const u = renderSystemdUnit(base({ os: "linux" }));
    expect(u).toContain('ExecStart="/opt/moss/moss-core" supervise');
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("RestartSec=1");
    expect(u).toContain('Environment="MOSS_HOME=/home/x/.moss"');
    expect(u).toContain("WantedBy=default.target");
    expect(u).not.toContain("After=default.target"); // wanted by it; ordering after it would only delay
    expect(u).toContain("ConditionPathExists=/opt/moss/moss-core"); // inert once a root removal took the binary
  });

  test("systemd quoting keeps a path with spaces, quotes, % and $ one literal argument", () => {
    expect(systemdArg("/opt/My Apps/moss-core")).toBe('"/opt/My Apps/moss-core"');
    expect(systemdArg(String.raw`/a"b\c`)).toBe(String.raw`"/a\"b\\c"`);
    expect(systemdArg("/x/100%/$HOME")).toBe('"/x/100%%/$$HOME"');
    const u = renderSystemdUnit(base({ os: "linux", bin: "/opt/My Apps/moss-core", home: "/home/x/50% off/.moss" }));
    expect(u).toContain('ExecStart="/opt/My Apps/moss-core" supervise');
    expect(u).toContain('Environment="MOSS_HOME=/home/x/50%% off/.moss"');
    expect(u).toContain("ConditionPathExists=/opt/My Apps/moss-core");
  });

  test("the app's unit and XDG entry (Linux): own cgroup, no systemd restart, starts with the session", () => {
    const spec = base({ os: "linux", app: { bin: "/opt/moss-code/moss-code" } });
    const u = renderAppSystemdUnit(spec);
    expect(u).toContain('ExecStart="/opt/moss-code/moss-code"');
    expect(u).toContain("Restart=no"); // the daemon restarts it
    expect(u).toContain("PartOf=graphical-session.target");
    expect(u).not.toContain("[Install]"); // started on demand, never enabled
    expect(u).toContain("ConditionPathExists=/opt/moss-code/moss-code");
    const x = renderXdgAutostart(spec);
    expect(x).toContain("Exec=systemctl --user start moss-app.service");
    expect(x).toContain("Type=Application");
    expect(x).toContain("TryExec=/opt/moss-code/moss-code\n"); // the session skips the entry once the app is gone
    expect(renderXdgAutostart(base({ os: "linux", profile: "dev" }))).toContain("moss-app-dev.service");
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
    expect(x).toContain("<Command>/opt/moss/moss-core</Command>");
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
    const x = renderAppSchtasksXml(base({ os: "win32", app: { bin: "C:\\Program Files\\MOSS Code\\MOSS Code.exe" } }));
    expect(x).toContain("<Triggers />");
    expect(x).not.toContain("LogonTrigger");
    expect(x).toContain("<Command>C:\\Program Files\\MOSS Code\\MOSS Code.exe</Command>");
    expect(x).not.toContain("<Arguments>");
    expect(x).toContain(`<URI>${appTaskName("dist").replace(/\\/g, "\\")}</URI>`);
  });

  test("paths are XML-escaped in the plist and the task, and never use a tilde", () => {
    const spec = base({ bin: "/a&b/moss-core", home: "/home/x<y>/.moss", logsDir: "/home/x<y>/.moss/logs" });
    const plist = renderLaunchdPlist(spec);
    expect(plist).toContain("/a&amp;b/moss-core");
    expect(plist).toContain("/home/x&lt;y&gt;/.moss");
    expect(plist).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;|quot;)/);
    expect(plist).not.toContain("~");
    expect(renderSchtasksXml({ ...spec, os: "win32" })).toContain("<Command>/a&amp;b/moss-core</Command>");
  });

  test("unit paths and names per OS", () => {
    expect(loginUnitPath(base())).toBe("/home/x/Library/LaunchAgents/com.waifucave.moss.core.plist");
    expect(loginUnitPath(base({ os: "linux" }))).toBe("/home/x/.config/systemd/user/moss-core.service");
    expect(loginUnitPath(base({ os: "win32" }))).toBeNull();
    expect(systemdUnitName("dev")).toBe("moss-core-dev.service");
    expect(schtasksTaskName("dist")).toBe("\\MOSS\\moss-core");
    expect(loginLabel("dev")).toBe("com.waifucave.moss.core.dev");
    expect(parkedPlistPath(base())).toBe("/home/x/.moss/login/com.waifucave.moss.core.plist");
    expect(appUnitPath(base({ os: "linux" }))).toBe("/home/x/.config/systemd/user/moss-app.service");
    expect(appUnitPath(base())).toBeNull();
    expect(xdgAutostartPath(base({ os: "linux" }))).toBe("/home/x/.config/autostart/com.waifucave.moss.code.desktop");
    expect(xdgAutostartPath(base({ os: "linux", profile: "dev" }))).toBe("/home/x/.config/autostart/com.waifucave.moss.code.dev.desktop");
    expect(appUnitName("dev")).toBe("moss-app-dev.service");
  });
});

describe("login-start paths with control characters (review M4)", () => {
  test("a newline in the home or a binary is refused, never written into a unit", async () => {
    const { renderSystemdUnit, renderXdgAutostart, renderLaunchdPlist } = await import("../../src/platform/login/render");
    const base = { os: "linux" as const, profile: "dist" as const, bin: "/opt/moss/moss-core", home: "/home/me/.moss", userHome: "/home/me" };
    expect(() => renderSystemdUnit({ ...base, bin: "/opt/moss\nExecStartPre=/bin/evil" } as never)).toThrow(/control character/);
    expect(() => renderXdgAutostart({ ...base, app: { bin: "/opt/a\nExec=/bin/evil" } } as never)).toThrow(/control character/);
    expect(() => renderLaunchdPlist({ ...base, os: "darwin", home: "/Users/me/.clo\u0007ver" } as never)).toThrow(/control character/);
  });
});

test("a server's logon task (Windows) starts the binary if it is there, else its .old.exe copy, by existence alone", () => {
  const user = "C:\\Users\\R&D ^50% !team";
  const bin = `${user}\\.moss\\bin\\daemon\\moss-core.exe`;
  const old = `${user}\\.moss\\bin\\daemon\\moss-core.old.exe`;
  const xml = renderSchtasksXml({ os: "win32", bin, home: `${user}\\.moss`, logsDir: `${user}\\.moss\\logs`, profile: "dist", homedir: user, winUser: "S-1-5-21-1", fallbackBin: old });
  expect(xml).toContain("<Command>%SystemRoot%\\System32\\cmd.exe</Command>");
  // Only fixed file names reach cmd.exe (with /v:off); a crash or exit 78 of the binary never runs the old one.
  expect(xml).toContain("<Arguments>/d /v:off /s /c &quot;if exist .\\moss-core.exe (.\\moss-core.exe supervise) else if exist .\\moss-core.old.exe (.\\moss-core.old.exe supervise)&quot;</Arguments>");
  // The folder goes in the task's working directory, under %USERPROFILE%: a user name with & ^ % ! is never parsed.
  expect(xml).toContain("<WorkingDirectory>%USERPROFILE%\\.moss\\bin\\daemon</WorkingDirectory>");
  expect(xml).not.toContain("R&amp;D");
  // Without a fallback (the app's daemon, which the app updates), the binary itself, as before.
  expect(renderSchtasksXml({ os: "win32", bin, home: "h", logsDir: "l", profile: "dist" })).toContain(`<Command>${bin.replace(/&/g, "&amp;")}</Command>`);
  // Outside the profile, a folder with a % can't be written safely: refused, with why.
  expect(schtasksFallbackProblem("D:\\srv%x%\\daemon\\moss-core.exe", "D:\\srv%x%\\daemon\\moss-core.old.exe", user)).toContain("holds a %");
  expect(() => schtasksFallback("D:\\srv%x%\\daemon\\moss-core.exe", "D:\\srv%x%\\daemon\\moss-core.old.exe", user)).toThrow("holds a %");
  expect(schtasksFallbackProblem("D:\\srv & co\\daemon\\moss-core.exe", "D:\\srv & co\\daemon\\moss-core.old.exe", user)).toBeUndefined();
  expect(schtasksFallback("D:\\srv & co\\daemon\\moss-core.exe", "D:\\srv & co\\daemon\\moss-core.old.exe", user).workingDir).toBe("D:\\srv & co\\daemon");
  expect(schtasksFallbackProblem(bin, "C:\\elsewhere\\moss-core.old.exe", user)).toContain("isn't beside");
});

test("a server on a network share (UNC) is refused, with why", () => {
  expect(schtasksFallbackProblem("\\\\nas\\home\\a\\.moss\\bin\\daemon\\moss-core.exe", "\\\\nas\\home\\a\\.moss\\bin\\daemon\\moss-core.old.exe", "\\\\nas\\home\\a")).toContain("network share");
  expect(schtasksFallbackProblem("//nas/home/a/.moss/bin/daemon/moss-core.exe", "//nas/home/a/.moss/bin/daemon/moss-core.old.exe", "C:\\Users\\a")).toContain("network share");
});

test("the account's logon profile, from the registry's ProfileList, its variables expanded", () => {
  const out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\S-1-5-21-1\r\n    ProfileImagePath    REG_EXPAND_SZ    %SystemDrive%\\Users\\R&D ^50% !team\r\n\r\n";
  expect(parseProfileImagePath(out, { SYSTEMDRIVE: "D:" })).toBe("D:\\Users\\R&D ^50% !team");
  expect(parseProfileImagePath(out, {})).toBeUndefined();
  expect(parseProfileImagePath("    ProfileImagePath    REG_SZ    C:\\Users\\a\r\n", {})).toBe("C:\\Users\\a");
  expect(parseProfileImagePath("ERROR: The system was unable to find the specified registry key or value.", {})).toBeUndefined();
});
