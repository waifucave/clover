// A process tree's memory and CPU, read from the OS (Bun only: it uses bun:ffi on macOS). Used for Chrome for
// Testing, whose processes the daemon starts itself.
//   Linux:   /proc — the tree from each process's parent, PSS from smaps_rollup, CPU from stat (utime + stime).
//   macOS:   one `ps` for the tree, RSS and CPU time; physical footprint from libproc's proc_pid_rusage.
//   Windows: one PowerShell call (Win32_Process): the tree, working set, private bytes, CPU times.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export interface TreeProc {
  pid: number;
  ppid: number;
  name: string;
  rss: number;
  cpuSec: number;
  pss?: number;
  footprint?: number;
  privateBytes?: number;
}

export interface TreeSample {
  at: number;
  root: number;
  procs: TreeProc[];
  rss: number;
  cpuSec: number;
  /** The best memory number this OS has (footprint, PSS, private bytes), else RSS. */
  best: number;
  bestKind: string;
}

/** The pids under `root` (root included), from a parent map. Pure. */
export function descendants(root: number, parentOf: ReadonlyMap<number, number>): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parentOf) {
    const list = children.get(ppid);
    if (list === undefined) children.set(ppid, [pid]); else list.push(pid);
  }
  const out: number[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (parentOf.has(pid) || pid === root) out.push(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return out;
}

/** `ps`'s TIME column ("[[dd-]hh:]mm:ss[.ss]") as seconds. Pure. */
export function parsePsTime(s: string): number {
  let days = 0;
  let rest = s.trim();
  const dash = rest.indexOf("-");
  if (dash > 0) { days = Number(rest.slice(0, dash)); rest = rest.slice(dash + 1); }
  const parts = rest.split(":").map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return days * 86400 + sec;
}

const CLK_TCK = 100;

function linuxTree(root: number): TreeProc[] {
  const parentOf = new Map<number, number>();
  const stat = new Map<number, { name: string; cpu: number; rss: number }>();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const text = readFileSync(`/proc/${d}/stat`, "utf8");
      const close = text.lastIndexOf(")");
      const name = text.slice(text.indexOf("(") + 1, close);
      const f = text.slice(close + 2).split(" ");
      // fields after the name: state(0) ppid(1) … utime(11) stime(12) … rss(21, pages)
      parentOf.set(Number(d), Number(f[1]));
      stat.set(Number(d), { name, cpu: (Number(f[11]) + Number(f[12])) / CLK_TCK, rss: Number(f[21]) * 4096 });
    } catch {
      // exited
    }
  }
  return descendants(root, parentOf).map((pid) => {
    const s = stat.get(pid);
    let pss: number | undefined;
    try {
      const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
      if (m !== null) pss = Number(m[1]) * 1024;
    } catch {
      // gone or not readable
    }
    return { pid, ppid: parentOf.get(pid) ?? 0, name: s?.name ?? "", rss: s?.rss ?? 0, cpuSec: s?.cpu ?? 0, pss };
  });
}

type Rusage = (pid: number) => number | undefined;
let rusage: Rusage | null | undefined;
async function macFootprintReader(): Promise<Rusage | null> {
  if (rusage !== undefined) return rusage;
  try {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    // struct rusage_info_v4: ri_uuid[16], then u64 fields; ri_phys_footprint is the eighth u64 (offset 72).
    rusage = (pid) => {
      const buf = Buffer.alloc(512);
      if (lib.symbols.proc_pid_rusage(pid, 4, ptr(buf)) !== 0) return undefined;
      return Number(buf.readBigUInt64LE(72));
    };
  } catch {
    rusage = null;
  }
  return rusage;
}

async function macTree(root: number): Promise<TreeProc[]> {
  const r = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,rss=,time=,comm="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const parentOf = new Map<number, number>();
  const info = new Map<number, { rss: number; cpu: number; name: string }>();
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    parentOf.set(Number(m[1]), Number(m[2]));
    info.set(Number(m[1]), { rss: Number(m[3]) * 1024, cpu: parsePsTime(m[4]!), name: m[5]!.split("/").pop() ?? "" });
  }
  const fp = await macFootprintReader();
  return descendants(root, parentOf).map((pid) => {
    const i = info.get(pid);
    return { pid, ppid: parentOf.get(pid) ?? 0, name: i?.name ?? "", rss: i?.rss ?? 0, cpuSec: i?.cpu ?? 0, footprint: fp?.(pid) };
  });
}

function windowsTree(root: number): TreeProc[] {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  let rows: Array<Record<string, number | string>> = [];
  try {
    const parsed = JSON.parse(r.stdout ?? "[]");
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
  const parentOf = new Map<number, number>();
  const byPid = new Map<number, Record<string, number | string>>();
  for (const row of rows) {
    parentOf.set(Number(row.ProcessId), Number(row.ParentProcessId));
    byPid.set(Number(row.ProcessId), row);
  }
  return descendants(root, parentOf).map((pid) => {
    const row = byPid.get(pid) ?? {};
    return {
      pid,
      ppid: parentOf.get(pid) ?? 0,
      name: String(row.Name ?? ""),
      rss: Number(row.WorkingSetSize ?? 0),
      privateBytes: Number(row.PrivatePageCount ?? 0),
      cpuSec: (Number(row.KernelModeTime ?? 0) + Number(row.UserModeTime ?? 0)) / 1e7,
    };
  });
}

/** One reading of the tree under `root`. */
export async function sampleTree(root: number): Promise<TreeSample> {
  const procs = process.platform === "linux" ? linuxTree(root) : process.platform === "darwin" ? await macTree(root) : windowsTree(root);
  const sum = (f: (p: TreeProc) => number | undefined): number | undefined => {
    let t = 0;
    for (const p of procs) { const v = f(p); if (v === undefined) return undefined; t += v; }
    return t;
  };
  const rss = sum((p) => p.rss) ?? 0;
  const fp = sum((p) => p.footprint);
  const pss = sum((p) => p.pss);
  const pb = sum((p) => p.privateBytes);
  const [best, bestKind] = fp !== undefined && procs.length > 0 ? [fp, "footprint"] : pss !== undefined && procs.length > 0 ? [pss, "pss"] : pb !== undefined && procs.length > 0 ? [pb, "privateBytes"] : [rss, "rss"];
  return { at: Date.now(), root, procs, rss, cpuSec: sum((p) => p.cpuSec) ?? 0, best, bestKind };
}

/** CPU % of one core used by the tree between two readings (processes that exited between them count nothing). */
export function treeCpuPct(a: TreeSample, b: TreeSample): number {
  const before = new Map(a.procs.map((p) => [p.pid, p.cpuSec]));
  let used = 0;
  for (const p of b.procs) used += p.cpuSec - (before.get(p.pid) ?? 0);
  const dt = (b.at - a.at) / 1000;
  return dt > 0 ? (used / dt) * 100 : Number.NaN;
}
