// The process table, as the bridge's token check and the stall watchdog read it (spike S5 §7, edit 4):
// * the bridge accepts its token only from a process descended from that session's agent process;
// * while an `execute` call runs, a live process under the agent that started after the call began counts as
//   progress, since a running command sends nothing on the wire.
//
// macOS and Linux read `ps` once per question (one spawn, about 20 ms). Windows reads `Win32_Process` through
// PowerShell; that path is untested here (the core suite runs on macOS), and on Windows the bridge's check is job
// membership instead (S5 edit 4), which lane C's native caller check provides.
import { spawn } from "node:child_process";

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** When it started, in ms since the epoch, to the second (`ps`'s `etime`). */
  startedAt: number;
}

export type ProcessTableReader = () => Promise<ProcessRow[]>;

/** `[[dd-]hh:]mm:ss` → seconds. */
export function parseElapsed(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(mi) * 60 + Number(s);
}

/** Parses `ps -A -o pid=,ppid=,etime=` output. */
export function parsePs(out: string, now: number): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const elapsed = parseElapsed(parts[2]!);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || elapsed === null) continue;
    rows.push({ pid, ppid, startedAt: now - elapsed * 1000 });
  }
  return rows;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} took longer than ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** Reads this computer's process table. */
export const readProcessTable: ProcessTableReader = async () => {
  // `now` is read once the table has answered, not before: `ps` (and PowerShell's `Get-Date`) measure each process's
  // age when they run, which under load can be seconds after this call began, and a `now` taken before would make
  // every process look that much older (a command started after the call then reads as older than the call: a false
  // stall).
  if (process.platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $([int64]((Get-Date) - $_.CreationDate).TotalSeconds)\" }",
    ], 15_000);
    const now = Date.now();
    const rows: ProcessRow[] = [];
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid, secs] = line.trim().split(/\s+/).map(Number);
      if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isFinite(secs)) rows.push({ pid: pid!, ppid: ppid!, startedAt: now - secs! * 1000 });
    }
    return rows;
  }
  const out = await run("/bin/ps", ["-A", "-o", "pid=,ppid=,etime="], 10_000);
  return parsePs(out, Date.now());
};

/** Whether `pid` is `root` or descends from it. A loop in a stale table can't hang it. */
export function isDescendant(rows: readonly ProcessRow[], pid: number, root: number): boolean {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  let cur: number | undefined = pid;
  for (let hops = 0; cur !== undefined && hops < 256; hops++) {
    if (cur === root) return true;
    if (cur <= 1) return false;
    cur = parent.get(cur);
  }
  return false;
}

/** Every process under `root`, not counting `root` itself. */
export function descendantsOf(rows: readonly ProcessRow[], root: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    const list = children.get(r.ppid) ?? [];
    list.push(r);
    children.set(r.ppid, list);
  }
  const out: ProcessRow[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const c of children.get(queue.shift()!) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
      queue.push(c.pid);
    }
  }
  return out;
}
