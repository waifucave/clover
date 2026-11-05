// Shared harness for the S6 checks: start the file service, the fake link and the mount helper,
// run workloads with timeouts, and collect counters. Runs under Bun on Linux, Windows and macOS.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const IS_WIN = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";
export const HERE = import.meta.dir;
export const S6 = path.resolve(HERE, "..");
export const SERVE = path.join(S6, "server", "serve.ts");
export const PROXY = path.join(S6, "link", "proxy.ts");
export const BUN = process.execPath;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(...a: unknown[]) {
  console.error(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
}

export interface Proc {
  proc: ReturnType<typeof Bun.spawn>;
  name: string;
  logFile: string;
}

export function spawnLogged(name: string, cmd: string[], logDir: string, opts: { cwd?: string; env?: Record<string, string> } = {}): Proc {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${name}.log`);
  const fd = fs.openSync(logFile, "a");
  const proc = Bun.spawn({ cmd, cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: fd, stderr: fd, stdin: "ignore" });
  fs.closeSync(fd);
  return { proc, name, logFile };
}

/**
 * Starts a helper that announces itself with one JSON line on stdout (clover-nfs: its port and
 * one-time export path), the way it tells the daemon over the pipe. Its log goes to the file.
 */
export async function spawnAnnounced(name: string, cmd: string[], logDir: string, ms = 15000): Promise<Proc & { announce: any }> {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${name}.log`);
  const fd = fs.openSync(logFile, "a");
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: fd, stdin: "ignore" });
  fs.closeSync(fd);
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let buf = "";
  const end = Date.now() + ms;
  while (!buf.includes("\n")) {
    const left = end - Date.now();
    if (left <= 0) { proc.kill(9); throw new Error(`${name} announced nothing in ${ms} ms: ${tail(logFile)}`); }
    const r = await Promise.race([reader.read(), sleep(left).then(() => ({ done: false, value: undefined, late: true }))]) as any;
    if (r.late) continue;
    if (r.done) throw new Error(`${name} exited before announcing: ${tail(logFile)}`);
    buf += new TextDecoder().decode(r.value);
  }
  (async () => { try { while (!(await reader.read()).done) {} } catch {} })(); // keep the pipe drained
  return { proc, name, logFile, announce: JSON.parse(buf.slice(0, buf.indexOf("\n"))) };
}

export async function waitPort(port: number, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise<boolean>((res) => {
      Bun.connect({ hostname: "127.0.0.1", port, socket: { open(s) { s.end(); res(true); }, data() {}, error() { res(false); }, connectError() { res(false); } } }).catch(() => res(false));
    });
    if (ok) return;
    await sleep(50);
  }
  throw new Error(`port ${port} did not open`);
}

export interface RunResult {
  ok: boolean;
  code: number | null;
  ms: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Runs a command to completion, killing it after timeoutMs. */
export async function run(cmd: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<RunResult> {
  const t0 = performance.now();
  const p = Bun.spawn({ cmd, cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill(9); }, opts.timeoutMs ?? 600_000);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  const ms = performance.now() - t0;
  return { ok: code === 0 && !timedOut, code, ms, timedOut, stdout, stderr };
}

/** One fs call in a child process, so a hung mount can never hang the harness. */
export async function probe(op: "stat" | "readdir" | "read", p: string, timeoutMs = 5000) {
  const script = `const fs=require("fs");const t=performance.now();try{` +
    (op === "stat" ? `fs.statSync(${JSON.stringify(p)})` : op === "readdir" ? `fs.readdirSync(${JSON.stringify(p)})` : `fs.readFileSync(${JSON.stringify(p)})`) +
    `;console.log(JSON.stringify({ok:true,ms:performance.now()-t}))}catch(e){console.log(JSON.stringify({ok:false,ms:performance.now()-t,code:e.code,message:e.message}))}`;
  const r = await run([BUN, "-e", script], { timeoutMs });
  if (r.timedOut) return { ok: false, ms: timeoutMs, code: "HANG", message: `no answer in ${timeoutMs} ms` };
  try { return JSON.parse(r.stdout.trim().split("\n").pop()!) as { ok: boolean; ms: number; code?: string; message?: string }; }
  catch { return { ok: false, ms: r.ms, code: "PROBE", message: r.stderr.slice(0, 200) }; }
}

export async function http(port: number, p: string, body?: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  return res.json();
}

// ---- the pieces ---------------------------------------------------------------------------

export interface Ports { service: number; serviceControl: number; link: number; linkControl: number; helperStatus: number }
export const PORTS: Ports = { service: 7400, serviceControl: 7401, link: 7500, linkControl: 7501, helperStatus: 7600 };

export class Rig {
  service?: Proc;
  link?: Proc;
  helper?: Proc;
  /** fskit: when set, the tree is an FSKit volume mounted by `mount -F` (the macOS live gate). */
  fskit?: { url: string; mountpoint: string };
  /** nfs: the tree entry is an NFSv3 export on localhost (clover-nfs) mounted by mount_nfs (macOS). */
  // ac: the kernel's attribute caching for the NFS mount (default: noac for nocache, else actimeo=1).
  // With noac every stat reaches the helper on the loopback address, whose own cache the holder's
  // events keep fresh, so the kernel never works from an old size.
  // port and exportPath come from the helper's announcement, fresh for every helper it starts.
  nfs?: {
    bin: string; mountpoint: string; port?: number; exportPath?: string; mountedAs?: string; mountError?: string;
    ac?: string; dead?: number; timeo?: number; rsize?: number; readahead?: number; extra?: string; treeRootMode?: string; mountArgs?: string;
  };
  constructor(public o: { root: string; tree: string; helperBin: string; logs: string; remoteName: string; selfName: string; selfHome: string }) {}

  async startService(extra: string[] = []) {
    this.service = spawnLogged("service", [BUN, SERVE, "--root", this.o.root, "--port", String(PORTS.service), "--control-port", String(PORTS.serviceControl), ...extra], this.o.logs);
    await waitPort(PORTS.service);
    await waitPort(PORTS.serviceControl);
  }
  async killService() {
    if (!this.service) return;
    this.service.proc.kill(9);
    await this.service.proc.exited;
    this.service = undefined;
  }
  async startLink(rttMs: number) {
    this.link = spawnLogged("link", [BUN, PROXY, "--listen", String(PORTS.link), "--target", String(PORTS.service), "--control", String(PORTS.linkControl), "--rtt-ms", String(rttMs)], this.o.logs);
    await waitPort(PORTS.link);
    await waitPort(PORTS.linkControl);
  }
  async setLink(cfg: { rttMs?: number; mode?: "pass" | "blackhole"; rateKbps?: number; jitterMs?: number; bufKB?: number }) { return http(PORTS.linkControl, "/config", cfg); }
  async resetLink() { return http(PORTS.linkControl, "/reset", {}); }
  async serviceStats(): Promise<Record<string, number>> { return http(PORTS.serviceControl, "/stats"); }
  async resetServiceStats() { return http(PORTS.serviceControl, "/stats/reset", {}); }
  async helperStats(): Promise<any> {
    try { return (await http(PORTS.helperStatus, "/stats"))[this.o.remoteName]; } catch { return null; }
  }

  /** The tree's root as a path ("T:\\" on Windows, where the mount argument is "T:"). */
  get treeRoot() { return IS_WIN && /^[A-Za-z]:$/.test(this.o.tree) ? this.o.tree + "\\" : this.o.tree; }
  remotePath(...p: string[]) {
    // On macOS each other computer is its own FSKit volume, mounted where its entry belongs.
    if (this.fskit) return path.join(this.fskit.mountpoint, ...p);
    if (this.nfs) return path.join(this.nfs.mountpoint, ...p);
    return path.join(this.treeRoot, "home", this.o.remoteName, ...p);
  }

  async mount(policy: string, extra: string[] = []) {
    if (this.fskit) return this.mountFskit();
    if (this.nfs) return this.mountNfs(policy);
    if (!IS_WIN) fs.mkdirSync(this.o.tree, { recursive: true });
    this.helper = spawnLogged("helper", [
      this.o.helperBin, "--mountpoint", this.o.tree, "--policy", policy,
      "--remote", `${this.o.remoteName}=127.0.0.1:${PORTS.link}`,
      "--self", `${this.o.selfName}=${this.o.selfHome}`,
      "--status", `127.0.0.1:${PORTS.helperStatus}`, ...extra,
    ], this.o.logs);
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      if (this.helper.proc.exitCode !== null) throw new Error(`helper exited: ${tail(this.helper.logFile)}`);
      const r = await probe("stat", path.join(this.treeRoot, "home"), 2000);
      if (r.ok) return;
      await sleep(100);
    }
    throw new Error(`mount did not appear: ${tail(this.helper.logFile)}`);
  }

  async mountFskit() {
    const f = this.fskit!;
    fs.mkdirSync(f.mountpoint, { recursive: true });
    const r = await run(["/sbin/mount", "-F", "-t", "clovertree", f.url, f.mountpoint], { timeoutMs: 30000 });
    if (!r.ok) throw new Error(`mount -F failed: ${(r.stderr || r.stdout).trim()}`);
    this.helper = { proc: { exitCode: null, kill() {}, exited: Promise.resolve(0) } as any, name: "fskit", logFile: "" };
  }

  async mountNfs(policy: string) {
    const n = this.nfs!;
    // The tree's root is the user's alone (0700), so no other local user can reach the mounts in it.
    const root = path.dirname(n.mountpoint);
    fs.mkdirSync(n.mountpoint, { recursive: true });
    fs.chmodSync(root, 0o700);
    n.treeRootMode = (fs.statSync(root).mode & 0o777).toString(8);
    // The helper picks its port and a one-time export path, and tells us over its stdout.
    const h = await spawnAnnounced("helper", [n.bin, "--remote", `${this.o.remoteName}=127.0.0.1:${PORTS.link}`,
      "--policy", policy, "--status", `127.0.0.1:${PORTS.helperStatus}`], this.o.logs);
    this.helper = h;
    n.port = h.announce.port;
    n.exportPath = h.announce.export;
    // soft + dumbtimer + a fixed timeo of 11 s, above the helper's own bound for a call whose
    // answer has not started arriving (10 s): the client doesn't give up on a live call, because
    // the helper answers first, with data or with EIO once the far computer is gone. (Without
    // dumbtimer the client's estimator, trained on sub-millisecond answers from the helper's
    // cache, timed big reads out after 443 ms.) A slow link can still keep one call's answer
    // longer than that; failfast.ts's slow-link case measures what the client does then. If the
    // helper itself dies, the daemon force-unmounts at once (failfast.ts), and deadtimeout is the
    // backstop that frees callers stuck in the NFS client. nobrowse keeps the volume out of
    // Finder; noresvport because a user can't bind a reserved port (mount_nfs's default).
    const ac = n.ac ?? (policy === "nocache" ? "noac" : "actimeo=1");
    const dead = n.dead ?? 5;
    const timeo = n.timeo ?? 110;
    const rsize = n.rsize ?? 1048576;
    const opts = `vers=3,tcp,port=${n.port},mountport=${n.port},nolocks,locallocks,soft,intr,dumbtimer,timeo=${timeo},retrans=2,` +
      `${dead ? `deadtimeout=${dead},` : ""}rsize=${rsize},wsize=${rsize},readahead=${n.readahead ?? 16},nobrowse,noresvport,${ac}${n.extra ? `,${n.extra}` : ""}`;
    const r = await run(["/sbin/mount_nfs", "-o", opts, `127.0.0.1:${n.exportPath}`, n.mountpoint], { timeoutMs: 30000 });
    if (!r.ok) {
      // The helper accepts one MOUNT. If ours failed, someone may have used it first: never retry
      // against the same helper (the daemon starts a new one, with a new export path).
      n.mountError = (r.stderr || r.stdout).trim().slice(0, 300);
      throw new Error(`mount_nfs failed; not mounting with this helper again: ${n.mountError}`);
    }
    n.mountedAs = "user";
    // What the kernel made of the options (acregmin/acregmax and the rest), for the result files.
    const m = await run(["nfsstat", "-m"], { timeoutMs: 10000 });
    n.mountArgs = (m.stdout || m.stderr).trim().slice(0, 1500);
  }

  /** What the daemon does after its helper died: take the dead mount away so it can remount. */
  async detach() {
    if (IS_LINUX) return (await run(["fusermount3", "-u", "-z", this.o.tree], { timeoutMs: 5000 })).ok;
    if (process.platform === "darwin" && !this.nfs && !this.fskit) return (await run(["/sbin/umount", "-f", this.o.tree], { timeoutMs: 15000 })).ok;
    if (this.nfs) return (await run(["/sbin/umount", "-f", this.nfs.mountpoint], { timeoutMs: 15000 })).ok;
    return true;
  }

  async unmount() {
    if (this.nfs) {
      const h = this.helper;
      this.helper = undefined;
      await run(["/sbin/umount", this.nfs.mountpoint], { timeoutMs: 15000 });
      if (await mounted(this.nfs.mountpoint)) await run(["/sbin/umount", "-f", this.nfs.mountpoint], { timeoutMs: 15000 });
      if (h) { h.proc.kill(9); await h.proc.exited; }
      return;
    }
    if (this.fskit) {
      if (!this.helper) return;
      this.helper = undefined;
      await run(["/sbin/umount", this.fskit.mountpoint], { timeoutMs: 15000 });
      return;
    }
    if (!this.helper) return;
    const h = this.helper;
    this.helper = undefined;
    if (IS_WIN) {
      h.proc.kill(); // WinFsp tears the volume down when its process ends
    } else {
      h.proc.kill("SIGTERM");
    }
    const exited = await Promise.race([h.proc.exited.then(() => true), sleep(5000).then(() => false)]);
    if (!exited) { h.proc.kill(9); await h.proc.exited; }
    if (IS_LINUX) await run(["fusermount3", "-u", "-z", this.o.tree], { timeoutMs: 5000 });
    if (process.platform === "darwin" && (await mounted(this.o.tree))) await run(["/sbin/umount", "-f", this.o.tree], { timeoutMs: 15000 });
    // Wait until the mount is gone.
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (!(await mounted(this.o.tree))) return;
      await sleep(100);
    }
  }

  async stopAll() {
    await this.unmount().catch(() => {});
    this.link?.proc.kill(9);
    this.link = undefined;
    await this.killService();
  }
}

export async function mounted(tree: string): Promise<boolean> {
  if (IS_LINUX) return fs.readFileSync("/proc/self/mountinfo", "utf8").includes(` ${tree} `);
  if (IS_WIN) return fs.existsSync(tree.replace(/\\$/, "") + "\\");
  if (process.platform === "darwin") return (await run(["/sbin/mount"], { timeoutMs: 5000 })).stdout.includes(` on ${tree} `);
  return false;
}

export function tail(file: string, n = 15): string {
  try { return fs.readFileSync(file, "utf8").trim().split("\n").slice(-n).join("\n"); } catch { return ""; }
}

/** A process the kernel left stuck: an uninterruptible wait (D on Linux, U on macOS) or a zombie (Z). */
export interface Stuck { pid: number; ppid: number; stat: string; comm: string }
const WORKLOAD = /(^|\/)(git|git-[a-z-]+|node|bun|clover-[a-z]+|ls|cat|cp|sh|bash)$/;
let otherStuck: Stuck[] = [];

/**
 * Stuck processes of this run: the harness's own process tree (the workloads, the helper, the
 * fake link, the file service) and any of the programs it runs that ended up reparented. macOS
 * shows system daemons (Spotlight's mds and mdworker, spindump, cfprefsd) in U for moments on a
 * busy runner; those are kept apart in lastOtherStuck(), not counted.
 */
export async function stuckProcesses(): Promise<Stuck[]> {
  if (IS_WIN) return [];
  const r = await run(["ps", "-eo", "pid=,ppid=,stat=,comm="], { timeoutMs: 5000 });
  const all = r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 4)
    .map((p) => ({ pid: Number(p[0]), ppid: Number(p[1]), stat: p[2]!, comm: p.slice(3).join(" ") }));
  const kids = new Map<number, number[]>();
  for (const p of all) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const ours = new Set<number>();
  const walk = (pid: number) => { for (const k of kids.get(pid) ?? []) if (!ours.has(k)) { ours.add(k); walk(k); } };
  walk(process.pid);
  const stuck = all.filter((p) => (IS_LINUX ? /^[DZ]/ : /^[UZ]/).test(p.stat) && !/kworker|jbd2|kthread/.test(p.comm));
  otherStuck = stuck.filter((p) => !(ours.has(p.pid) || WORKLOAD.test(p.comm)));
  return stuck.filter((p) => ours.has(p.pid) || WORKLOAD.test(p.comm));
}

/** The system processes the last stuckProcesses() call saw in an uninterruptible wait, not counted. */
export function lastOtherStuck(): Stuck[] {
  return otherStuck;
}

export async function dropCaches(): Promise<boolean> {
  if (!IS_LINUX) return false;
  const r = await run(["sh", "-c", "sync && echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null"], { timeoutMs: 60000 });
  return r.ok;
}

export function machine() {
  return {
    os: process.platform, release: os.release(), arch: process.arch, cpus: os.cpus().length,
    cpu: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 2 ** 30), bun: Bun.version,
    // Provenance: which commit and CI run produced the file.
    commit: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB,
  };
}

/** What a result file records about the NFS mount. */
export function nfsInfo(rig: Rig) {
  const n = rig.nfs!;
  return {
    mountedAs: n.mountedAs, userMountError: n.mountError, ac: n.ac, timeo: n.timeo ?? 110, deadtimeout: n.dead ?? 5, dumbtimer: true,
    rsize: n.rsize ?? 1048576, readahead: n.readahead ?? 16, extra: n.extra, treeRootMode: n.treeRootMode, exportPathKind: "one-time token", mountArgs: n.mountArgs,
  };
}

/** The NFS rig from a check's command-line arguments (macOS). */
export function nfsFromArgs(args: Record<string, string>): Rig["nfs"] {
  if (!args["nfs-helper"]) return undefined;
  return {
    bin: path.resolve(args["nfs-helper"]), mountpoint: path.resolve(args.tree!), ac: args["nfs-ac"],
    dead: args["nfs-dead"] === undefined ? undefined : Number(args["nfs-dead"]),
    timeo: args["nfs-timeo"] === undefined ? undefined : Number(args["nfs-timeo"]),
    rsize: args["nfs-rsize"] === undefined ? undefined : Number(args["nfs-rsize"]),
    readahead: args["nfs-readahead"] === undefined ? undefined : Number(args["nfs-readahead"]),
    extra: args["nfs-extra"],
  };
}

export function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function summary(md: string) {
  console.log(md);
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) fs.appendFileSync(f, md + "\n");
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = "1";
  }
  return out;
}
