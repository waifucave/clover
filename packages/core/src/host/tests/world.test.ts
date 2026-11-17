// The engine's real host world (lane HS): the host lock is an OS lock (a dead holder's pid never counts), the newest
// app carrying a helper is the source, and a start checks the helper's signature before Launch Services.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_LOCK_FILE, HOST_START_FILE } from "@waifucave/moss-protocol";
import type { Runner } from "../../platform/login/live";
import { appRecordsSource, bundleRelease, DARWIN_O_EXLOCK, engineHostWorld, hostHelperPath, hostLockHolder, hostRequirement, parseHostCommand } from "../world";

const root = mkdtempSync(join(tmpdir(), "moss-host-world-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const newHome = () => { const h = join(root, `h${n++}`); mkdirSync(join(h, "run"), { recursive: true }); mkdirSync(join(h, "apps"), { recursive: true }); return h; };

/** A process of this test's own that holds the host lock as the host does (O_EXLOCK on open) and writes its pid. */
function holdLock(home: string): Promise<{ pid: number; end(): Promise<void> }> {
  const script = `const fs=require("node:fs");const fd=fs.openSync(${JSON.stringify(join(home, HOST_LOCK_FILE))},fs.constants.O_RDWR|fs.constants.O_CREAT|${DARWIN_O_EXLOCK}|4,0o600);fs.ftruncateSync(fd,0);fs.writeSync(fd,String(process.pid));console.log("held");setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    child.stdout!.once("data", () => resolve({
      pid: child.pid!,
      end: () => new Promise<void>((r) => { child.once("exit", () => r()); child.kill("SIGKILL"); }),
    }));
    child.once("error", reject);
  });
}

describe.if(process.platform === "darwin")("the host lock (macOS)", () => {
  test("held by a live process: its pid; once it dies the lock is free, whatever pid the file still names", async () => {
    const home = newHome();
    expect(hostLockHolder(home, "darwin")).toBeNull();
    const holder = await holdLock(home);
    expect(hostLockHolder(home, "darwin")).toBe(holder.pid);
    await holder.end();
    expect(hostLockHolder(home, "darwin")).toBeNull();
  });

  test("a pid written by hand, with no lock behind it, is no holder", () => {
    const home = newHome();
    writeFileSync(join(home, HOST_LOCK_FILE), String(process.pid));
    expect(hostLockHolder(home, "darwin")).toBeNull();
  });
});

test("Windows and Linux have no host lock yet: never a holder", () => {
  const home = newHome();
  expect(hostLockHolder(home, "linux")).toBeNull();
  expect(hostLockHolder(home, "win32")).toBeNull();
});

describe("the source", () => {
  const rec = (program: string, bundlePath: string, release: string, seenAt: number, host = true) => ({ record: 1, program, bundlePath, release, carries: { engine: true, host }, seenAt });

  test("the newest app that carries the host and is still on disk; a tie goes to the later record", () => {
    const home = newHome();
    const on = new Set(["/A/MOSS.app", "/A/MOSS Code.app", "/A/Gone.app"]);
    writeFileSync(join(home, "apps", "moss.json"), JSON.stringify(rec("moss", "/A/MOSS.app", "1.111.1", 5)));
    writeFileSync(join(home, "apps", "code.json"), JSON.stringify(rec("code", "/A/MOSS Code.app", "1.111.1", 9)));
    expect(appRecordsSource(home, (p) => on.has(p))?.bundlePath).toBe("/A/MOSS Code.app");
    writeFileSync(join(home, "apps", "moss.json"), JSON.stringify(rec("moss", "/A/MOSS.app", "1.111.2", 1)));
    expect(appRecordsSource(home, (p) => on.has(p))?.bundlePath).toBe("/A/MOSS.app");
    on.delete("/A/MOSS.app");
    expect(appRecordsSource(home, (p) => on.has(p))?.bundlePath).toBe("/A/MOSS Code.app");
    writeFileSync(join(home, "apps", "code.json"), JSON.stringify(rec("code", "/A/MOSS Code.app", "1.111.1", 9, false)));
    writeFileSync(join(home, "apps", "junk.json"), "{ not json");
    expect(appRecordsSource(home, (p) => on.has(p))).toBeUndefined();
  });
});

test("a bundle's release is its Info.plist's CFBundleShortVersionString", () => {
  const xml = Buffer.from('<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key>\n\t<string>1.111.1</string></dict></plist>');
  expect(bundleRelease("/A/MOSS.app", () => xml)).toBe("1.111.1");
  expect(bundleRelease("/A/MOSS.app", () => { throw new Error("gone"); })).toBeUndefined();
});

describe("starting the host", () => {
  function world(over: Partial<Parameters<typeof engineHostWorld>[0]> & { runs?: string[][]; ok?: (argv: readonly string[]) => boolean }) {
    const runs: string[][] = over.runs ?? [];
    const failed: string[] = [];
    const run: Runner = async (argv) => { runs.push([...argv]); return { ok: over.ok?.(argv) ?? true, out: "" }; };
    const home = newHome();
    const w = engineHostWorld({
      home, os: "darwin", profile: "dist", release: "1.111.1", run, dist: true, testBuild: false, env: {},
      stopHost: () => false, startFailed: (why) => failed.push(why), ...over,
    });
    return { w, runs, failed, home };
  }
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const app = { record: 1 as const, program: "code" as const, bundlePath: "/A/MOSS Code.app", release: "1.111.1", carries: { engine: true, host: true }, seenAt: 1 };

  test("an app that carries no helper is no source (the engine runs headless rather than retrying)", () => {
    const { w } = world({ source: () => app, exists: () => false });
    expect(w.source()).toBeUndefined();
    const { w: w2 } = world({ source: () => app, exists: (p) => p === hostHelperPath(app.bundlePath, "dist"), bundleRelease: () => "1.111.1" });
    expect(w2.source()?.bundlePath).toBe(app.bundlePath);
    // The record says one release and the bundle another (an update half way, a forged record): not this copy.
    const { w: w3 } = world({ source: () => app, exists: () => true, bundleRelease: () => "1.111.0" });
    expect(w3.source()).toBeUndefined();
  });

  test("macOS: the helper's signature is checked against the host's requirement before Launch Services starts it", async () => {
    const helper = hostHelperPath(app.bundlePath, "dist");
    const ok = world({ exists: () => true });
    ok.w.start(app.bundlePath, { safeMode: true });
    await settle();
    expect(ok.runs).toEqual([
      ["codesign", "--verify", "--strict", `-R=${hostRequirement("dist")}`, helper],
      ["open", "-n", "-g", "-a", helper],
    ]);
    expect(ok.failed).toEqual([]);
    expect(JSON.parse(await Bun.file(join(ok.home, HOST_START_FILE)).text())).toMatchObject({ by: "engine", safeMode: true });
    const bad = world({ exists: () => true, ok: (argv) => argv[0] !== "codesign" });
    bad.w.start(app.bundlePath, { safeMode: false });
    await settle();
    expect(bad.runs.map((r) => r[0])).toEqual(["codesign"]);
    expect(bad.failed[0]).toContain("not signed as MOSS's host");
  });

  test("the host's requirement names its own fixed identifier, Apple's chain, the team and (dist) a Developer ID leaf", () => {
    expect(hostRequirement("dist")).toContain('identifier "com.waifucave.moss.host"');
    expect(hostRequirement("dist")).toContain("certificate 1[field.1.2.840.113635.100.6.2.6]");
    expect(hostRequirement("dev")).toContain('identifier "com.waifucave.moss.host.dev"');
    expect(hostRequirement("dev")).not.toContain("6.2.6");
    expect(() => hostRequirement("dist", "nope")).toThrow();
  });

  test("a checkout's own start counts only outside a dist build; a test-marked build starts nothing through the OS", () => {
    const cmd = JSON.stringify(["/bin/true", "--moss-program=host"]);
    expect(parseHostCommand(cmd)).toEqual(["/bin/true", "--moss-program=host"]);
    expect(parseHostCommand("[]")).toBeUndefined();
    expect(parseHostCommand("not json")).toBeUndefined();
    expect(world({ env: { MOSS_HOST_COMMAND: cmd }, dist: true, source: () => undefined }).w.source()).toBeUndefined();
    expect(world({ env: { MOSS_HOST_COMMAND: cmd }, dist: false }).w.source()?.bundlePath).toBe("/bin/true");
    expect(world({ dist: false, testBuild: true, source: () => app, exists: () => true }).w.source()).toBeUndefined();
  });

  test("stop asks the live host; with none it says so", () => {
    const stops: string[] = [];
    const { w } = world({ stopHost: (r) => { stops.push(r); return true; } });
    w.stop("update");
    expect(stops).toEqual(["update"]);
  });
});
