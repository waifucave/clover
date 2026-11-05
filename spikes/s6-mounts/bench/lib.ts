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
  async setLink(cfg: { rttMs?: number; mode?: "pass" | "blackhole" }) { return http(PORTS.linkControl, "/config", cfg); }
  async resetLink() { return http(PORTS.linkControl, "/reset", {}); }
  async serviceStats(): Promise<Record<string, number>> { return http(PORTS.serviceControl, "/stats"); }
  async resetServiceStats() { return http(PORTS.serviceControl, "/stats/reset", {}); }
  async helperStats(): Promise<any> {
    try { return (await http(PORTS.helperStatus, "/stats"))[this.o.remoteName]; } catch { return null; }
  }

  /** The tree's root as a path ("T:\\" on Windows, where the mount argument is "T:"). */
  get treeRoot() { return IS_WIN && /^[A-Za-z]:$/.test(this.o.tree) ? this.o.tree + "\\" : this.o.tree; }
  remotePath(...p: string[]) { return path.join(this.treeRoot, "home", this.o.remoteName, ...p); }

  async mount(policy: string, extra: string[] = []) {
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

  async unmount() {
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

/** Processes the kernel left stuck: uninterruptible sleep (D) or zombies (Z). Linux only. */
export async function stuckProcesses(): Promise<Array<{ pid: number; stat: string; comm: string }>> {
  if (!IS_LINUX) return [];
  const r = await run(["ps", "-eo", "pid=,stat=,comm="], { timeoutMs: 5000 });
  return r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3 && /^[DZ]/.test(p[1]!))
    .map((p) => ({ pid: Number(p[0]), stat: p[1]!, comm: p.slice(2).join(" ") }))
    .filter((p) => !/kworker|jbd2|kthread/.test(p.comm));
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
