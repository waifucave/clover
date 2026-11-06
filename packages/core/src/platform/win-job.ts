// A job object for one agent's process tree on Windows (spec §9.3, from K-M1): its containment, and the
// bridge's caller check. On Windows a process can name any process it can open as its parent
// (PROC_THREAD_ATTRIBUTE_PARENT_PROCESS), and pids are reused quickly, so the process tree proves
// nothing there; membership of the agent's job does.
//   - The job is unnamed, so no other process can open it by name, and allows no breakaway: neither
//     JOB_OBJECT_LIMIT_BREAKAWAY_OK nor SILENT_BREAKAWAY_OK is set, so CREATE_BREAKAWAY_FROM_JOB fails
//     and every child the agent starts is in the job too.
//   - JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: closing the job (`close`, or the daemon dying) ends every
//     process still in it, so an agent never outlives its delegation or the daemon.
//   - `assign` puts a process the daemon has just spawned in the job. Node's and Bun's spawns can't
//     start a process suspended, so the agent runs for a moment first; `assign` then also takes every
//     process it started in that moment (by parent, and created after it), so nothing it started
//     escapes. A process that escaped anyway fails the bridge's check: it fails closed.
//   - `contains(pid)` is the bridge's check (IsProcessInJob); `pids()` lists the tree, for the stall
//     watchdog and for `TaskStop`; `terminate` ends it.
// Nested jobs (Windows 8 and later) let this work when the daemon itself runs in a job, as Task
// Scheduler starts it. Elsewhere `AgentJob.create()` returns null.
import { ffiLib, ffiPtr as ptr, type FfiLib } from "./ffi";

function k32(): FfiLib | null {
  if (process.platform !== "win32") return null;
  return ffiLib("win-job-k32", "kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
    SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    QueryInformationJobObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
    IsProcessInJob: { args: ["u64", "u64", "ptr"], returns: "i32" },
    TerminateJobObject: { args: ["u64", "u32"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    CreateToolhelp32Snapshot: { args: ["u32", "u32"], returns: "u64" },
    Process32FirstW: { args: ["u64", "ptr"], returns: "i32" },
    Process32NextW: { args: ["u64", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    GetCurrentProcess: { args: [], returns: "u64" },
  });
}

const JobObjectBasicLimitInformation = 2, JobObjectBasicProcessIdList = 3, JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x800, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_TERMINATE = 0x1, PROCESS_SET_QUOTA = 0x100, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TH32CS_SNAPPROCESS = 0x2, INVALID_HANDLE = 0xffffffffffffffffn;
/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows; LimitFlags sits at 16. */
const EXTENDED_LIMIT_SIZE = 144, LIMIT_FLAGS_AT = 16;
/** PROCESSENTRY32W on 64-bit Windows: th32ProcessID at 8, th32ParentProcessID at 32. */
const PROCESSENTRY32W_SIZE = 568;

function withProcess<T>(pid: number, access: number, fn: (h: bigint) => T, otherwise: T): T {
  const k = k32();
  if (!k || !Number.isInteger(pid) || pid <= 0) return otherwise;
  const h = k.OpenProcess!(access, 0, pid) as bigint;
  if (!h) return otherwise;
  try { return fn(h); } finally { k.CloseHandle!(h); }
}

/** When a process was created, in FILETIME ticks; null when it can't be opened. */
function createdAt(pid: number): bigint | null {
  return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, (h) => {
    const [created, exited, kernel, user] = [new BigUint64Array(1), new BigUint64Array(1), new BigUint64Array(1), new BigUint64Array(1)];
    const ok = k32()!.GetProcessTimes!(h, ptr(created), ptr(exited), ptr(kernel), ptr(user)) as number;
    return ok ? created[0]! : null;
  }, null);
}

/** Every process's parent, from a Toolhelp snapshot. */
function parents(): Map<number, number> {
  const k = k32();
  const out = new Map<number, number>();
  if (!k) return out;
  const snap = k.CreateToolhelp32Snapshot!(TH32CS_SNAPPROCESS, 0) as bigint;
  if (!snap || snap === INVALID_HANDLE) return out;
  try {
    const e = Buffer.alloc(PROCESSENTRY32W_SIZE);
    e.writeUInt32LE(PROCESSENTRY32W_SIZE, 0);
    for (let ok = k.Process32FirstW!(snap, ptr(e)) as number; ok; ok = k.Process32NextW!(snap, ptr(e)) as number) {
      out.set(e.readUInt32LE(8), e.readUInt32LE(32));
    }
  } finally { k.CloseHandle!(snap); }
  return out;
}

export class AgentJob {
  private closed = false;
  private constructor(private readonly handle: bigint) {}

  /** A new unnamed job: no breakaway, every process in it ended when it closes. Null off Windows, or
   *  when the job can't be made (the caller refuses to start the agent: fail closed). */
  static create(): AgentJob | null {
    const k = k32();
    if (!k) return null;
    const h = k.CreateJobObjectW!(null, null) as bigint;
    if (!h) return null;
    const info = Buffer.alloc(EXTENDED_LIMIT_SIZE);
    info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_AT);
    if ((k.SetInformationJobObject!(h, JobObjectExtendedLimitInformation, ptr(info), info.length) as number) === 0) {
      k.CloseHandle!(h);
      return null;
    }
    return new AgentJob(h);
  }

  /** Puts `pid` in the job, with every process it has started since it was created. False when `pid`
   *  itself can't be assigned (gone, or not the user's). */
  assign(pid: number): boolean {
    if (this.closed || !this.assignOne(pid)) return false;
    // What it started before it was in the job: children by parent pid, created after their parent
    // (a parent pid can be stale and reused), breadth first.
    const tree = parents();
    const born = new Map<number, bigint | null>();
    const bornOf = (p: number) => { if (!born.has(p)) born.set(p, createdAt(p)); return born.get(p)!; };
    const queue = [pid];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const parent = queue.shift()!;
      const parentBorn = bornOf(parent);
      if (parentBorn === null) continue;
      for (const [child, ppid] of tree) {
        if (ppid !== parent || seen.has(child)) continue;
        const childBorn = bornOf(child);
        if (childBorn === null || childBorn < parentBorn) continue;
        seen.add(child);
        if (!this.contains(child)) this.assignOne(child);
        queue.push(child);
      }
    }
    return true;
  }

  private assignOne(pid: number): boolean {
    return withProcess(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE, (h) => (k32()!.AssignProcessToJobObject!(this.handle, h) as number) !== 0, false);
  }

  /** Whether `pid` runs in this job: the bridge's caller check on Windows. */
  contains(pid: number): boolean {
    if (this.closed) return false;
    return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, (h) => {
      const r = new Int32Array(1);
      return (k32()!.IsProcessInJob!(h, this.handle, ptr(r)) as number) !== 0 && r[0] !== 0;
    }, false);
  }

  /** The pids of every process now in the job. */
  pids(): number[] {
    const k = k32();
    if (!k || this.closed) return [];
    for (let room = 256; room <= 65_536; room *= 4) {
      const buf = Buffer.alloc(8 + 8 * room);
      if ((k.QueryInformationJobObject!(this.handle, JobObjectBasicProcessIdList, ptr(buf), buf.length, null) as number) === 0) {
        if ((k.GetLastError!() as number) === 234 /* ERROR_MORE_DATA */) continue;
        return [];
      }
      const n = buf.readUInt32LE(4);
      return Array.from({ length: n }, (_, i) => Number(buf.readBigUInt64LE(8 + 8 * i)));
    }
    return [];
  }

  /** The job's limit flags, to check it allows no breakaway. */
  limitFlags(): number | null {
    const k = k32();
    if (!k || this.closed) return null;
    const info = Buffer.alloc(64);
    if ((k.QueryInformationJobObject!(this.handle, JobObjectBasicLimitInformation, ptr(info), info.length, null) as number) === 0) return null;
    return info.readUInt32LE(LIMIT_FLAGS_AT);
  }

  /** Ends every process in the job (`TaskStop`'s last step). */
  terminate(exitCode = 1): boolean {
    if (this.closed) return false;
    return (k32()!.TerminateJobObject!(this.handle, exitCode) as number) !== 0;
  }

  /** Closes the job, which ends whatever still runs in it. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    k32()?.CloseHandle!(this.handle);
  }
}

export const JOB_LIMITS = { JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } as const;

// The daemon's own job (review B1): the daemon joins it at start, so every process it starts, however indirectly,
// runs in it (no breakaway), and a process in it is never the user or the app. The app starts through the Task
// Scheduler and the CLI from the user's terminal, so neither is. The agents' jobs nest inside it. It has no
// kill-on-close: what the daemon leaves running when it exits is the agents' jobs' and the stop's to end.
let daemonJob: bigint | null = null;

/** Puts this process (the daemon) in a job of its own. False off Windows, or when it can't. */
export function enterDaemonJob(): boolean {
  const k = k32();
  if (!k) return false;
  if (daemonJob !== null) return true;
  const h = k.CreateJobObjectW!(null, null) as bigint;
  if (!h) return false;
  if ((k.AssignProcessToJobObject!(h, k.GetCurrentProcess!()) as number) === 0) { k.CloseHandle!(h); return false; }
  daemonJob = h;
  return true;
}

/** Whether `pid` runs in the daemon's job (always false before `enterDaemonJob`, and for the daemon itself). */
export function inDaemonJob(pid: number): boolean {
  const k = k32();
  if (!k || daemonJob === null || pid === process.pid) return false;
  const job = daemonJob;
  return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, (h) => {
    const r = new Int32Array(1);
    return (k.IsProcessInJob!(h, job, ptr(r)) as number) !== 0 && r[0] !== 0;
  }, false);
}
