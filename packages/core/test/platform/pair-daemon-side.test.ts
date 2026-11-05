import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonPairSide } from "../../src/platform/pair/daemon-side";
import { appStartPath, appTokenPath } from "../../src/platform/pair/run-files";
import type { AppLauncher } from "../../src/platform/pair/launch";

const os = (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux") as "darwin" | "linux" | "win32";

function setup(launcher: AppLauncher | null) {
  const runDir = mkdtempSync(join(tmpdir(), "clover-pair-"));
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const stops: string[] = [];
  const side = startDaemonPairSide({
    runDir, os, profile: "dev", execPath: "/x/clover-core", env: {},
    tellAppQuit() {}, stopDaemon(why) { stops.push(why); },
    run: async (argv) => ({ ok: true, out: argv[0] === "whoami" ? '"pc\\\\u","S-1-5-21-1-2-3-1001"' : "" }),
    launcher, now: () => 7, after(ms, fn) { timers.push({ ms, fn }); return () => {}; },
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
});
