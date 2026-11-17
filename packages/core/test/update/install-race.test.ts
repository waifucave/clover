// Two app starts at the same instant (two PROCESSES, one home): the install lock lets one place the engine, and the loser
// just connects to what the winner placed. Temp home; the "engine" is a text file.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineBinaryPath } from "../../src/update/engine-copy";

const root = mkdtempSync(join(tmpdir(), "moss-rl-race-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const child = join(import.meta.dir, "fixtures", "install-child.ts");

function start(home: string, release: string, build: string, hold: number) {
  const p = Bun.spawn([process.execPath, child, home, release, build, String(hold)], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
  return p.exited.then(async (code) => ({ code, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() }));
}
const parse = (r: { out: string; err: string; code: number }) => { expect(r.err + String(r.code)).toBe("0"); return JSON.parse(r.out.trim().split("\n").pop()!) as { installed: boolean; current: { release: string; build?: string; from: string } }; };

test("two starts racing with the same copy: exactly one installs, the loser connects to it", async () => {
  const home = join(root, "same");
  const [a, b] = (await Promise.all([start(home, "1.0.0", "5", 400), start(home, "1.0.0", "5", 400)])).map(parse) as [ReturnType<typeof parse>, ReturnType<typeof parse>];
  expect([a.installed, b.installed].sort()).toEqual([false, true]);
  expect(a.current).toEqual(b.current);
  expect(readFileSync(engineBinaryPath(home), "utf8")).toBe("engine 1.0.0 5");
}, 30_000);

test("two starts racing with different builds: the newer build ends up installed, whichever came first", async () => {
  const home = join(root, "builds");
  const [a, b] = (await Promise.all([start(home, "1.0.0", "5", 300), start(home, "1.0.0", "9", 300)])).map(parse) as [ReturnType<typeof parse>, ReturnType<typeof parse>];
  expect(readFileSync(engineBinaryPath(home), "utf8")).toBe("engine 1.0.0 9");
  // The newer build installs whether it ran first or second; the older never replaces it.
  expect(b.installed).toBe(true);
  expect(b.current.build).toBe("9");
  expect(a.current.build).toBe(a.installed ? "5" : "9");
}, 30_000);
