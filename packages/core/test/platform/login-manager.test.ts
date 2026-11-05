import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginEnable, loginDisable, loginStatus, type LoginOsDeps } from "../../src/platform/login/manager";
import type { LoginSpec } from "../../src/platform/login/render";

function fakeOs() {
  const calls: string[] = [];
  let registered = false;
  const os: LoginOsDeps = {
    async register(_s, _xml) { calls.push("register"); registered = true; return true; },
    async unregister(_s) { calls.push("unregister"); registered = false; },
    async isRegistered(_s) { return registered; },
  };
  return { os, calls, get registered() { return registered; } };
}

function spec(os: "darwin" | "linux" | "win32", home: string): LoginSpec {
  return { os, bin: "/opt/clover/clover-core", home: join(home, ".clover"), logsDir: join(home, ".clover/logs"), profile: "dist", homedir: home };
}

describe("login manager", () => {
  test("enable writes the unit and registers (macOS)", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-login-"));
    const f = fakeOs();
    const st = await loginEnable(spec("darwin", home), f.os);
    expect(st.state).toBe("enabled");
    expect(st.unitPath && existsSync(st.unitPath)).toBe(true);
    expect(readFileSync(st.unitPath!, "utf8")).toContain("<string>supervise</string>");
    expect(f.calls).toContain("register");
  });

  test("disable unregisters and removes the unit", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-login-"));
    const f = fakeOs();
    const s = spec("linux", home);
    await loginEnable(s, f.os);
    const st = await loginDisable(s, f.os);
    expect(st.state).toBe("disabled");
    expect(st.unitPath && existsSync(st.unitPath)).toBe(false);
    expect(f.registered).toBe(false);
  });

  test("status reflects registration (Windows has no unit file)", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-login-"));
    const f = fakeOs();
    const s = spec("win32", home);
    expect((await loginStatus(s, f.os)).state).toBe("disabled");
    await loginEnable(s, f.os);
    const st = await loginStatus(s, f.os);
    expect(st.state).toBe("enabled");
    expect(st.unitPath).toBeNull();
    expect(st.registered).toBe(true);
  });

  test("enable is idempotent", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-login-"));
    const f = fakeOs();
    const s = spec("darwin", home);
    await loginEnable(s, f.os);
    const st = await loginEnable(s, f.os);
    expect(st.state).toBe("enabled");
  });
});
