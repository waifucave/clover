// scripts/heavy, the heavy-job limiter (plan §8): every test gets its own slot folder (HEAVY_DIR), so none
// touches the real one under the user's cache folder.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HEAVY = join(import.meta.dir, "heavy");
const posix = process.platform !== "win32";

function env(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, HEAVY_DIR: dir, HEAVY_POLL_SECONDS: "1", ...extra };
}

function slotDir(): string {
  return mkdtempSync(join(tmpdir(), "clover-heavy-test-"));
}

describe.if(posix)("scripts/heavy", () => {
  test("runs the command in a slot and hands back its exit code", () => {
    const dir = slotDir();
    const ok = spawnSync(HEAVY, ["sh", "-c", "echo out; exit 0"], { env: env(dir), encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("out\n");
    expect(ok.stderr).toContain("heavy: slot 1: sh -c");
    const failed = spawnSync(HEAVY, ["sh", "-c", "exit 7"], { env: env(dir), encoding: "utf8" });
    expect(failed.status).toBe(7);
    // The slot is given back either way.
    expect(existsSync(join(dir, "slot1"))).toBe(false);
  });

  test("--status names who holds a slot while it runs, and free afterwards", async () => {
    const dir = slotDir();
    const marker = join(dir, "started");
    const child = spawn(HEAVY, ["sh", "-c", `touch '${marker}'; sleep 3`], { env: env(dir, { HEAVY_SLOTS: "2" }), stdio: "ignore" });
    try {
      for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
      const held = spawnSync(HEAVY, ["--status"], { env: env(dir, { HEAVY_SLOTS: "2" }), encoding: "utf8" });
      expect(held.stdout).toContain(`slot 1: pid ${child.pid}: sh -c`);
      expect(held.stdout).toContain("slot 2: free");
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
    const after = spawnSync(HEAVY, ["--status"], { env: env(dir, { HEAVY_SLOTS: "2" }), encoding: "utf8" });
    expect(after.stdout).toBe("slot 1: free\nslot 2: free\n");
  });

  test("with every slot taken, the next job waits its turn", async () => {
    const dir = slotDir();
    const log = join(dir, "order.log");
    writeFileSync(log, "");
    const first = spawn(HEAVY, ["sh", "-c", `echo first-start >> '${log}'; sleep 2; echo first-end >> '${log}'`], { env: env(dir, { HEAVY_SLOTS: "1" }), stdio: "ignore" });
    for (let i = 0; i < 100 && !readFileSync(log, "utf8").includes("first-start"); i++) await Bun.sleep(50);
    const second = spawnSync(HEAVY, ["sh", "-c", `echo second >> '${log}'`], { env: env(dir, { HEAVY_SLOTS: "1" }), encoding: "utf8" });
    await new Promise((r) => (first.exitCode !== null ? r(undefined) : first.once("exit", r)));
    expect(second.status).toBe(0);
    expect(second.stderr).toContain("heavy: all 1 slots busy, waiting");
    expect(readFileSync(log, "utf8")).toBe("first-start\nfirst-end\nsecond\n");
  });

  test("a slot whose owner is gone is freed by the next heavy that looks", () => {
    const dir = slotDir();
    mkdirSync(join(dir, "slot1"));
    // A pid that cannot be alive: a finished child's.
    const gone = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(dir, "slot1", "pid"), `${gone}\n`);
    writeFileSync(join(dir, "slot1", "what"), "an old job\n");
    const run = spawnSync(HEAVY, ["true"], { env: env(dir, { HEAVY_SLOTS: "1" }), encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("busy");
  });

  test("usage and bad settings exit 2", () => {
    const dir = slotDir();
    expect(spawnSync(HEAVY, [], { env: env(dir), encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(HEAVY, ["true"], { env: env(dir, { HEAVY_SLOTS: "0" }), encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(HEAVY, ["true"], { env: env(dir, { HEAVY_POLL_SECONDS: "x" }), encoding: "utf8" }).status).toBe(2);
  });
});
