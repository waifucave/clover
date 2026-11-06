import { describe, expect, test } from "bun:test";
import { pairNames } from "../src/pair/names.ts";
import { launchdPlist, systemdAppUnit, systemdCoreUnit, windowsTaskXml, xdgAutostart } from "../src/pair/units.ts";

const n = pairNames("/home/u/.clover-dev", "linux");

describe("login items", () => {
  test("launchd: RunAtLoad, restart only after a crash", () => {
    const p = launchdPlist(n, "/Applications/Clover.app/Contents/MacOS/clover-core", "/Users/u/.clover-dev");
    expect(p).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(p).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(p).toContain(`<string>${n.label}</string>`);
    expect(p).toContain("<string>--home=/Users/u/.clover-dev</string>");
  });
  test("launchd escapes XML", () => {
    expect(launchdPlist(n, "/a&b/<c>", "/h")).toContain("/a&amp;b/&lt;c&gt;");
  });
  test("systemd: on-failure restart, default.target, quoted paths", () => {
    const u = systemdCoreUnit(n, "/opt/Clover Dev/clover-core", "/home/u/.clover-dev");
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("WantedBy=default.target");
    expect(u).toContain('ExecStart="/opt/Clover Dev/clover-core" daemon "--home=/home/u/.clover-dev"');
    expect(systemdAppUnit(n, "/opt/clover/clover", "/opt/clover/app", "/h")).toContain("Restart=no");
  });
  test("Task Scheduler: logon trigger, no time limit, not stopped on battery, normal priority", () => {
    const x = windowsTaskXml({ user: "PC\\u", command: "C:\\Clover\\clover-core.exe", args: 'daemon "--home=C:\\Users\\u\\.clover-dev"', description: "d", logon: true });
    expect(x).toContain("<LogonTrigger>");
    expect(x).toContain("<UserId>PC\\u</UserId>");
    expect(x).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(x).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(x).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(x).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(x).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(x).toContain("<Priority>5</Priority>");
    expect(x).toContain("<RestartOnFailure>");
    expect(x).toContain("&quot;--home=");
    const app = windowsTaskXml({ user: "u", command: "c", args: "", description: "d", logon: false });
    expect(app).not.toContain("<LogonTrigger>");
    expect(app).not.toContain("<RestartOnFailure>");
  });
  test("XDG autostart entry", () => {
    expect(xdgAutostart("/opt/clover/clover", "/opt/clover/app", "/home/u/.clover")).toContain('Exec="/opt/clover/clover" "/opt/clover/app" "--home=/home/u/.clover"');
  });
});
