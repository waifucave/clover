// The engine's real host world (lane HS): the host lock is an OS lock (a dead holder's pid never counts), the newest
// app carrying a helper is the source, and a start checks the helper's signature before Launch Services.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_LOCK_FILE, HOST_START_FILE } from "@waifucave/moss-protocol";
import type { Runner } from "../../platform/login/live";
import { darwinDescribe } from "../../../test/helpers/darwin-only";
import { APP_RECORD_MAX_BYTES, appRecordsSource, bundleRelease, DARWIN_O_EXLOCK, isHostImage, engineHostWorld, hostHelperPath, hostLockHolder, hostRequirement, parseHostCommand } from "../world";

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

darwinDescribe("the host lock (macOS)", () => {
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

  test("a checkout's host command that ends at once with an error is a failed start now (not after the watchdog), told once", async () => {
    const bad = world({ dist: false, os: "linux", env: { MOSS_HOST_COMMAND: JSON.stringify(["/bin/sh", "-c", "exit 3"]) } });
    bad.w.start(bad.w.source()!.bundlePath, { safeMode: false });
    for (let i = 0; i < 100 && bad.failed.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(bad.failed).toEqual(["the host's command ended at once (code 3)"]);
    // One that ends cleanly (a host that hands over and leaves) is no failed start: its leaving is its connection's to say.
    const fine = world({ dist: false, os: "linux", env: { MOSS_HOST_COMMAND: JSON.stringify(["/bin/sh", "-c", "exit 0"]) } });
    fine.w.start(fine.w.source()!.bundlePath, { safeMode: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(fine.failed).toEqual([]);
  });

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

test("a checkout's start on macOS goes through Launch Services with the run's environment, never as the engine's child", async () => {
  const runs: string[][] = [];
  const run: Runner = async (argv) => { runs.push([...argv]); return { ok: true, out: "" }; };
  const home = newHome();
  const cmd = JSON.stringify(["/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", "/repo/apps/desktop", "--moss-program=host"]);
  const w = engineHostWorld({ home, os: "darwin", profile: "dev", release: "1.111.1", run, dist: false, testBuild: false, env: { MOSS_HOST_COMMAND: cmd, MOSS_HOME: home, HOME: "/tmp/u", SECRET_THING: "x", MOSS_APP_TOKEN: "dummy123" }, stopHost: () => false, startFailed: () => {} });
  w.start(w.source()!.bundlePath, { safeMode: true });
  await new Promise((r) => setTimeout(r, 5));
  expect(runs[0]!.slice(0, 3)).toEqual(["open", "-n", "-g"]);
  expect(runs[0]!.slice(runs[0]!.indexOf("-a"), runs[0]!.indexOf("-a") + 2)).toEqual(["-a", "/x/node_modules/electron/dist/Electron.app"]);
  expect(runs[0]).toContain(join(home, "logs", "host.out.log"));
  expect(runs[0]).toContain(`MOSS_HOME=${home}`);
  expect(runs[0]).toContain("HOME=/tmp/u");
  expect(runs[0]!.join(" ")).not.toContain("SECRET_THING");
  expect(runs[0]!.join(" ")).not.toContain("dummy123");
  expect(runs[0]!.join(" ")).not.toContain("MOSS_HOST_COMMAND");
  expect(runs[0]!.slice(runs[0]!.indexOf("--args"))).toEqual(["--args", "/repo/apps/desktop", "--moss-program=host", "--safe-mode"]);
});

describe("the reviewer's part one (S7, the records)", () => {
  test("a pid is ended only when its image is MOSS's host helper inside an app (or the checkout's own program)", () => {
    expect(isHostImage("/Applications/MOSS Code.app/Contents/Frameworks/MOSS Host.app/Contents/MacOS/MOSS Host")).toBe(true);
    expect(isHostImage("/Applications/MOSS.app/Contents/Frameworks/MOSS Host Dev.app/Contents/MacOS/MOSS Host Dev")).toBe(true);
    expect(isHostImage("/usr/bin/sshd")).toBe(false);
    expect(isHostImage("/tmp/MOSS Host.app/Contents/MacOS/MOSS Host")).toBe(false);
    expect(isHostImage("/w/Electron.app/Contents/MacOS/Electron", "/w/Electron.app/Contents/MacOS/Electron")).toBe(true);
  });

  test("records: a link or an oversized file is never read; a program's newest is found for the menu's Open", () => {
    const home = mkdtempSync(join(tmpdir(), "moss-hs-rec-"));
    try {
      const dir = join(home, "apps");
      mkdirSync(dir, { recursive: true });
      const rec = (program: "moss" | "code", release: string) => JSON.stringify({ record: 1, program, bundlePath: `/A/${program}.app`, release, carries: { engine: true, host: true }, seenAt: 1 });
      writeFileSync(join(dir, "code.json"), rec("code", "1.111.1"));
      writeFileSync(join(home, "elsewhere.json"), rec("moss", "9.0.0"));
      symlinkSync(join(home, "elsewhere.json"), join(dir, "linked.json"));
      writeFileSync(join(dir, "big.json"), `${rec("moss", "8.0.0").slice(0, -1)},"pad":"${"x".repeat(APP_RECORD_MAX_BYTES)}"}`);
      const exists = () => true;
      expect(appRecordsSource(home, exists)?.program).toBe("code");
      expect(appRecordsSource(home, exists, "moss")).toBeUndefined();
      expect(appRecordsSource(home, exists, "code")?.bundlePath).toBe("/A/code.app");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
