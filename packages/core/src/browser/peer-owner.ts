// Who is on the other end of a connection to the network filter (the second review of L-M1, should-fix 1). The
// filter's SOCKS5 listeners are on loopback, where any local process could reach them; the filter takes a connection
// only from the browser's own network process. This asks the OS's socket table who holds the connecting socket:
//
// * Linux: `/proc/net/tcp` (and `tcp6`) gives the connecting socket's inode, and the allowed processes'
//   `/proc/<pid>/fd` links say whether one of them holds it. If the kernel won't show those links (a process the
//   sandbox made non-dumpable), no connection is accepted (fail closed: a uid check would take any process of the
//   same user, a fenced bot's command included). Which of the two paths a Linux machine takes is logged once.
// * macOS: `lsof` on the allowed processes alone (libproc underneath), listing their TCP connections.
// * Windows: `netstat -ano -p TCP` (`GetExtendedTcpTable` underneath), which names each connection's process.
//
// Lookups that arrive together share one reading of the table, taken after the newest of them arrived, so a page's
// burst of connections costs one `lsof` or `netstat`. A table that can't be read refuses (fail closed). Lane C's fence
// denies the listeners' ports (`NetworkFilter.listenerPorts`) to fenced commands as well, as a backstop.
//
// Plain Node, no Electron; the app's `apps/desktop/src/main/browser/peer-owner.ts` is a copy a test keeps identical.
import { readdir, readFile, readlink } from "node:fs/promises";
import type { RunCommand } from "./proxy";

export interface PeerOwnerFs {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
}

export interface PeerOwnerOptions {
  platform: NodeJS.Platform;
  /** The processes whose connections the filter takes: the browser's network process (and its own process, where
   *  the network runs in it). Asked at each reading. */
  allowedPids: () => number[] | Promise<number[]>;
  run: RunCommand;
  fs?: PeerOwnerFs;
  log?: (line: string) => void;
}

/** One connection as the table shows it: the connecting end's port, the listener's port, and who holds it. */
interface Row {
  from: number;
  to: number;
  pid?: number;
  inode?: number;
  uid?: number;
}

const nodeFs: PeerOwnerFs = { readFile: (p) => readFile(p, "utf8"), readdir: (p) => readdir(p), readlink: (p) => readlink(p) };

/** `/proc/net/tcp`'s rows: local and remote ports (hex), the uid and the inode. */
export function parseProcNetTcp(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const local = f[1]!.split(":");
    const remote = f[2]!.split(":");
    rows.push({ from: parseInt(local[local.length - 1]!, 16), to: parseInt(remote[remote.length - 1]!, 16), uid: Number(f[7]), inode: Number(f[9]) });
  }
  return rows;
}

/** `lsof -F pn` lines: a `p<pid>` line, then `n<local>-><remote>` for each of its connections. */
export function parseLsof(text: string): Row[] {
  const rows: Row[] = [];
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && line.includes("->")) {
      const [a, b] = line.slice(1).split("->") as [string, string];
      const port = (s: string) => Number(s.slice(s.lastIndexOf(":") + 1));
      rows.push({ from: port(a), to: port(b), ...(pid !== undefined ? { pid } : {}) });
    }
  }
  return rows;
}

/** `netstat -ano -p TCP` lines: `TCP  127.0.0.1:52344  127.0.0.1:61000  ESTABLISHED  1234`. */
export function parseNetstat(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0]!.toUpperCase() !== "TCP") continue;
    const port = (s: string) => Number(s.slice(s.lastIndexOf(":") + 1));
    rows.push({ from: port(f[1]!), to: port(f[2]!), pid: Number(f[4]) });
  }
  return rows;
}

export class PeerOwner {
  private readonly fs: PeerOwnerFs;
  private next: Promise<{ rows: Row[]; pids: Set<number>; held: Set<number> | "unknown" }> | undefined;
  private running = false;
  private warned = false;

  constructor(private readonly opts: PeerOwnerOptions) {
    this.fs = opts.fs ?? nodeFs;
  }

  /** Whether the connection from `peer` to `listenerPort` is held by one of the allowed processes. */
  async accepts(peer: { address: string; port: number }, listenerPort: number): Promise<boolean> {
    if (!/^(127\.|::1$|::ffff:127\.)/.test(peer.address)) return false;
    try {
      const table = await this.reading();
      const rows = table.rows.filter((r) => r.from === peer.port && r.to === listenerPort);
      if (this.opts.platform === "linux") {
        if (table.held === "unknown") return false;
        const held = table.held;
        return rows.some((r) => r.inode !== undefined && held.has(r.inode));
      }
      return rows.some((r) => r.pid !== undefined && table.pids.has(r.pid));
    } catch (e) {
      this.opts.log?.(`browser network filter: the socket table can't be read (${e instanceof Error ? e.message : String(e)}); the connection is refused`);
      return false;
    }
  }

  /** A reading of the table that starts after this call: joins the next one if one is already waiting. */
  private reading(): Promise<{ rows: Row[]; pids: Set<number>; held: Set<number> | "unknown" }> {
    if (this.next !== undefined) return this.next;
    // eslint-disable-next-line prefer-const
    let p: Promise<{ rows: Row[]; pids: Set<number>; held: Set<number> | "unknown" }> | undefined;
    p = (async () => {
      // Never synchronously: `next` is set below before this body runs, and taken down here once the reading starts,
      // so a call that comes after this point waits for a reading of its own.
      await Promise.resolve();
      // Wait for a reading in progress to end: it may have started before this connection was made.
      while (this.running) await new Promise((r) => setTimeout(r, 2));
      if (this.next === p) this.next = undefined;
      this.running = true;
      try {
        return await this.read();
      } finally {
        this.running = false;
      }
    })();
    this.next = p;
    return p;
  }

  private async read(): Promise<{ rows: Row[]; pids: Set<number>; held: Set<number> | "unknown" }> {
    const pids = new Set((await this.opts.allowedPids()).filter((p) => Number.isInteger(p) && p > 0));
    if (pids.size === 0) return { rows: [], pids, held: new Set() };
    if (this.opts.platform === "linux") {
      const rows = [...parseProcNetTcp(await this.fs.readFile("/proc/net/tcp")), ...parseProcNetTcp(await this.fs.readFile("/proc/net/tcp6").catch(() => ""))];
      const held = new Set<number>();
      let readable = false;
      for (const pid of pids) {
        let fds: string[];
        try {
          fds = await this.fs.readdir(`/proc/${pid}/fd`);
        } catch {
          continue;
        }
        readable = true;
        await Promise.all(fds.map(async (fd) => {
          const link = await this.fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
          const m = /^socket:\[(\d+)\]$/.exec(link);
          if (m !== null) held.add(Number(m[1]));
        }));
      }
      if (!readable) {
        if (!this.warned) {
          this.warned = true;
          this.opts.log?.("browser network filter: Linux path: the network process's sockets can't be read here (/proc/<pid>/fd is closed to us); every connection is refused");
        }
        return { rows, pids, held: "unknown" };
      }
      if (!this.warned) {
        this.warned = true;
        this.opts.log?.(`browser network filter: Linux path: the network process's sockets are read from /proc/<pid>/fd (${pids.size} process(es), ${held.size} sockets)`);
      }
      return { rows, pids, held };
    }
    if (this.opts.platform === "darwin") {
      // Only the allowed processes' TCP connections; lsof exits 1 when one of them has none.
      const out = await this.opts.run("/usr/sbin/lsof", ["-nP", "-a", "-p", [...pids].join(","), "-iTCP", "-sTCP:ESTABLISHED", "-F", "pn"]).catch((e: { stdout?: string }) => {
        if (typeof e.stdout === "string") return e.stdout;
        throw e;
      });
      return { rows: parseLsof(out), pids, held: new Set() };
    }
    if (this.opts.platform === "win32") {
      return { rows: parseNetstat(await this.opts.run("netstat", ["-ano", "-p", "TCP"])), pids, held: new Set() };
    }
    throw new Error(`no socket table on ${this.opts.platform}`);
  }
}

/** The processes under `roots` (themselves included), for a browser whose network process is its child (the headless
 *  shell). macOS and Linux read `ps`; Windows the process table through PowerShell. */
export async function processTree(roots: readonly number[], o: { platform: NodeJS.Platform; run: RunCommand }): Promise<number[]> {
  const out = o.platform === "win32"
    ? await o.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"])
    : await o.run("ps", ["-A", "-o", "pid=,ppid="]);
  const children = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number) as [number, number];
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const seen = new Set<number>();
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return [...seen];
}
