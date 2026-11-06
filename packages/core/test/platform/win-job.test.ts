import { describe, expect, test } from "bun:test";
import { AgentJob, JOB_LIMITS } from "../../src/platform/win-job";

// K-M1's ask: an agent's tree in a job object on Windows (spec §9.3), for its containment and for the
// bridge's caller check. Measured on the lane's Windows VM; elsewhere there is no job.

const win = process.platform === "win32";

/** A child that starts a grandchild (after `delayMs`) and prints the grandchild's pid. */
function parentOfOne(delayMs: number) {
  const script = `setTimeout(() => { const g = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "ignore", "ignore"] }); console.log(g.pid); }, ${delayMs}); setTimeout(() => {}, 60000);`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  const grandchild = (async () => {
    const reader = child.stdout.getReader();
    let text = "";
    while (!/\n/.test(text)) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    reader.releaseLock();
    return Number(text.trim());
  })();
  return { child, grandchild };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("AgentJob (K-M1, Windows job objects)", () => {
  test.skipIf(win)("no job off Windows", () => {
    expect(AgentJob.create()).toBeNull();
  });

  test.skipIf(!win)("unnamed, no breakaway, and everything in it ends when it closes", async () => {
    const job = AgentJob.create()!;
    expect(job).not.toBeNull();
    const flags = job.limitFlags()!;
    expect(flags & JOB_LIMITS.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).not.toBe(0);
    expect(flags & (JOB_LIMITS.JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_LIMITS.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)).toBe(0);
    const { child, grandchild } = parentOfOne(300);
    expect(job.assign(child.pid)).toBe(true);
    const g = await grandchild;
    // A grandchild started through libuv (whose own job allows silent breakaway) stays in the agent's job.
    expect(job.contains(child.pid)).toBe(true);
    expect(job.contains(g)).toBe(true);
    expect(job.pids().sort()).toEqual([child.pid, g].sort());
    expect(job.contains(process.pid)).toBe(false);
    job.close();
    await child.exited;
    for (let i = 0; i < 100 && alive(g); i++) await Bun.sleep(20);
    expect(alive(g)).toBe(false);
  }, 20_000);

  test.skipIf(!win)("assign also takes what the agent started before it was in the job; a stranger is not in it", async () => {
    const job = AgentJob.create()!;
    const { child, grandchild } = parentOfOne(0);
    const g = await grandchild; // started before the assignment
    const stranger = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "ignore", "ignore"] });
    expect(job.assign(child.pid)).toBe(true);
    expect(job.contains(g)).toBe(true);
    expect(job.contains(stranger.pid)).toBe(false);
    expect(job.terminate(7)).toBe(true);
    expect(await child.exited).toBe(7);
    for (let i = 0; i < 100 && alive(g); i++) await Bun.sleep(20);
    expect(alive(g)).toBe(false);
    stranger.kill();
    job.close();
    expect(job.contains(child.pid)).toBe(false);
    expect(job.assign(stranger.pid)).toBe(false);
  }, 20_000);
});
