// The acceptance run's reaper (lane HV): every process a run started is gone when the run ends, pass, fail or interrupted,
// and one that outlived what the run ended by itself is named, so the run fails on it.
//
// What a run starts is found two ways, both its own and nothing else's:
// * the process groups of its children (`startChild` spawns each detached, its own group, its pid the group's id);
// * every process whose executable lies under one of the run's own temp folders (a fresh `mkdtemp` per run): the hosts its
//   engines start through Launch Services are launchd's children, in none of the run's groups, by pids the run may never
//   have seen (an engine that saw its host end without a word counts a crash and starts another 0.5 s later), but each runs
//   the run's own copy of the app (`<root>/host-app/…`), and so do its helpers.
// Never by a name or a pattern: a folder only this run made, and groups only it made.
import { spawnSync } from "node:child_process";
import { readlinkSync, realpathSync } from "node:fs";

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** The executable's path (`ps -o comm=` on macOS holds the whole path). */
  exe: string;
}

/** Every process now (`ps -axo pid=,ppid=,pgid=,comm=`), or [] when ps can't be read. macOS's `comm` is the executable's whole
 *  path; Linux's is its short name, so there the path is read from `/proc/<pid>/exe` (a process not ours to read keeps its
 *  short name, which lies under no folder). */
export function listProcesses(): ProcRow[] {
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,comm="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const rows = parsePs(r.stdout ?? "");
  if (process.platform !== "linux") return rows;
  return rows.map((p) => { try { return { ...p, exe: readlinkSync(`/proc/${p.pid}/exe`) }; } catch { return p; } });
}

export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m === null) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), exe: m[4]! });
  }
  return rows;
}

/** A folder and its real path (macOS's `/var/folders/…` is `/private/var/folders/…`, which `ps` prints). */
export function rootForms(root: string): string[] {
  let real = root;
  try { real = realpathSync(root); } catch { /* gone: its spelling stands */ }
  return [...new Set([root, real].map((r) => r.replace(/\/+$/, "")))];
}

/** The processes of a run: in one of its groups, or running an executable under one of its folders; never `self`. */
export function runProcesses(rows: readonly ProcRow[], o: { roots: readonly string[]; groups: readonly number[]; self?: number }): ProcRow[] {
  const roots = o.roots.flatMap(rootForms).map((r) => `${r}/`);
  const groups = new Set(o.groups.filter((g) => g > 1));
  const self = o.self ?? process.pid;
  return rows.filter((p) => p.pid !== self && p.pid > 1 && (groups.has(p.pgid) || roots.some((r) => p.exe.startsWith(r))));
}

export interface ReapResult {
  /** What was still there `settleMs` after the run had ended all it knew of: leftovers, each ended here. */
  leftovers: ProcRow[];
  /** Leftovers that SIGTERM and then SIGKILL did not end. */
  survivors: ProcRow[];
}

export interface ReapOptions {
  roots: readonly string[];
  groups: readonly number[];
  /** How long the run's own ending may take to finish by itself (a host's helpers go a moment after it). */
  settleMs?: number;
  /** How long a leftover gets after SIGTERM before SIGKILL. */
  graceMs?: number;
  self?: number;
  list?: () => ProcRow[];
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Waits for the run's processes to go (`settleMs`), then ends each one left: SIGTERM, then SIGKILL after `graceMs`. */
export async function reap(o: ReapOptions): Promise<ReapResult> {
  const list = o.list ?? listProcesses;
  const kill = o.kill ?? ((pid, sig) => { try { process.kill(pid, sig); } catch { /* gone */ } });
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const find = () => runProcesses(list(), o);
  const settle = o.settleMs ?? 10_000;
  const grace = o.graceMs ?? 5_000;
  const step = 250;
  let left = find();
  for (let waited = 0; left.length > 0 && waited < settle; waited += step) {
    await sleep(step);
    left = find();
  }
  const leftovers = left;
  if (leftovers.length === 0) return { leftovers, survivors: [] };
  for (const p of leftovers) kill(p.pid, "SIGTERM");
  const alive = () => { const now = new Set(find().map((p) => p.pid)); return leftovers.filter((p) => now.has(p.pid)); };
  let still = alive();
  for (let waited = 0; still.length > 0 && waited < grace; waited += step) {
    await sleep(step);
    still = alive();
  }
  for (const p of still) kill(p.pid, "SIGKILL");
  for (let waited = 0; still.length > 0 && waited < 2_000; waited += step) {
    await sleep(step);
    still = alive();
  }
  return { leftovers, survivors: still };
}

/** One line naming the leftovers (pid, parent, executable's last parts). */
export function nameLeftovers(rows: readonly ProcRow[], max = 8): string {
  const name = (p: ProcRow) => `pid ${p.pid} (parent ${p.ppid}) ${p.exe.split("/").slice(-3).join("/")}`;
  return `${rows.slice(0, max).map(name).join("; ")}${rows.length > max ? `; and ${rows.length - max} more` : ""}`;
}
