import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonPairSide } from "../../src/platform/pair/daemon-side";
import { APP_KEPT_FILE, appStartPath, appTokenPath, markAppKept, takeAppKept } from "../../src/platform/pair/run-files";
import type { AppLauncher } from "../../src/platform/pair/launch";

const os = (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux") as "darwin" | "linux" | "win32";

function setup(launcher: AppLauncher | null, held?: () => boolean) {
  const runDir = mkdtempSync(join(tmpdir(), "moss-pair-"));
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const stops: string[] = [];
  const side = startDaemonPairSide({
    runDir, os, profile: "dev", execPath: "/x/moss-core", env: {},
    tellAppQuit() {}, stopDaemon(why) { stops.push(why); },
    run: async (argv) => ({ ok: true, out: argv[0] === "whoami" ? '"pc\\\\u","S-1-5-21-1-2-3-1001"' : "" }),
    launcher, now: () => 7, after(ms, fn) { timers.push({ ms, fn }); return () => {}; },
    ...(held !== undefined ? { appStartHeld: held } : {}),
  });
  return { runDir, timers, stops, side };
}

describe("the daemon's side of the pair, assembled", () => {
  test("mints the app token, starts the app after the grace, and cleans up", async () => {
    const started: string[] = [];
    const s = setup({ how: "fake", async start() { started.push(readFileSync(appStartPath(s.runDir), "utf8")); return "started"; } });
    const side = await s.side;
    expect(readFileSync(appTokenPath(s.runDir), "utf8")).toBe(side.appToken);
    expect(s.timers.map((t) => t.ms)).toEqual([2_000]); // the start-up grace
    s.timers[0]!.fn();
    for (let i = 0; i < 100 && started.length === 0; i++) await Bun.sleep(5); // the start file is written first
    expect(started.map((j) => JSON.parse(j))).toEqual([{ by: "login", safeMode: false, at: 7 }]);
    side.dispose();
    expect(existsSync(appTokenPath(s.runDir))).toBe(false);
  });

  test("with no app installed the daemon runs alone", async () => {
    const s = setup(null);
    const side = await s.side;
    expect(side.launcher).toBeNull();
    expect(side.pair.status().desktop).toBe(false);
    expect(s.timers).toHaveLength(0);
    side.pair.quit("quit");
    expect(s.stops).toHaveLength(1);
    side.dispose();
  });

  // lane HS: while a background host owns the screen the pair starts no app: "not ready yet", tried again, never a crash.
  test("while a background host owns the screen, no app is started and nothing counts as a crash", async () => {
    let held = true;
    const started: number[] = [];
    const s = setup({ how: "fake", async start() { started.push(1); return "started"; } }, () => held);
    const side = await s.side;
    s.timers.shift()!.fn();
    await Bun.sleep(20);
    expect(started).toEqual([]);
    expect(side.pair.status().safeMode).toBe(false);
    // Tried again later (not a crash's backoff); once no host owns the screen, the app starts.
    held = false;
    for (let i = 0; i < 5 && started.length === 0; i++) { const t = s.timers.shift(); t?.fn(); await Bun.sleep(20); }
    expect(started).toEqual([1]);
    side.dispose();
  });
});

describe("a stop that keeps the app open (a release switch, the old home's copy)", () => {
  const quiet: AppLauncher = { how: "fake", async start() { return "started"; } };

  test("it leaves a mark; the next daemon's pair takes it and gives the app the restart's wait, once", async () => {
    const first = setup(quiet);
    const a = await first.side;
    a.keepApp();
    expect(existsSync(join(first.runDir, APP_KEPT_FILE))).toBe(true);
    a.dispose();
    // The next daemon in the same run folder: the restart's 10 s, and the mark is gone.
    const timers: number[] = [];
    const b = await startDaemonPairSide({
      runDir: first.runDir, os, profile: "dev", execPath: "/x/moss-core", env: {}, tellAppQuit() {}, stopDaemon() {},
      run: async (argv) => ({ ok: true, out: argv[0] === "whoami" ? '"pc\\\\u","S-1-5-21-1-2-3-1001"' : "" }),
      launcher: quiet, now: () => 9, after(ms) { timers.push(ms); return () => {}; },
    });
    expect(timers).toEqual([10_000]);
    expect(existsSync(join(first.runDir, APP_KEPT_FILE))).toBe(false);
    b.dispose();
  });

  test("a daemon stopped any other way leaves no mark, and the start-up wait stays 2 s", async () => {
    const s = setup(quiet);
    const side = await s.side;
    side.pair.quit("quit");
    side.dispose();
    expect(existsSync(join(s.runDir, APP_KEPT_FILE))).toBe(false);
  });

  test("a stale, future or unreadable mark is not taken (and is removed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-kept-"));
    markAppKept(dir, 1_000);
    expect(takeAppKept(dir, 1_000 + 120_001)).toBe(false);
    markAppKept(dir, 5_000);
    expect(takeAppKept(dir, 4_000)).toBe(false);
    writeFileSync(join(dir, APP_KEPT_FILE), "not json");
    expect(takeAppKept(dir, 6_000)).toBe(false);
    expect(existsSync(join(dir, APP_KEPT_FILE))).toBe(false);
    markAppKept(dir, 1_000);
    expect(takeAppKept(dir, 1_000 + 120_000)).toBe(true);
  });
});
