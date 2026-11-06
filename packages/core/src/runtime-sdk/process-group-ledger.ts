// A-M1 review S2: NO SESSION CHILD OUTLIVES THE DAEMON, EVEN WHEN THE DAEMON DIES ABRUPTLY.
//
// An embedded session's Bash and Monitor commands, stdio MCP servers, command hooks and workflow worker each
// run as a process group of their own (`setsid`), started from the session's Worker. While the daemon lives,
// `embedded.ts` reaps whatever a closed Worker left running. A spawned `winter` child used to have a second
// line of defence (it watched its parent and killed its groups when the daemon vanished); a Worker has none,
// because it IS the daemon. So when clover-core is SIGKILLed, runs out of memory or crashes natively, those
// groups keep running with no owner, and nothing at the next boot knew they existed.
//
// THE LEDGER. While any Worker is live, the embedded host writes the live groups to
// `<home>/run/embedded-process-groups.json`, each with its leader's start time as `ps -o lstart=` reports it
// (C locale, UTC). A clean shutdown reaps the groups and removes the file. At boot, before any session runs,
// the host sweeps a ledger a dead daemon left behind: a group is SIGKILLed (`-pgid`, the whole group) only
// when its leader is still the very process that was recorded (same pid, same start time). Anything else is
// left alone, fail-safe: the plugin supervisor's `sweepOrphans` rule. Then the file is removed.
//
// Residuals, stated: a group created in the instant before an abrupt death may not be in the ledger yet
// (the ledger follows the Worker's own reports, checked once a second while Workers live); a group whose
// leader has already exited while members live cannot be verified and is left alone; and `ps` must work.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One recorded group: its id (its leader's pid) and the leader's start time (`ps -o lstart=`, C locale, UTC). */
export interface LedgerEntry {
  pgid: number;
  startedAt: string;
}

interface LedgerFile {
  version: 1;
  /** The daemon that wrote it (for the log line only: a dead daemon's pid means nothing at the next boot). */
  daemonPid: number;
  groups: LedgerEntry[];
}

export interface ProcessGroupLedgerDeps {
  home: string;
  /** The leader's start time, or `null` when it cannot be read (gone, or no working `ps`). Default: `ps`. */
  startedAt?: (pid: number) => string | null;
  /** SIGKILL the whole group. Default: `process.kill(-pgid, "SIGKILL")`. */
  killGroup?: (pgid: number) => boolean;
  log?: (line: string) => void;
}

export function processGroupLedgerPath(home: string): string {
  return join(home, "run", "embedded-process-groups.json");
}

/** `ps -o lstart= -p <pid>` in the C locale and UTC, so a reading compares equal across a locale or zone change. */
export function processStartedAt(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return null;
    const out = result.stdout.toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function killGroupDefault(pgid: number): boolean {
  try {
    process.kill(-pgid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function readLedger(path: string): LedgerFile | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LedgerFile>;
    const groups = Array.isArray(parsed.groups)
      ? parsed.groups.filter((g): g is LedgerEntry => !!g && Number.isInteger(g.pgid) && g.pgid > 1 && g.pgid !== process.pid && typeof g.startedAt === "string" && g.startedAt.length > 0)
      : [];
    return { version: 1, daemonPid: Number.isInteger(parsed.daemonPid) ? (parsed.daemonPid as number) : 0, groups };
  } catch {
    return { version: 1, daemonPid: 0, groups: [] };
  }
}

/**
 * At boot, before any session runs: kill what a dead daemon's sessions left running, and remove its ledger.
 * Returns the groups killed and the ones left alone (unverifiable or no longer the recorded process).
 */
export function sweepProcessGroupLedger(deps: ProcessGroupLedgerDeps): { killed: number[]; leftAlone: number[] } {
  const path = processGroupLedgerPath(deps.home);
  const ledger = readLedger(path);
  if (ledger === undefined) return { killed: [], leftAlone: [] };
  const startedAt = deps.startedAt ?? processStartedAt;
  const killGroup = deps.killGroup ?? killGroupDefault;
  const killed: number[] = [];
  const leftAlone: number[] = [];
  for (const entry of ledger.groups) {
    // The identity check: the pid must still be the recorded leader. A reused pid starts later; a gone one reads null.
    if (startedAt(entry.pgid) === entry.startedAt && killGroup(entry.pgid)) killed.push(entry.pgid);
    else leftAlone.push(entry.pgid);
  }
  rmSync(path, { force: true });
  if (killed.length > 0 || leftAlone.length > 0) {
    deps.log?.(`process groups a previous daemon (pid ${ledger.daemonPid}) left running: killed ${killed.length}${leftAlone.length > 0 ? `, left ${leftAlone.length} that could not be verified as the recorded process` : ""}`);
  }
  return { killed, leftAlone };
}

/**
 * The live half: `update(groups)` with every live Worker's `processGroups()`; it records each new group with
 * its leader's start time and rewrites the file (atomically) only when the set changed. `update([])` removes it.
 */
export function createProcessGroupLedger(deps: ProcessGroupLedgerDeps): { update(groups: Iterable<number>): void; clear(): void } {
  const path = processGroupLedgerPath(deps.home);
  const startedAt = deps.startedAt ?? processStartedAt;
  const recorded = new Map<number, string>();
  /** Groups whose leader could not be read: not recorded (unverifiable later), and not looked up again. */
  const unreadable = new Set<number>();
  const write = (): void => {
    if (recorded.size === 0) {
      rmSync(path, { force: true });
      return;
    }
    const file: LedgerFile = { version: 1, daemonPid: process.pid, groups: [...recorded].map(([pgid, at]) => ({ pgid, startedAt: at })) };
    try {
      mkdirSync(join(deps.home, "run"), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      deps.log?.(`process-group ledger: could not be written (${error instanceof Error ? error.message : String(error)})`);
    }
  };
  return {
    update(groups: Iterable<number>): void {
      const now = new Set<number>();
      for (const g of groups) if (Number.isInteger(g) && g > 1 && g !== process.pid) now.add(g);
      let changed = false;
      for (const pgid of [...recorded.keys()]) if (!now.has(pgid)) { recorded.delete(pgid); changed = true; }
      for (const pgid of [...unreadable]) if (!now.has(pgid)) unreadable.delete(pgid);
      for (const pgid of now) {
        if (recorded.has(pgid) || unreadable.has(pgid)) continue;
        const at = startedAt(pgid);
        if (at === null) { unreadable.add(pgid); continue; }
        recorded.set(pgid, at);
        changed = true;
      }
      if (changed) write();
    },
    clear(): void {
      recorded.clear();
      unreadable.clear();
      rmSync(path, { force: true });
    },
  };
}
