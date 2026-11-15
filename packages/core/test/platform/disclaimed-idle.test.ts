// The supervisor (`clover-core supervise`) waits on its daemon through `spawnDisclaimed` (macOS). While the child runs,
// the waiting process must sleep: try 14's supervisor spun at ~80% of a core for the daemon's whole life, because only
// libdispatch's threadsafe callback held Bun's event loop open and the loop polled without sleeping. A process that does
// nothing but wait on a disclaimed child for 3 s here uses almost no CPU, and the exit still comes at once.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { DISCLAIMED_GUARD_MS } from "../../src/platform/daemon-children";
import { darwinDescribe } from "../helpers/darwin-only";

const SOURCE = join(import.meta.dir, "..", "..", "src", "platform", "daemon-children.ts");

darwinDescribe("a process waiting on a disclaimed child sleeps", () => {
  test("3 s of waiting costs well under a tenth of a second of CPU, and the exit is told within a second", async () => {
    const script = `
      import { spawnDisclaimed } from ${JSON.stringify(SOURCE)};
      const p = spawnDisclaimed(["/bin/sleep", "3"]);
      if (!p) { console.log(JSON.stringify({ none: true })); process.exit(0); }
      const t0 = Date.now(), c0 = process.cpuUsage();
      const code = await p.exited;
      const c = process.cpuUsage(c0);
      console.log(JSON.stringify({ code, cpuMs: (c.user + c.system) / 1000, waitedMs: Date.now() - t0 }));
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const r = JSON.parse(out.trim().split("\n").at(-1)!) as { none?: true; code: number; cpuMs: number; waitedMs: number };
    if (r.none) return; // no libSystem spawn here: nothing to wait on
    expect(r.code).toBe(0);
    expect(r.waitedMs).toBeGreaterThanOrEqual(2_900);
    expect(r.waitedMs).toBeLessThan(4_000);
    // Spinning, this was ~2,500 ms of CPU in the 3 s.
    expect(r.cpuMs).toBeLessThan(150);
  }, 20_000);

  test("the loop's wait timer is a slow one", () => {
    expect(DISCLAIMED_GUARD_MS).toBeGreaterThanOrEqual(5_000);
  });
});
