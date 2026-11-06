// A-M1 review S2: no session child outlives the daemon, even when the daemon dies abruptly. The embedded host
// writes the live Workers' process groups (with their leaders' start times) under `<home>/run/`, and the next
// boot kills what a dead daemon left there, only on a verified start-time match (`process-group-ledger.ts`).
import { describe, expect, test } from "bun:test";
import { spawn as spawnChild } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddedWorkerProcess } from "@waifucave/clover-agent-runtime/embedded-host";
import { createEmbeddedSessionHost, killProcessGroup } from "../../src/runtime-sdk/embedded";
import { createProcessGroupLedger, processGroupLedgerPath, processStartedAt, sweepProcessGroupLedger } from "../../src/runtime-sdk/process-group-ledger";

const tempHome = (): string => mkdtempSync(join(tmpdir(), "clover-pg-ledger-"));
const readLedger = (home: string): { daemonPid: number; groups: Array<{ pgid: number; startedAt: string }> } => JSON.parse(readFileSync(processGroupLedgerPath(home), "utf8"));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A detached `sleep`: its own session and process group (pgid = its pid), as a session's Bash command runs. */
function detachedGroup(): { pid: number; died: Promise<string | null> } {
  const child = spawnChild("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
  const died = new Promise<string | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
  child.unref();
  return { pid: child.pid!, died };
}

describe("the ledger", () => {
  test("follows the live groups: new ones recorded with their leader's start time, ended ones dropped, the file gone when none live", () => {
    const home = tempHome();
    try {
      const started = new Map([[4101, "Mon Jan  1 00:00:01 2026"], [4102, "Mon Jan  1 00:00:02 2026"]]);
      const ledger = createProcessGroupLedger({ home, startedAt: (pid) => started.get(pid) ?? null });
      ledger.update([4101, 4102, 4103 /* leader unreadable: not recorded, cannot be verified later */]);
      expect(readLedger(home)).toEqual({ daemonPid: process.pid, groups: [{ pgid: 4101, startedAt: "Mon Jan  1 00:00:01 2026" }, { pgid: 4102, startedAt: "Mon Jan  1 00:00:02 2026" }], version: 1 } as never);
      ledger.update([4102]);
      expect(readLedger(home).groups.map((g) => g.pgid)).toEqual([4102]);
      ledger.update([]);
      expect(existsSync(processGroupLedgerPath(home))).toBe(false);
      // Never 0, 1, a negative id or this process's own group.
      ledger.update([0, 1, -5, process.pid]);
      expect(existsSync(processGroupLedgerPath(home))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the boot sweep kills only a VERIFIED leader (same pid, same start time), leaves the rest alone, and removes the file", () => {
    const home = tempHome();
    try {
      mkdirSync(join(home, "run"), { recursive: true });
      writeFileSync(processGroupLedgerPath(home), JSON.stringify({ version: 1, daemonPid: 999999, groups: [{ pgid: 5001, startedAt: "A" }, { pgid: 5002, startedAt: "B" }, { pgid: 5003, startedAt: "C" }] }));
      const killed: number[] = [];
      const log: string[] = [];
      const now: Record<number, string | null> = { 5001: "A" /* still the recorded process */, 5002: "B-later" /* pid reused */, 5003: null /* gone */ };
      const result = sweepProcessGroupLedger({ home, startedAt: (pid) => now[pid] ?? null, killGroup: (pgid) => (killed.push(pgid), true), log: (l) => log.push(l) });
      expect(result).toEqual({ killed: [5001], leftAlone: [5002, 5003] });
      expect(killed).toEqual([5001]);
      expect(existsSync(processGroupLedgerPath(home))).toBe(false);
      expect(log).toEqual(["process groups a previous daemon (pid 999999) left running: killed 1, left 2 that could not be verified as the recorded process"]);
      // No ledger: nothing to do, nothing logged.
      expect(sweepProcessGroupLedger({ home, log: (l) => log.push(l) })).toEqual({ killed: [], leftAlone: [] });
      expect(log.length).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a REAL group a dead daemon left behind is SIGKILLed at the next boot; a live group whose start time does not match is not", async () => {
    const home = tempHome();
    const orphan = detachedGroup();
    const bystander = detachedGroup();
    try {
      // The daemon that "died": its ledger names both groups, the bystander with a start time that is not its own.
      const ledger = createProcessGroupLedger({ home });
      ledger.update([orphan.pid]);
      const recorded = readLedger(home);
      expect(recorded.groups).toEqual([{ pgid: orphan.pid, startedAt: processStartedAt(orphan.pid)! }]);
      writeFileSync(processGroupLedgerPath(home), JSON.stringify({ ...recorded, groups: [...recorded.groups, { pgid: bystander.pid, startedAt: "Thu Jan  1 00:00:00 1970" }] }));
      // The next boot.
      const result = sweepProcessGroupLedger({ home });
      expect(result).toEqual({ killed: [orphan.pid], leftAlone: [bystander.pid] });
      expect(await Promise.race([orphan.died, Bun.sleep(3000).then(() => "still running")])).toBe("SIGKILL");
      expect(alive(bystander.pid)).toBe(true);
    } finally {
      killProcessGroup(orphan.pid);
      killProcessGroup(bystander.pid);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the embedded host keeps the ledger", () => {
  function fakeWorker(groups: () => number[]): { proc: EmbeddedWorkerProcess; close: () => void } {
    let settle!: (v: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => (settle = resolve));
    const proc = { stdin: { write() {}, end() {} }, stdout: (async function* () {})(), kill() {}, terminate() {}, exited, pid: null, state: "running", processGroups: groups } as unknown as EmbeddedWorkerProcess;
    return { proc, close: () => settle({ code: 0, signal: null }) };
  }
  const spawnOptions = (sessionId: string) => ({ command: "clover-embedded", args: ["--run", "--config-json", JSON.stringify({ sessionId })], cwd: "/", env: {} });

  test("a live Worker's groups are written under <home>/run/, a closed Worker's removed, and a new host on the same home sweeps a dead one's", async () => {
    const home = tempHome();
    try {
      let groups = [7001];
      const worker = fakeWorker(() => groups);
      const startedAt = (pid: number): string | null => (pid === 7001 || pid === 7002 ? `start-${pid}` : null);
      const host = createEmbeddedSessionHost({ home, hostPathProtectionCapability: null, spawnWorker: () => worker.proc, processStartedAt: startedAt, killProcessGroup: () => true, ledgerRefreshMs: 20 });
      host.spawn(spawnOptions("ledgered-session"));
      expect(readLedger(home).groups).toEqual([{ pgid: 7001, startedAt: "start-7001" }]);
      // The session starts another group: the ledger follows within a refresh.
      groups = [7001, 7002];
      await Bun.sleep(80);
      expect(readLedger(home).groups.map((g) => g.pgid)).toEqual([7001, 7002]);
      // The daemon "dies" here (the Worker never closes): a new host on the same home kills both, verified.
      const killed: number[] = [];
      const reborn = createEmbeddedSessionHost({ home, hostPathProtectionCapability: null, processStartedAt: startedAt, killProcessGroup: (pgid) => (killed.push(pgid), true) });
      await reborn.shutdown(100);
      expect(killed).toEqual([7001, 7002]);
      expect(existsSync(processGroupLedgerPath(home))).toBe(false);
      // And on the first host, a clean close leaves no ledger behind.
      groups = [];
      worker.close();
      await worker.proc.exited;
      await Bun.sleep(0);
      expect(existsSync(processGroupLedgerPath(home))).toBe(false);
      await host.shutdown(100);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
