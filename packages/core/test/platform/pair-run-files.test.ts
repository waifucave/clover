import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appStartPath, appTokenPath, mintAppToken, removeAppToken, writeAppStart } from "../../src/platform/pair/run-files";
import { appStarter, type AppLauncher } from "../../src/platform/pair/launch";
import type { Runner } from "../../src/platform/login/live";

const run = () => mkdtempSync(join(tmpdir(), "clover-run-"));
/** This OS, with a runner that answers yes (on Windows, icacls). */
const native = { os: (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux") as "darwin" | "linux" | "win32", run: (async () => ({ ok: true, out: "" })) as Runner, userSid: "S-1-5-21-1-2-3-1001" };

describe("the run files the daemon leaves for the app (E-M1, R2)", () => {
  test("a fresh app token each start, owner-only, with no temp file left", async () => {
    const dir = run();
    const a = await mintAppToken(dir, native);
    const b = await mintAppToken(dir, native);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
    expect(readFileSync(appTokenPath(dir), "utf8")).toBe(b);
    if (process.platform !== "win32") expect(statSync(appTokenPath(dir)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["app.token"]);
    removeAppToken(dir);
    expect(existsSync(appTokenPath(dir))).toBe(false);
  });

  test("Windows: the token's ACL grants the user's SID alone before it is renamed into place", async () => {
    const dir = run();
    const calls: string[][] = [];
    const deps = { os: "win32" as const, userSid: "S-1-5-21-1-2-3-1001", run: (async (argv: readonly string[]) => { calls.push([...argv]); return { ok: true, out: "" }; }) as Runner };
    await mintAppToken(dir, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 1)).toEqual(["icacls"]);
    expect(calls[0]![1]).toMatch(/app\.token\..+\.tmp$/); // the temporary name, not the final one
    expect(calls[0]!.slice(2)).toEqual(["/inheritance:r", "/grant:r", "*S-1-5-21-1-2-3-1001:F"]);
  });

  test("Windows: no SID or a refused ACL writes no token at all", async () => {
    const dir = run();
    await expect(mintAppToken(dir, { os: "win32", run: native.run })).rejects.toThrow();
    await expect(mintAppToken(dir, { os: "win32", userSid: "S-1-5-21-9", run: async () => ({ ok: false, out: "" }) })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the start file says who started the app and whether in safe mode", async () => {
    const dir = run();
    await writeAppStart(dir, { by: "daemon", safeMode: true, at: 1_000 }, native);
    expect(JSON.parse(readFileSync(appStartPath(dir), "utf8"))).toEqual({ by: "daemon", safeMode: true, at: 1_000 });
  });

  test("appStarter writes the start file before starting the app: boot is login, a restart is daemon", async () => {
    const dir = run();
    const seen: unknown[] = [];
    const launcher: AppLauncher = { how: "fake", async start() { seen.push(JSON.parse(readFileSync(appStartPath(dir), "utf8"))); return "started"; } };
    let safe = false;
    const start = appStarter(launcher, dir, { ...native, now: () => 42, safeMode: () => safe });
    expect(await start("boot")).toBe("started");
    safe = true;
    await start("crash");
    expect(seen).toEqual([{ by: "login", safeMode: false, at: 42 }, { by: "daemon", safeMode: true, at: 42 }]);
  });
});
