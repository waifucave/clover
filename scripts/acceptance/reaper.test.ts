// The acceptance run's reaper (reaper.ts): a process the run started that outlives what the run ended is found by the
// run's own folder or group, named, and ended even when it ignores SIGTERM; nothing outside the run's folder and groups
// is ever touched.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, linkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProcesses, nameLeftovers, parsePs, reap, rootForms, runProcesses, type ProcRow } from "./reaper";

describe("which processes are a run's", () => {
  const rows: ProcRow[] = [
    { pid: 10, ppid: 1, pgid: 10, exe: "/private/var/folders/x/T/clv-acc-abc/host-app/MOSS Host Acceptance.app/Contents/MacOS/Electron" },
    { pid: 11, ppid: 10, pgid: 10, exe: "/private/var/folders/x/T/clv-acc-abc/host-app/MOSS Host Acceptance.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper" },
    { pid: 20, ppid: 1, pgid: 20, exe: "/private/var/folders/x/T/clv-acc-abcd/host-app/x" },
    { pid: 30, ppid: 5, pgid: 30, exe: "/usr/bin/sleep" },
    { pid: 31, ppid: 30, pgid: 30, exe: "/usr/bin/true" },
    { pid: 40, ppid: 1, pgid: 40, exe: "/Applications/Other.app/Contents/MacOS/Other" },
  ];
  test("by the run's own folder (its real path too), and by its children's groups; never a sibling folder or another program", () => {
    const mine = runProcesses(rows, { roots: ["/private/var/folders/x/T/clv-acc-abc"], groups: [30], self: 999 }).map((p) => p.pid);
    expect(mine).toEqual([10, 11, 30, 31]);
  });
  test("never itself, never launchd or a group of 1", () => {
    expect(runProcesses([{ pid: 999, ppid: 1, pgid: 1, exe: "/private/var/folders/x/T/clv-acc-abc/bun" }, { pid: 1, ppid: 0, pgid: 1, exe: "/sbin/launchd" }], { roots: ["/private/var/folders/x/T/clv-acc-abc"], groups: [1], self: 999 })).toEqual([]);
  });
  test("ps's lines, paths with spaces whole", () => {
    expect(parsePs("  10     1    10 /a b/c d\n bad line\n")).toEqual([{ pid: 10, ppid: 1, pgid: 10, exe: "/a b/c d" }]);
  });
  test("a leftover is named by its pid, its parent and its executable", () => {
    expect(nameLeftovers([rows[0]!])).toBe("pid 10 (parent 1) Contents/MacOS/Electron");
  });
});

const made: string[] = [];
/** A program of the run's own under `root`: this Bun, linked there (a copied system binary is killed by its signature). */
function ownProgram(root: string, name: string): string {
  const exe = join(root, name);
  try { linkSync(process.execPath, exe); } catch { copyFileSync(process.execPath, exe); }
  return exe;
}
/** A script that never ends and takes no notice of SIGTERM. */
const DEAF = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
const started: ChildProcess[] = [];
afterAll(() => {
  for (const c of started) { try { process.kill(c.pid!, "SIGKILL"); } catch { /* gone */ } }
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe.if(process.platform !== "win32")("the reaper on real processes", () => {
  test("a child that ignores SIGTERM and runs from the run's folder (a host the run never saw) is named and ended", async () => {
    const root = mkdtempSync(join(tmpdir(), "clv-reap-"));
    made.push(root);
    // A program under the run's folder that ignores SIGTERM, started detached so it is in none of the groups the reaper is
    // told of: only the folder finds it.
    const exe = ownProgram(root, "fake-host");
    const child = spawn(exe, ["-e", DEAF], { detached: true, stdio: "ignore" });
    started.push(child);
    child.unref();
    const forms = rootForms(root);
    const seen = async () => { for (let i = 0; i < 40; i++) { if (runProcesses(listProcesses(), { roots: [root], groups: [] }).some((p) => p.pid === child.pid)) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
    expect(await seen()).toBe(true);
    const r = await reap({ roots: [root], groups: [], settleMs: 300, graceMs: 500 });
    expect(r.leftovers.map((p) => p.pid)).toEqual([child.pid!]);
    expect(forms.some((f) => r.leftovers[0]!.exe.startsWith(`${f}/`))).toBe(true);
    expect(r.survivors).toEqual([]);
    expect(runProcesses(listProcesses(), { roots: [root], groups: [] })).toEqual([]);
  }, 20_000);

  test("a process that ends by itself within the settle time is no leftover", async () => {
    const root = mkdtempSync(join(tmpdir(), "clv-reap-"));
    made.push(root);
    const exe = ownProgram(root, "fake-helper");
    const child = spawn(exe, ["-e", "setTimeout(() => {}, 500)"], { detached: true, stdio: "ignore" });
    started.push(child);
    const r = await reap({ roots: [root], groups: [], settleMs: 3_000, graceMs: 500 });
    expect(r.leftovers).toEqual([]);
  }, 20_000);

  test("by its group alone: a child of the run's whose executable is elsewhere", async () => {
    const child = spawn(process.execPath, ["-e", DEAF], { detached: true, stdio: "ignore" });
    started.push(child);
    await new Promise((r) => setTimeout(r, 200));
    const r = await reap({ roots: [], groups: [child.pid!], settleMs: 200, graceMs: 300 });
    expect(r.leftovers.map((p) => p.pid)).toEqual([child.pid!]);
    expect(r.survivors).toEqual([]);
  }, 20_000);
});
