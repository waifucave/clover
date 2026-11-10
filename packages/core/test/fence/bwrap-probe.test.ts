// Linux's bwrap probe (lane C's fenced process; INT, #369's review): run off the event loop, warmed at the daemon's
// start rather than as a blocking spawn on a hook's first run, and tried again after a while when it failed, so a bwrap
// installed meanwhile works without a restart. A stand-in `bwrap` script plays both answers; the probe's path is
// Linux's (`os: "linux"`) on any computer that has /bin/sh.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloverFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const run = { command: "true", cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5_000, who: { caller: { kind: "core" as const } } };

test("no bwrap: closed at once, the warm-up and a run refuse with the reason", async () => {
  const home = temp("clover-probe-home-");
  const s = fencedSpawner({ fence: new CloverFence({ home, cloverHome: join(home, ".clover") }), os: "linux", bwrap: join(home, "no-bwrap") });
  expect(s.available).toBe(false);
  await s.warm?.();
  expect(s.available).toBe(false);
  expect(await s.run(run)).toEqual({ kind: "refused", reason: expect.stringContaining("bubblewrap isn't installed") });
});

test("a bwrap that fails: the warm-up learns it off the event loop; after the retry window a bwrap that works is used, with no restart", async () => {
  const home = temp("clover-probe-home-");
  const bwrap = join(home, "bwrap");
  writeFileSync(bwrap, "#!/bin/sh\necho 'no user namespaces' >&2\nexit 1\n");
  chmodSync(bwrap, 0o755);
  const s = fencedSpawner({ fence: new CloverFence({ home, cloverHome: join(home, ".clover") }), os: "linux", bwrap, probeRetryMs: 50 });
  // Before the probe answers: there is a bwrap, so not closed yet.
  expect(s.available).toBe(true);
  const warmed = s.warm!();
  expect(warmed).toBeInstanceOf(Promise); // the probe never blocks its caller
  await warmed;
  expect(s.available).toBe(false);
  expect(await s.run(run)).toEqual({ kind: "refused", reason: expect.stringContaining("no user namespaces") });
  // Fixed meanwhile (installed, or namespaces opened): inside the window the answer stands, after it the probe runs again.
  writeFileSync(bwrap, "#!/bin/sh\nexit 0\n");
  expect(await s.run(run)).toEqual({ kind: "refused", reason: expect.stringContaining("no user namespaces") });
  await Bun.sleep(80);
  const after = await s.run(run);
  expect(JSON.stringify(after)).not.toContain("bubblewrap");
  expect(s.available).toBe(true);
});
