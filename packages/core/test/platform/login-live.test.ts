import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveLoginOsDeps, logonTriggerState, windowsUserSid, type Runner, type TaskXmlWriter } from "../../src/platform/login/live";
import { startDaemonThroughOs } from "../../src/platform/login/start";
import { loginUnitPath, parkedPlistPath, renderSchtasksXml, type LoginSpec } from "../../src/platform/login/render";
import { appBundleOf, hasGraphicalSession, resolveAppLauncher } from "../../src/platform/pair/launch";

/** A runner that records each command and answers from a table of command prefixes. */
function recorder(answers: Array<[string | RegExp, boolean, string?]> = []) {
  const calls: string[] = [];
  const run: Runner = async (argv) => {
    const line = argv.join(" ");
    calls.push(line);
    const hit = answers.find(([m]) => (typeof m === "string" ? line.startsWith(m) : m.test(line)));
    return { ok: hit ? hit[1] : true, out: hit?.[2] ?? "" };
  };
  return { run, calls };
}

const noFile: TaskXmlWriter = () => ({ path: "/tmp/task.xml", cleanup() {} });

function spec(os: LoginSpec["os"]): LoginSpec {
  const home = mkdtempSync(join(tmpdir(), "clover-live-"));
  return { os, bin: "/opt/clover/clover-core", home: join(home, ".clover"), logsDir: join(home, "logs"), profile: "dist", homedir: home };
}

describe("live login commands (recorded, never run)", () => {
  test("macOS enable bootstraps only a job that isn't loaded, and never boots one out", async () => {
    const r = recorder([[/^launchctl print gui\/\d+\/com\./, false]]); // the session is there; the job isn't loaded
    const s = spec("darwin");
    await liveLoginOsDeps(r.run, noFile).register(s, { loginOn: true, tasks: [] });
    expect(r.calls.some((c) => c.startsWith(`launchctl bootstrap gui/`) && c.endsWith(loginUnitPath(s)!))).toBe(true);
    expect(r.calls.some((c) => c.includes("bootout"))).toBe(false);

    const loaded = recorder();
    await liveLoginOsDeps(loaded.run, noFile).register(s, { loginOn: true, tasks: [] });
    expect(loaded.calls.some((c) => c.includes("bootstrap"))).toBe(false); // already loaded: left running
  });

  test("macOS disable touches no running job", async () => {
    const r = recorder();
    await liveLoginOsDeps(r.run, noFile).register(spec("darwin"), { loginOn: false, tasks: [] });
    expect(r.calls).toEqual([]);
  });

  test("Linux enable starts now; disable never stops the running pair", async () => {
    const on = recorder();
    await liveLoginOsDeps(on.run, noFile).register(spec("linux"), { loginOn: true, tasks: [] });
    expect(on.calls).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now clover-core.service"]);
    const off = recorder();
    await liveLoginOsDeps(off.run, noFile).register(spec("linux"), { loginOn: false, tasks: [] });
    expect(off.calls).toEqual(["systemctl --user daemon-reload", "systemctl --user disable clover-core.service"]);
  });

  test("Linux query reads is-enabled's word, whatever its exit code", async () => {
    const q = async (out: string, ok: boolean) => liveLoginOsDeps(recorder([["systemctl --user is-enabled", ok, out]]).run, noFile).query(spec("linux"));
    expect(await q("enabled\n", true)).toBe("on");
    expect(await q("disabled\n", false)).toBe("off");
    expect(await q("Failed to get unit file state for clover-core.service: No such file or directory\n", false)).toBe("absent");
  });

  test("Windows registers each task from its XML, and remove ends and deletes both", async () => {
    const r = recorder();
    const deps = liveLoginOsDeps(r.run, noFile);
    await deps.register(spec("win32"), { loginOn: true, tasks: [{ name: "\\Clover\\clover-core", xml: "<x/>" }, { name: "\\Clover\\clover-app", xml: "<y/>" }] });
    expect(r.calls).toEqual([
      "schtasks /Create /F /TN \\Clover\\clover-core /XML /tmp/task.xml",
      "schtasks /Create /F /TN \\Clover\\clover-app /XML /tmp/task.xml",
    ]);
    const u = recorder();
    await liveLoginOsDeps(u.run, noFile).unregister(spec("win32"));
    expect(u.calls).toEqual([
      "schtasks /End /TN \\Clover\\clover-core", "schtasks /Delete /F /TN \\Clover\\clover-core",
      "schtasks /End /TN \\Clover\\clover-app", "schtasks /Delete /F /TN \\Clover\\clover-app",
    ]);
  });

  test("the Windows user's SID from whoami /user", async () => {
    const r = recorder([["whoami /user", true, '"clover-c-win\\someone","S-1-5-21-1111-2222-3333-1001"\r\n']]);
    expect(await windowsUserSid(r.run)).toBe("S-1-5-21-1111-2222-3333-1001");
    expect(await windowsUserSid(recorder([["whoami", false, ""]]).run)).toBeUndefined();
  });

  test("the logon trigger's state from schtasks /Query /XML, UTF-16 or not", () => {
    const s = spec("win32");
    expect(logonTriggerState(renderSchtasksXml(s, true))).toBe("on");
    expect(logonTriggerState(renderSchtasksXml(s, false))).toBe("off");
    expect(logonTriggerState(renderSchtasksXml(s, true).split("").join("\0"))).toBe("on");
    expect(logonTriggerState("<Task><Triggers><LogonTrigger><UserId>a</UserId></LogonTrigger></Triggers></Task>")).toBe("on");
    expect(logonTriggerState("<Task><Triggers /></Task>")).toBe("off");
  });
});

describe("starting the daemon through the OS", () => {
  test("macOS: kickstart, else bootstrap from the login item or the parked plist", async () => {
    const s = spec("darwin");
    const kick = recorder();
    expect(await startDaemonThroughOs(s, kick.run)).toBe("started");
    expect(kick.calls.at(-1)).toMatch(/^launchctl kickstart gui\/\d+\/com\.waifucave\.clover\.core$/);

    const unloaded = recorder([["launchctl kickstart", false]]);
    expect(await startDaemonThroughOs(s, unloaded.run)).toBe("not-installed");
    mkdirSync(join(s.home, "login"), { recursive: true });
    writeFileSync(parkedPlistPath(s), "<plist/>");
    expect(await startDaemonThroughOs(s, unloaded.run)).toBe("started");
    expect(unloaded.calls.at(-1)).toEndWith(parkedPlistPath(s));
  });

  test("Linux and Windows: start the unit or run the task; tell a missing one from a failure", async () => {
    expect(await startDaemonThroughOs(spec("linux"), recorder().run)).toBe("started");
    expect(await startDaemonThroughOs(spec("linux"), recorder([["systemctl --user start", false]]).run)).toBe("not-installed");
    const w = recorder();
    expect(await startDaemonThroughOs(spec("win32"), w.run)).toBe("started");
    expect(w.calls).toEqual(["schtasks /Run /TN \\Clover\\clover-core"]);
    expect(await startDaemonThroughOs(spec("win32"), recorder([["schtasks /Run", false]]).run)).toBe("failed");
    expect(await startDaemonThroughOs(spec("win32"), recorder([["schtasks", false]]).run)).toBe("not-installed");
  });
});

describe("the daemon's way to start the app", () => {
  test("macOS: the bundle from CLOVER_APP, or the one the daemon's binary sits in", async () => {
    expect(appBundleOf("/Applications/Clover.app/Contents/Resources/bin/clover-core")).toBe("/Applications/Clover.app");
    expect(appBundleOf("/usr/local/bin/clover-core")).toBeNull();
    const exists = (p: string) => p === "/Applications/Clover.app" || p === "/Users/u/Applications/Clover Dev.app";
    const inside = await resolveAppLauncher({ os: "darwin", profile: "dist", execPath: "/Applications/Clover.app/Contents/MacOS/clover-core", env: {}, exists }, recorder().run);
    expect(inside?.how).toBe("open -n -g -a /Applications/Clover.app");
    const r = recorder();
    const named = await resolveAppLauncher({ os: "darwin", profile: "dev", execPath: "/x/clover-core", env: { CLOVER_APP: "/Users/u/Applications/Clover Dev.app" }, exists }, r.run);
    expect(await named!.start()).toBe("started");
    expect(r.calls).toEqual(["open -n -g -a /Users/u/Applications/Clover Dev.app"]);
    expect(await resolveAppLauncher({ os: "darwin", profile: "dist", execPath: "/x/clover-core", env: {}, exists }, recorder().run)).toBeNull();
  });

  test("Linux: only with the app's unit installed, and not before the graphical session", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-app-"));
    const none = await resolveAppLauncher({ os: "linux", profile: "dist", execPath: "/x", env: {}, homedir: home, exists: () => false }, recorder().run);
    expect(none).toBeNull();
    const exists = (p: string) => p === "/usr/lib/systemd/user/clover-app.service";
    const early = recorder([["systemctl --user show-environment", true, "HOME=/home/u\nPATH=/usr/bin\n"]]);
    const l = await resolveAppLauncher({ os: "linux", profile: "dist", execPath: "/x", env: {}, homedir: home, exists }, early.run);
    expect(await l!.start()).toBe("not-ready");
    expect(early.calls.some((c) => c.startsWith("systemctl --user start"))).toBe(false);
    const up = recorder([["systemctl --user show-environment", true, "DISPLAY=:0\nHOME=/home/u\n"]]);
    const l2 = await resolveAppLauncher({ os: "linux", profile: "dist", execPath: "/x", env: {}, homedir: home, exists }, up.run);
    expect(await l2!.start()).toBe("started");
    expect(up.calls.at(-1)).toBe("systemctl --user start clover-app.service");
    expect(hasGraphicalSession("WAYLAND_DISPLAY=wayland-0\n")).toBe(true);
    expect(hasGraphicalSession("DISPLAY=\n")).toBe(false);
  });

  test("Windows: only with the app's task registered", async () => {
    expect(await resolveAppLauncher({ os: "win32", profile: "dist", execPath: "C:\\x", env: {} }, recorder([["schtasks /Query", false]]).run)).toBeNull();
    const r = recorder();
    const w = await resolveAppLauncher({ os: "win32", profile: "dist", execPath: "C:\\x", env: {} }, r.run);
    expect(await w!.start()).toBe("started");
    expect(r.calls.at(-1)).toBe("schtasks /Run /TN \\Clover\\clover-app");
  });
});
