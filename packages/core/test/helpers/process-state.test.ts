// The helper's own pins (helpers/process-state.ts): a killed, orphaned process is gone to `running` whether or not this
// process is a child subreaper, and `kill(pid, 0)` alone is NOT the answer where it is (the Linux fault that moved
// `stdio-mcp-stops` from one CI shard to another and failed it).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { becomeSubreaper, isSubreaper, running } from "./process-state";

const kill0 = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Starts a long sleeper that its parent shell leaves behind (an orphan), kills it, and waits for it to be gone. */
async function orphanKilled(): Promise<number> {
  const out = spawnSync("sh", ["-c", "sleep 60 >/dev/null 2>&1 </dev/null & echo $!"], { encoding: "utf8" });
  const pid = Number(out.stdout.trim());
  expect(Number.isInteger(pid) && pid > 1).toBe(true);
  await Bun.sleep(100); // the shell has exited: the sleeper is an orphan, re-parented to init or to a subreaper
  expect(running(pid)).toBe(true);
  process.kill(pid, "SIGKILL");
  const end = Date.now() + 3_000;
  while (running(pid) && Date.now() < end) await Bun.sleep(20);
  return pid;
}

describe.skipIf(process.platform === "win32")("running(): a process that ended is not running", () => {
  test("an orphan killed while this process is NOT a subreaper is gone", async () => {
    const restore = becomeSubreaper(false);
    try {
      const pid = await orphanKilled();
      expect(running(pid)).toBe(false);
      expect(kill0(pid)).toBe(false); // init reaped it
    } finally { restore(); }
  });

  test.skipIf(process.platform !== "linux")("an orphan killed while this process IS a subreaper stays a zombie: kill(pid, 0) says alive, running() says gone", async () => {
    const restore = becomeSubreaper(true);
    try {
      expect(isSubreaper()).toBe(true);
      const pid = await orphanKilled();
      expect(running(pid)).toBe(false);
      expect(kill0(pid)).toBe(true); // the zombie: the very probe that failed `stdio-mcp-stops` on Linux
    } finally { restore(); }
  });

  test.skipIf(process.platform !== "linux")("becomeSubreaper puts the flag back as it found it", () => {
    const before = isSubreaper();
    const restore = becomeSubreaper(!before);
    expect(isSubreaper()).toBe(!before);
    restore();
    expect(isSubreaper()).toBe(before);
  });

  test("this very process runs", () => { expect(running(process.pid)).toBe(true); });
});
