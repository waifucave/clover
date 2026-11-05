#!/usr/bin/env bun
// S6 question 4: when the computer drops, every file operation must fail within a bound we
// measure, with no hangs, no stuck mounts and no zombies, and the mount must recover when the
// link returns.
//
//   bun bench/failfast.ts --root <export> --tree <mountpoint> --helper <clover-mount> --out <json>
//        [--rtt 20] [--policy plain] [--only a,b]
//
// Each scenario mounts fresh, starts a real operation, injects a fault while it is in flight,
// then measures: how long the operation took to fail and what it saw, how fast a new operation
// fails while the computer is away, whether anything is left stuck, and how long the mount takes
// to work again once the fault is removed.

import * as fs from "node:fs";
import * as path from "node:path";
import { BUN, HERE, IS_LINUX, IS_WIN, Rig, lastOtherStuck, log, machine, mounted, parseArgs, probe, run, sleep, stuckProcesses, summary, tail, writeJson } from "./lib";

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root!);
const TREE = IS_WIN ? args.tree! : path.resolve(args.tree!);
const OUT = path.resolve(args.out ?? "failfast.json");
const RTT = Number(args.rtt ?? 20);
const POLICY = args.policy ?? "plain";
const NODE = process.env.NODE_BIN ?? "node";
const RW = path.join(HERE, "rw.ts");
const HANG_MS = 30000;

const rig = new Rig({
  root: ROOT, tree: TREE, helperBin: path.resolve(args.helper!), logs: path.join(path.dirname(OUT), "logs", path.basename(OUT, ".json")),
  remoteName: "Desktop1", selfName: "Runner", selfHome: path.dirname(ROOT),
});
if (args["fskit-url"]) rig.fskit = { url: args["fskit-url"], mountpoint: path.resolve(args["fskit-mountpoint"]!) };
if (args["nfs-helper"]) rig.nfs = { bin: path.resolve(args["nfs-helper"]), port: 12049, mountpoint: path.resolve(args.tree!) };
const results: Array<Record<string, unknown>> = [];
const out: { [k: string]: any } = { spike: "S6", question: "failfast", machine: machine(), rttMs: RTT, policy: POLICY, started: new Date().toISOString(), results };
const save = () => writeJson(OUT, out);

type Op = { name: string; cmd: () => string[]; cwd?: () => string; settleMs: number };
const OPS: Record<string, Op> = {
  read: { name: "read 1 GiB", cmd: () => [BUN, RW, "read", rig.remotePath("big1g.bin")], settleMs: 500 },
  write: { name: "write 1 GiB", cmd: () => [BUN, RW, "write", rig.remotePath("ff-write.bin"), "1024"], settleMs: 500 },
  git: { name: "git status (cold)", cmd: () => ["git", "-c", "core.fsmonitor=false", "status", "--porcelain"], cwd: () => rig.remotePath("clover"), settleMs: 300 },
  tsc: { name: "tsc packages/protocol (cold)", cmd: () => [NODE, rig.remotePath("clover", "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "packages/protocol"], cwd: () => rig.remotePath("clover"), settleMs: 300 },
};

interface Fault { name: string; inject: () => Promise<void>; restore: () => Promise<void> }
const FAULTS: Record<string, Fault> = {
  blackhole: { name: "link goes silent (no FIN, no RST)", inject: async () => { await rig.setLink({ mode: "blackhole" }); }, restore: async () => { await rig.setLink({ mode: "pass" }); } },
  reset: { name: "link reset (connections closed)", inject: async () => { await rig.resetLink(); }, restore: async () => {} },
  kill: { name: "file service killed (SIGKILL)", inject: async () => { await rig.killService(); }, restore: async () => { await rig.startService(); } },
  freeze: {
    name: "file service frozen (SIGSTOP; its TCP stays up)",
    inject: async () => { process.kill(rig.service!.proc.pid, "SIGSTOP"); },
    restore: async () => { process.kill(rig.service!.proc.pid, "SIGCONT"); },
  },
};

/** The line of a program's output that names the error (git's "fatal:", Node's "Error: ..."). */
function firstError(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /^(fatal|error)[: ]|Error:|E[A-Z]{3,}\b|host is/i.test(l));
  return (hit ?? lines.slice(-1)[0] ?? "").slice(0, 300);
}

const outcome = (s: string) => { try { return JSON.parse(s.trim().split("\n").pop() ?? "{}"); } catch { return {}; } };

async function recover(): Promise<number> {
  const t = performance.now();
  for (;;) {
    const r = await probe("stat", rig.remotePath("clover", "package.json"), 3000);
    if (r.ok) return Math.round(performance.now() - t);
    if (performance.now() - t > 30000) return -1;
    await sleep(25);
  }
}

async function checks(r: Record<string, unknown>) {
  r.stuckProcesses = await stuckProcesses();
  r.systemUninterruptible = lastOtherStuck().map((p) => `${p.comm.split("/").pop()}:${p.stat}`);
  r.helperAlive = rig.helper ? rig.helper.proc.exitCode === null : false;
  if (!rig.nfs && !rig.fskit) r.homeListing = await probe("readdir", path.join(rig.treeRoot, "home"), 3000); // other computers unaffected
}

/** One scenario: an operation in flight, a fault, then the way back. */
async function inflight(opKey: string, faultKey: string) {
  const op = OPS[opKey]!;
  const fault = FAULTS[faultKey]!;
  const r: Record<string, unknown> = { scenario: `${opKey}+${faultKey}`, op: op.name, fault: fault.name };
  log(`== ${op.name} / ${fault.name}`);
  await rig.mount(POLICY);
  const child = Bun.spawn({ cmd: op.cmd(), cwd: op.cwd?.(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stdoutP = new Response(child.stdout).text();
  const stderrP = new Response(child.stderr).text();
  await sleep(op.settleMs);
  if (child.exitCode !== null) r.note = "the operation finished before the fault; size it up";
  const t0 = performance.now();
  await fault.inject();
  const exited = await Promise.race([child.exited.then(() => true), sleep(HANG_MS).then(() => false)]);
  r.failMs = Math.round(performance.now() - t0);
  if (!exited) { r.hung = true; child.kill(9); await child.exited; }
  r.exitCode = child.exitCode;
  const so = await stdoutP;
  const se = await stderrP;
  const o = outcome(so);
  r.sawError = o.code ? `${o.code}: ${o.message}` : firstError(se || so);
  r.progressBytes = o.bytes;
  // While the computer is away, a new operation answers at once.
  r.whileDown = await probe("stat", rig.remotePath("clover", "package.json"), 5000);
  r.whileDownAgain = await probe("readdir", rig.remotePath(), 5000);
  await checks(r);
  const t1 = performance.now();
  await fault.restore();
  r.recoverMs = await recover();
  r.restoreCallMs = Math.round(performance.now() - t1) - (r.recoverMs as number);
  r.afterRecovery = await probe("read", rig.remotePath("clover", "package.json"), 5000);
  r.stuckAfter = await stuckProcesses();
  r.helperStats = await rig.helperStats();
  r.helperLog = tail(rig.helper?.logFile ?? "", 6);
  const u0 = performance.now();
  await rig.unmount();
  r.unmountMs = Math.round(performance.now() - u0);
  r.mountGone = !(await mounted(TREE));
  fs.rmSync(path.join(ROOT, "ff-write.bin"), { force: true });
  results.push(r);
  save();
  log(`   fails after ${r.failMs} ms (${r.sawError}); while down ${JSON.stringify(r.whileDown)}; back after ${r.recoverMs} ms`);
}

/** No operation in flight: the first call after a silent drop, then calls once the drop is known. */
async function idleDrop() {
  const r: Record<string, unknown> = { scenario: "idle+blackhole", op: "stat after the drop", fault: FAULTS.blackhole!.name };
  log("== idle / blackhole");
  await rig.mount(POLICY);
  await probe("stat", rig.remotePath("clover", "package.json"));
  await rig.setLink({ mode: "blackhole" });
  await sleep(100);
  r.firstCall = await probe("stat", rig.remotePath("clover", "README.md"), 10000); // not cached yet
  await sleep(2000);
  r.laterCall = await probe("stat", rig.remotePath("clover", "LICENSE"), 10000);
  r.laterCallCached = await probe("stat", rig.remotePath("clover", "package.json"), 10000);
  await checks(r);
  await rig.setLink({ mode: "pass" });
  r.recoverMs = await recover();
  await rig.unmount();
  results.push(r);
  save();
  log(`   first call ${JSON.stringify(r.firstCall)}; later ${JSON.stringify(r.laterCall)}; back after ${r.recoverMs} ms`);
}

/** The computer is off when the tree mounts, and comes on later. */
async function offlineAtStart() {
  const r: Record<string, unknown> = { scenario: "offline-at-start", op: "list an offline computer", fault: "file service not running" };
  log("== offline at start");
  await rig.killService();
  await rig.mount(POLICY);
  r.listHome = await probe("readdir", path.join(rig.treeRoot, "home"), 5000);
  r.listComputer = await probe("readdir", rig.remotePath(), 5000);
  r.statFile = await probe("stat", rig.remotePath("clover", "package.json"), 5000);
  await checks(r);
  await rig.startService();
  r.recoverMs = await recover();
  await rig.unmount();
  results.push(r);
  save();
  log(`   list ${JSON.stringify(r.listComputer)}; back after ${r.recoverMs} ms`);
}

/** The helper itself dies with a read in flight; the daemon cleans up and remounts. */
async function helperCrash() {
  const r: Record<string, unknown> = { scenario: "read+helper-crash", op: OPS.read!.name, fault: "mount helper killed (SIGKILL)" };
  log("== helper crash");
  await rig.mount(POLICY);
  const child = Bun.spawn({ cmd: OPS.read!.cmd(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const so = new Response(child.stdout).text();
  await sleep(500);
  const t0 = performance.now();
  rig.helper!.proc.kill(9);
  await rig.helper!.proc.exited;
  const exited = await Promise.race([child.exited.then(() => true), sleep(HANG_MS).then(() => false)]);
  r.failMs = Math.round(performance.now() - t0);
  if (!exited) { r.hung = true; child.kill(9); await child.exited; }
  const o = outcome(await so);
  r.sawError = o.code ? `${o.code}: ${o.message}` : "";
  r.deadMount = await probe("stat", rig.nfs ? rig.remotePath("clover", "package.json") : path.join(rig.treeRoot, "home"), 15000); // what a dead mount answers
  r.stuckProcesses = await stuckProcesses();
  r.systemUninterruptible = lastOtherStuck().map((p) => `${p.comm.split("/").pop()}:${p.stat}`);
  // The daemon's part: detach the dead mount, start a new helper.
  const t1 = performance.now();
  r.detach = await rig.detach();
  rig.helper = undefined;
  await rig.mount(POLICY);
  r.remountMs = Math.round(performance.now() - t1);
  r.afterRemount = await probe("stat", rig.remotePath("clover", "package.json"), 5000);
  r.stuckAfter = await stuckProcesses();
  await rig.unmount();
  r.mountGone = !(await mounted(TREE));
  results.push(r);
  save();
  log(`   read failed after ${r.failMs} ms (${r.sawError}); dead mount ${JSON.stringify(r.deadMount)}; remounted in ${r.remountMs} ms`);
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, "big1g.bin"))) await run([BUN, RW, "make", path.join(ROOT, "big1g.bin"), "1024"], { timeoutMs: 300000 });
  await rig.startService();
  await rig.startLink(RTT);
  const only = args.only ? args.only.split(",") : null;
  const plan: Array<[string, () => Promise<void>]> = [
    ["read+blackhole", () => inflight("read", "blackhole")],
    ["read+reset", () => inflight("read", "reset")],
    ["read+kill", () => inflight("read", "kill")],
    ["write+blackhole", () => inflight("write", "blackhole")],
    ["write+kill", () => inflight("write", "kill")],
    ["git+blackhole", () => inflight("git", "blackhole")],
    ["tsc+blackhole", () => inflight("tsc", "blackhole")],
    ["idle+blackhole", idleDrop],
    ["offline-at-start", offlineAtStart],
    ["read+helper-crash", helperCrash],
  ];
  if (!IS_WIN) plan.splice(3, 0, ["read+freeze", () => inflight("read", "freeze")]);
  // An FSKit volume has no helper process of ours to kill; the gate script tests the module's
  // own process separately, because a dead module can leave callers stuck.
  if (rig.fskit) plan.splice(plan.findIndex(([n]) => n === "read+helper-crash"), 1);
  try {
    for (const [name, fn] of plan) {
      if (only && !only.includes(name)) continue;
      try { await fn(); }
      catch (e) { results.push({ scenario: name, error: String(e) }); save(); log(`   ${name} errored: ${e}`); await rig.unmount().catch(() => {}); }
      if (!rig.service) await rig.startService();
      await rig.setLink({ mode: "pass" });
    }
  } finally {
    await rig.stopAll();
  }
  if (rig.nfs) out.nfs = { mountedAs: rig.nfs.mountedAs, userMountError: rig.nfs.mountError };
  out.finished = new Date().toISOString();
  save();
  report();
}

function report() {
  const ms = (v: unknown) => (typeof v === "number" ? `${v} ms` : "–");
  const pr = (p: any) => (p ? (p.ok ? `ok ${Math.round(p.ms)} ms` : `${p.code} in ${Math.round(p.ms)} ms`) : "–");
  let md = `\n### S6 fail-fast on ${out.machine.os} (${out.machine.release}), ${POLICY}, +${RTT} ms\n\n`;
  md += "| scenario | in-flight op fails after | what it saw | new op while down | stuck procs | back after link returns |\n| :- | -: | :- | :- | -: | -: |\n";
  for (const r of results as any[]) {
    const fail = r.hung ? "**HUNG**" : ms(r.failMs ?? r.firstCall?.ms);
    const saw = String(r.sawError ?? r.firstCall?.code ?? r.listComputer?.code ?? r.error ?? "").replace(/\|/g, "/").slice(0, 70);
    const down = pr(r.whileDown ?? r.laterCall ?? r.statFile ?? r.deadMount);
    const stuck = ((r.stuckProcesses?.length ?? 0) + (r.stuckAfter?.length ?? 0)).toString();
    md += `| ${r.scenario} | ${fail} | ${saw} | ${down} | ${stuck} | ${ms(r.recoverMs ?? r.remountMs)} |\n`;
  }
  summary(md);
}

main().catch(async (e) => { console.error(e); await rig.stopAll(); save(); process.exit(1); });
