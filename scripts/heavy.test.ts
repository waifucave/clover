// scripts/heavy, the heavy-job limiter (plan §8): every test gets its own slot folder (HEAVY_DIR), so none
// touches the real one under the user's cache folder.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HEAVY = join(import.meta.dir, "heavy");
const posix = process.platform !== "win32";
const PINNED_BUN = readFileSync(join(import.meta.dir, "..", ".bun-version"), "utf8").trim();

const STAND_IN = `#!/bin/sh\necho ${PINNED_BUN}\n`;

/** A pinned-Bun cache that already holds this checkout's pinned version (a stand-in), so no test fetches one. */
function bunCache(): string {
  const cache = mkdtempSync(join(tmpdir(), "clover-heavy-test-bun-"));
  mkdirSync(join(cache, PINNED_BUN));
  writeFileSync(join(cache, PINNED_BUN, "bun"), STAND_IN, { mode: 0o755 });
  return cache;
}
const CACHE = posix ? bunCache() : "";

/** A throwaway checkout pinning this Bun version, its `.bun-sha256` pinning the stand-in (pinned-bun checks the cached
 *  binary against it on every run), with this repo's scripts/pinned-bun: heavy run there takes the stand-in. */
function pinningCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "clover-heavy-test-checkout-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, ".bun-version"), `${PINNED_BUN}\n`);
  const sha = createHash("sha256").update(STAND_IN).digest("hex");
  const assets = ["darwin-aarch64", "darwin-x64", "darwin-x64-baseline", "linux-aarch64", "linux-aarch64-musl", "linux-x64", "linux-x64-baseline", "linux-x64-musl", "linux-x64-musl-baseline"];
  writeFileSync(join(dir, ".bun-sha256"), `${assets.map((a) => `${PINNED_BUN} bun-${a} ${sha}`).join("\n")}\n`);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(import.meta.dir, "pinned-bun"), join(dir, "scripts", "pinned-bun"));
  spawnSync("chmod", ["755", join(dir, "scripts", "pinned-bun")]);
  return dir;
}

/** The slot tests run with PATH as it is; the pinned-Bun test turns it on, in a checkout that pins the stand-in. */
function env(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, HEAVY_DIR: dir, HEAVY_POLL_SECONDS: "1", CLOVER_BUN_CACHE: CACHE, CLOVER_PINNED_BUN: "0", ...extra };
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
    expect(after.stdout).toBe("slot 1: free\nslot 2: free\nexclusive: free\n");
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

  test("the job runs with the checkout's pinned Bun first on PATH, and CLOVER_PINNED_BUN=0 leaves PATH alone", () => {
    const dir = slotDir();
    const which = ["sh", "-c", "command -v bun; bun --version"];
    const checkout = pinningCheckout();
    const pinned = spawnSync(HEAVY, which, { cwd: checkout, env: env(dir, { CLOVER_PINNED_BUN: "1" }), encoding: "utf8" });
    expect(pinned.status).toBe(0);
    expect(pinned.stdout).toBe(`${join(CACHE, PINNED_BUN, "bun")}\n${PINNED_BUN}\n`);
    const off = spawnSync(HEAVY, which, { cwd: checkout, env: env(dir, { CLOVER_PINNED_BUN: "0" }), encoding: "utf8" });
    expect(off.stdout).not.toContain(CACHE);
    // Outside a checkout that pins a Bun, PATH is left as it is.
    const elsewhere = spawnSync(HEAVY, which, { cwd: dir, env: env(dir, { CLOVER_PINNED_BUN: "1" }), encoding: "utf8" });
    expect(elsewhere.stdout).not.toContain(CACHE);
  });

  // The machine-wide exclusive lock (`--exclusive`): one acceptance or try run at a time.
  const until = async (f: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !f(); i++) await Bun.sleep(50);
    if (!f()) throw new Error(`${what}: not within 10 s`);
  };
  const exited = (c: ReturnType<typeof spawn>) => new Promise((r) => (c.exitCode !== null ? r(undefined) : c.once("exit", r)));

  test("two exclusive holders queue: the second waits, naming who holds the lock, and runs when it is free", async () => {
    const dir = slotDir();
    const log = join(dir, "order.log");
    writeFileSync(log, "");
    const first = spawn(HEAVY, ["--exclusive", "sh", "-c", `echo first-start >> '${log}'; sleep 2; echo first-end >> '${log}'`], { env: env(dir), stdio: "ignore" });
    await until(() => readFileSync(log, "utf8").includes("first-start"), "the first holder starting");
    const status = spawnSync(HEAVY, ["--status"], { env: env(dir, { HEAVY_SLOTS: "1" }), encoding: "utf8" });
    expect(status.stdout).toContain(`exclusive: pid ${first.pid} run: sh -c echo first-start`);
    const second = spawnSync(HEAVY, ["--exclusive", "--packaged", "sh", "-c", `echo "second $CLOVER_HEAVY_EXCLUSIVE" >> '${log}'`], { env: env(dir), encoding: "utf8" });
    await exited(first);
    expect(second.status).toBe(0);
    expect(second.stderr).toContain(`heavy: waiting for the exclusive lock, held by pid ${first.pid} run: sh -c`);
    const lines = readFileSync(log, "utf8").split("\n");
    expect(lines.slice(0, 2)).toEqual(["first-start", "first-end"]);
    // The command ran with the holder's pid in CLOVER_HEAVY_EXCLUSIVE (its own heavy's, not the first one's).
    expect(lines[2]).toMatch(/^second \d+$/);
    expect(lines[2]).not.toBe(`second ${first.pid}`);
    expect(existsSync(join(dir, "exclusive"))).toBe(false);
  });

  test("a holder that is gone is taken over by pid check", () => {
    const dir = slotDir();
    mkdirSync(join(dir, "exclusive"));
    const gone = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(dir, "exclusive", "pid"), `${gone}\n`);
    writeFileSync(join(dir, "exclusive", "kind"), "packaged\n");
    writeFileSync(join(dir, "exclusive", "what"), "an old acceptance run\n");
    const run = spawnSync(HEAVY, ["--exclusive", "true"], { env: env(dir), encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("waiting");
    // Nor does an ordinary job wait on it.
    mkdirSync(join(dir, "exclusive"));
    writeFileSync(join(dir, "exclusive", "pid"), `${gone}\n`);
    writeFileSync(join(dir, "exclusive", "kind"), "packaged\n");
    const ordinary = spawnSync(HEAVY, ["true"], { env: env(dir), encoding: "utf8" });
    expect(ordinary.status).toBe(0);
    expect(ordinary.stderr).not.toContain("waiting");
  });

  test("ordinary jobs wait while a packaged run holds the lock, not while another run does; what runs under the hold never waits", async () => {
    const dir = slotDir();
    const log = join(dir, "order.log");
    writeFileSync(log, "");
    // A non-packaged holder: an ordinary job goes on at once.
    const run = spawn(HEAVY, ["--exclusive", "sh", "-c", `echo run-start >> '${log}'; sleep 2`], { env: env(dir), stdio: "ignore" });
    await until(() => readFileSync(log, "utf8").includes("run-start"), "the run holding the lock");
    const beside = spawnSync(HEAVY, ["true"], { env: env(dir), encoding: "utf8" });
    expect(beside.status).toBe(0);
    expect(beside.stderr).not.toContain("waiting");
    await exited(run);

    // A packaged holder: what it starts through heavy (a build, a nested exclusive run) goes on at once; another job
    // waits until it ends.
    const inner = `'${HEAVY}' sh -c "echo inner-ordinary >> '${log}'"; '${HEAVY}' --exclusive --packaged sh -c "echo inner-exclusive >> '${log}'"`;
    const packaged = spawn(HEAVY, ["--exclusive", "--packaged", "sh", "-c", `echo packaged-start >> '${log}'; ${inner}; sleep 2; echo packaged-end >> '${log}'`], { env: env(dir), stdio: "ignore" });
    await until(() => readFileSync(log, "utf8").includes("inner-exclusive"), "the packaged run's own heavy jobs");
    const other = spawnSync(HEAVY, ["sh", "-c", `echo other >> '${log}'`], { env: env(dir), encoding: "utf8" });
    await exited(packaged);
    expect(other.status).toBe(0);
    expect(other.stderr).toContain(`heavy: waiting: a packaged run holds the machine, pid ${packaged.pid} packaged: sh -c`);
    expect(readFileSync(log, "utf8")).toBe("run-start\npackaged-start\ninner-ordinary\ninner-exclusive\npackaged-end\nother\n");
  });

  test("a packaged run starts once the heavy jobs already running have ended", async () => {
    const dir = slotDir();
    const log = join(dir, "order.log");
    writeFileSync(log, "");
    const job = spawn(HEAVY, ["sh", "-c", `echo job-start >> '${log}'; sleep 2; echo job-end >> '${log}'`], { env: env(dir), stdio: "ignore" });
    await until(() => readFileSync(log, "utf8").includes("job-start"), "the job in its slot");
    const packaged = spawnSync(HEAVY, ["--exclusive", "--packaged", "sh", "-c", `echo packaged >> '${log}'`], { env: env(dir), encoding: "utf8" });
    await exited(job);
    expect(packaged.status).toBe(0);
    expect(packaged.stderr).toContain("heavy: the packaged run waits for 1 heavy job(s) already running to end");
    expect(readFileSync(log, "utf8")).toBe("job-start\njob-end\npackaged\n");
  });

  test("usage and bad settings exit 2", () => {
    const dir = slotDir();
    expect(spawnSync(HEAVY, [], { env: env(dir), encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(HEAVY, ["--exclusive"], { env: env(dir), encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(HEAVY, ["--exclusive", "--packaged"], { env: env(dir), encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(HEAVY, ["true"], { env: env(dir, { HEAVY_SLOTS: "0" }), encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(HEAVY, ["true"], { env: env(dir, { HEAVY_POLL_SECONDS: "x" }), encoding: "utf8" }).status).toBe(2);
  });
});
