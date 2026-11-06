// What the app's processes cost: CPU seconds and memory per process, from app.getAppMetrics(), plus the better
// memory numbers each OS has — Linux's proportional set size (shared pages split between the processes that map
// them) and macOS's physical footprint (what Activity Monitor shows), read by a tiny Bun helper over libproc.
// Windows' privateBytes comes from Electron itself.
import { app } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProcSample {
  pid: number;
  type: string;
  name?: string;
  /** Seconds of CPU since the process started. */
  cpuSec: number;
  /** Working set (resident), bytes. */
  rss: number;
  /** Windows: private bytes. */
  privateBytes?: number;
  /** Linux: proportional set size, bytes. */
  pss?: number;
  /** macOS: physical footprint, bytes. */
  footprint?: number;
}

export interface Sample {
  at: number;
  procs: ProcSample[];
}

function linuxPss(pid: number): number | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const m = /^Pss:\s+(\d+) kB/m.exec(text);
    return m === null ? undefined : Number(m[1]) * 1024;
  } catch {
    return undefined;
  }
}

let footprintCli: string | null | undefined;
function macFootprints(pids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (process.platform !== "darwin" || pids.length === 0) return out;
  if (footprintCli === undefined) {
    const root = process.env.S7_ROOT;
    const cli = root === undefined ? "" : join(root, "src", "shared", "footprint-cli.ts");
    footprintCli = cli !== "" && existsSync(cli) ? cli : null;
  }
  if (footprintCli === null) return out;
  try {
    const text = execFileSync("bun", [footprintCli, ...pids.map(String)], { encoding: "utf8", timeout: 5000 });
    const parsed = JSON.parse(text) as Record<string, number>;
    for (const [k, v] of Object.entries(parsed)) out.set(Number(k), v);
  } catch {
    footprintCli = null; // bun not reachable: stop trying
  }
  return out;
}

/** One reading of every app process. `extra` adds the OS's better memory numbers (slower: use per step, not per tick). */
export function sample(extra = false): Sample {
  const metrics = app.getAppMetrics();
  const procs: ProcSample[] = metrics.map((m) => {
    const cpu = m.cpu.cumulativeCPUUsage;
    const p: ProcSample = {
      pid: m.pid,
      type: m.type,
      name: m.name ?? m.serviceName,
      cpuSec: typeof cpu === "number" ? cpu : Number.NaN,
      rss: m.memory.workingSetSize * 1024,
    };
    if (typeof m.memory.privateBytes === "number") p.privateBytes = m.memory.privateBytes * 1024;
    return p;
  });
  if (extra) {
    if (process.platform === "linux") for (const p of procs) { const v = linuxPss(p.pid); if (v !== undefined) p.pss = v; }
    if (process.platform === "darwin") {
      const fp = macFootprints(procs.map((p) => p.pid));
      for (const p of procs) { const v = fp.get(p.pid); if (v !== undefined) p.footprint = v; }
    }
  }
  return { at: Date.now(), procs };
}

export interface CpuWindow {
  seconds: number;
  /** CPU % of one core, by process type ("Browser", "GPU", "Tab", "Utility"…), and in total. */
  byType: Record<string, number>;
  total: number;
  /** CPU % of one core for the given pids (a tab's renderer). */
  byPid: Record<string, number>;
}

/** CPU used between two samples, as % of one core. */
export function cpuBetween(a: Sample, b: Sample): CpuWindow {
  const dt = (b.at - a.at) / 1000;
  const before = new Map(a.procs.map((p) => [p.pid, p]));
  const byType: Record<string, number> = {};
  const byPid: Record<string, number> = {};
  let total = 0;
  for (const p of b.procs) {
    const q = before.get(p.pid);
    const used = q === undefined ? p.cpuSec : p.cpuSec - q.cpuSec;
    if (!Number.isFinite(used) || dt <= 0) continue;
    const pct = (used / dt) * 100;
    byType[p.type] = (byType[p.type] ?? 0) + pct;
    byPid[String(p.pid)] = pct;
    total += pct;
  }
  return { seconds: dt, byType, total, byPid };
}

export interface MemTotals {
  procs: number;
  rss: number;
  pss?: number;
  footprint?: number;
  privateBytes?: number;
  /** The best number this OS has: footprint (macOS), PSS (Linux), private bytes (Windows), else RSS. */
  best: number;
  bestKind: string;
}

export function memTotals(s: Sample): MemTotals {
  let rss = 0, pss = 0, fp = 0, pb = 0, nPss = 0, nFp = 0, nPb = 0;
  for (const p of s.procs) {
    rss += p.rss;
    if (p.pss !== undefined) { pss += p.pss; nPss++; }
    if (p.footprint !== undefined) { fp += p.footprint; nFp++; }
    if (p.privateBytes !== undefined) { pb += p.privateBytes; nPb++; }
  }
  const t: MemTotals = { procs: s.procs.length, rss, best: rss, bestKind: "rss" };
  if (nPss === s.procs.length && nPss > 0) { t.pss = pss; t.best = pss; t.bestKind = "pss"; }
  if (nFp === s.procs.length && nFp > 0) { t.footprint = fp; t.best = fp; t.bestKind = "footprint"; }
  if (nPb === s.procs.length && nPb > 0) { t.privateBytes = pb; t.best = pb; t.bestKind = "privateBytes"; }
  return t;
}
