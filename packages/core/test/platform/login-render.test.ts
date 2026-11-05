import { describe, expect, test } from "bun:test";
import {
  renderLaunchdPlist, renderSystemdUnit, renderSchtasksXml, loginLabel, loginUnitPath,
  systemdUnitName, schtasksTaskName, type LoginSpec,
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
    expect(x).toContain("<key>ThrottleInterval</key>");
    expect(x).toContain("com.waifucave.clover.core");
    expect(x).not.toContain("CLOVER_PROFILE");
  });

  test("launchd dev carries CLOVER_PROFILE=dev and the dev label", () => {
    const x = renderLaunchdPlist(base({ profile: "dev" }));
    expect(x).toContain("<key>CLOVER_PROFILE</key><string>dev</string>");
    expect(x).toContain("com.waifucave.clover.core.dev");
  });

  test("systemd: ExecStart supervise, crash-only restart, home env", () => {
    const u = renderSystemdUnit(base({ os: "linux" }));
    expect(u).toContain("ExecStart=/opt/clover/clover-core supervise");
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("Environment=CLOVER_HOME=/home/x/.clover");
    expect(u).toContain("WantedBy=default.target");
  });

  test("schtasks: logon trigger, supervise, restart-on-failure recovers supervise", () => {
    const x = renderSchtasksXml(base({ os: "win32" }));
    expect(x).toContain("<LogonTrigger>");
    expect(x).toContain("<Arguments>supervise</Arguments>");
    expect(x).toContain("<RestartOnFailure>");
    expect(x).toContain("<Command>/opt/clover/clover-core</Command>");
  });

  test("unit paths and names per OS", () => {
    expect(loginUnitPath(base())).toBe("/home/x/Library/LaunchAgents/com.waifucave.clover.core.plist");
    expect(loginUnitPath(base({ os: "linux" }))).toBe("/home/x/.config/systemd/user/clover-core.service");
    expect(loginUnitPath(base({ os: "win32" }))).toBeNull();
    expect(systemdUnitName("dev")).toBe("clover-core-dev.service");
    expect(schtasksTaskName("dist")).toBe("\\Clover\\clover-core");
    expect(loginLabel("dev")).toBe("com.waifucave.clover.core.dev");
  });
});
