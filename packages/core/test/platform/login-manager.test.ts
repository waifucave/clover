import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchdPlistToLoad, loginDisable, loginEnable, loginRemove, loginStatus, type LoginOsDeps, type TaskDef } from "../../src/platform/login/manager";
import { appUnitPath, loginUnitPath, parkedPlistPath, xdgAutostartPath, type LoginSpec } from "../../src/platform/login/render";

function fakeOs() {
  const calls: Array<{ op: string; loginOn?: boolean; tasks?: readonly TaskDef[] }> = [];
  let state: "on" | "off" | "absent" = "absent";
  const os: LoginOsDeps = {
    async register(_s, o) { calls.push({ op: "register", loginOn: o.loginOn, tasks: o.tasks }); state = o.loginOn ? "on" : "off"; return true; },
    async unregister() { calls.push({ op: "unregister" }); state = "absent"; },
    async query() { return state; },
  };
  return { os, calls };
}

function spec(os: "darwin" | "linux" | "win32", app = false): LoginSpec {
  const home = mkdtempSync(join(tmpdir(), "clover-login-"));
  return {
    os, bin: "/opt/clover/clover-core", home: join(home, ".clover"), logsDir: join(home, ".clover/logs"), profile: "dist", homedir: home,
    ...(app ? { app: { bin: os === "darwin" ? "/Applications/Clover.app" : "/opt/Clover/clover" } } : {}),
  };
}

describe("login manager", () => {
  test("macOS: enable writes the login item; disable parks it, so the daemon stays startable", async () => {
    const s = spec("darwin");
    const f = fakeOs();
    expect((await loginEnable(s, f.os)).state).toBe("enabled");
    expect(readFileSync(loginUnitPath(s)!, "utf8")).toContain("<string>supervise</string>");
    expect(launchdPlistToLoad(s)).toBe(loginUnitPath(s));
    expect((await loginStatus(s, f.os)).state).toBe("enabled");

    await loginDisable(s, f.os);
    expect(existsSync(loginUnitPath(s)!)).toBe(false); // launchd won't load it at login
    expect(existsSync(parkedPlistPath(s))).toBe(true);
    expect(launchdPlistToLoad(s)).toBe(parkedPlistPath(s)); // where `daemon start` bootstraps from
    expect((await loginStatus(s, f.os)).state).toBe("disabled");
    expect(f.calls.at(-1)).toMatchObject({ op: "register", loginOn: false });

    await loginEnable(s, f.os);
    expect(existsSync(parkedPlistPath(s))).toBe(false);
    expect(existsSync(loginUnitPath(s)!)).toBe(true);
  });

  test("Linux: disable keeps the unit (startable on demand) and drops the XDG entry", async () => {
    const s = spec("linux", true);
    const f = fakeOs();
    await loginEnable(s, f.os);
    expect(existsSync(loginUnitPath(s)!)).toBe(true);
    expect(readFileSync(appUnitPath(s)!, "utf8")).toContain('ExecStart="/opt/Clover/clover"');
    expect(existsSync(xdgAutostartPath(s)!)).toBe(true);
    expect((await loginStatus(s, f.os)).state).toBe("enabled");

    await loginDisable(s, f.os);
    expect(existsSync(loginUnitPath(s)!)).toBe(true);
    expect(existsSync(appUnitPath(s)!)).toBe(true);
    expect(existsSync(xdgAutostartPath(s)!)).toBe(false);
    expect((await loginStatus(s, f.os)).state).toBe("disabled");
  });

  test("Windows: the daemon's task with its trigger on or off, and the app's task", async () => {
    const s = spec("win32", true);
    const f = fakeOs();
    expect((await loginStatus(s, f.os)).state).toBe("not-installed");
    await loginEnable(s, f.os);
    const on = f.calls.at(-1)!.tasks!;
    expect(on.map((t) => t.name)).toEqual(["\\Clover\\clover-core", "\\Clover\\clover-app"]);
    expect(on[0]!.xml).toContain("<LogonTrigger><Enabled>true</Enabled>");
    expect((await loginStatus(s, f.os)).state).toBe("enabled");
    await loginDisable(s, f.os);
    expect(f.calls.at(-1)!.tasks![0]!.xml).toContain("<LogonTrigger><Enabled>false</Enabled>");
    const st = await loginStatus(s, f.os);
    expect(st.state).toBe("disabled");
    expect(st.unitPath).toBeNull();
  });

  test("remove succeeds with nothing registered, and again after a remove (lane M's uninstall hooks)", async () => {
    for (const os of ["darwin", "linux", "win32"] as const) {
      const s = spec(os, true);
      const f = fakeOs();
      expect((await loginRemove(s, f.os)).state).toBe("not-installed");
      await loginEnable(s, f.os);
      await loginRemove(s, f.os);
      expect((await loginRemove(s, f.os)).state).toBe("not-installed");
    }
  });

  test("remove takes everything away", async () => {
    const s = spec("linux", true);
    const f = fakeOs();
    await loginEnable(s, f.os);
    const st = await loginRemove(s, f.os);
    expect(st.state).toBe("not-installed");
    for (const p of [loginUnitPath(s)!, appUnitPath(s)!, xdgAutostartPath(s)!]) expect(existsSync(p)).toBe(false);
    expect(f.calls.at(-1)!.op).toBe("unregister");
    expect((await loginStatus(s, f.os)).state).toBe("not-installed");

    const m = spec("darwin");
    await loginDisable(m, f.os);
    await loginRemove(m, f.os);
    expect(existsSync(parkedPlistPath(m))).toBe(false);
    expect(launchdPlistToLoad(m)).toBeNull();
  });

  test("enable is idempotent", async () => {
    const s = spec("darwin");
    const f = fakeOs();
    await loginEnable(s, f.os);
    expect((await loginEnable(s, f.os)).state).toBe("enabled");
  });
});
