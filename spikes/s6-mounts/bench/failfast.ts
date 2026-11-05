#!/usr/bin/env bun
// S6 question 4: when the computer drops, every file operation must fail within a bound we
// measure, with no hangs, no stuck mounts and no zombies, and the mount must recover when the
// link returns.
//
//   bun bench/failfast.ts --root <export> --tree <mountpoint> --helper <clover-mount> --out <json>
//        [--rtt 20] [--policy plain] [--only a,b] [--slow-kbps 2000] [--slow-mib 8] [--slow-jitter-ms 20]
//
// --only sleep-wake is for live gate 2 alone: the owner sleeps and wakes the Mac with a read in
// flight (never part of the default plan).
//
// Each scenario mounts fresh, starts a real operation, injects a fault while it is in flight,
// then measures: how long the operation took to fail and what it saw, how fast a new operation
// fails while the computer is away, whether anything is left stuck, and how long the mount takes
// to work again once the fault is removed.

import * as fs from "node:fs";
import * as path from "node:path";
import { BUN, HERE, IS_LINUX, IS_WIN, Rig, lastOtherStuck, log, machine, mounted, nfsFromArgs, nfsInfo, parseArgs, probe, run, sleep, stuckProcesses, summary, tail, writeJson } from "./lib";

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
if (args["nfs-helper"]) rig.nfs = nfsFromArgs(args);
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

/**
 * A program that didn't fail in time: kill it, and if the kernel holds it (an NFS client waiting
 * on a server that is gone), let the daemon's detach (umount -f) free it. Never waits forever,
 * and the result says what it took.
 */
async function reap(child: ReturnType<typeof Bun.spawn>, r: Record<string, unknown>) {
  r.hung = true;
  child.kill(9);
  if (await Promise.race([child.exited.then(() => true), sleep(3000).then(() => false)])) { r.killedBySigkill = true; return; }
  r.killedBySigkill = false; // in the kernel, past SIGKILL
  const t = performance.now();
  r.detachToFree = await rig.detach();
  const freed = await Promise.race([child.exited.then(() => true), sleep(30000).then(() => false)]);
  r.freedByDetachMs = freed ? Math.round(performance.now() - t) : -1;
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
  if (!exited) await reap(child, r);
  r.exitCode = child.exitCode;
  const so = await Promise.race([stdoutP, sleep(2000).then(() => "")]); // a child the kernel still holds keeps its pipes open
  const se = await Promise.race([stderrP, sleep(2000).then(() => "")]);
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

/**
 * A live but slow link: a bandwidth cap with jitter and a bounded buffer (the sender is paused
 * past it, as a TCP window would). Writing and then reading back must work with no false
 * "offline" (S1): before the fixes, a 1 MiB frame that took longer than 1.5 s to cross dropped
 * the link. Not run on the gate's own FSKit module, which has no status endpoint to count drops.
 */
async function slowLink() {
  const kbps = Number(args["slow-kbps"] ?? 2000), mib = Number(args["slow-mib"] ?? 8), jitter = Number(args["slow-jitter-ms"] ?? 20);
  const r: Record<string, unknown> = { scenario: "slow-link", op: `write then read ${mib} MiB`, fault: `${kbps} kbit/s each way, +0–${jitter} ms jitter, 256 KiB buffer` };
  log(`== slow link: ${kbps} kbit/s`);
  // The read is of another file, made on the holder's own disk before the mount, so it crosses
  // the link: the file just written can come back from the client's own cache (NFS: 86 ms).
  await run([BUN, RW, "make", path.join(ROOT, "ff-slow-src.bin"), String(mib)], { timeoutMs: 120_000 });
  await rig.mount(POLICY);
  const before = await rig.helperStats();
  await rig.setLink({ rateKbps: kbps, jitterMs: jitter, bufKB: 256 });
  try {
    const file = rig.remotePath("ff-slow.bin");
    const t0 = performance.now();
    const w = await run([BUN, RW, "write", file, String(mib)], { timeoutMs: 600_000 });
    r.writeMs = Math.round(performance.now() - t0);
    r.writeOk = w.ok;
    if (!w.ok) r.writeError = firstError(w.stderr || w.stdout);
    const t1 = performance.now();
    const rd = await run([BUN, RW, "read", rig.remotePath("ff-slow-src.bin")], { timeoutMs: 600_000 });
    r.readMs = Math.round(performance.now() - t1);
    r.readOk = rd.ok;
    if (!rd.ok) r.readError = firstError(rd.stderr || rd.stdout);
  } finally {
    await rig.setLink({ rateKbps: 0, jitterMs: 0 });
  }
  const after = await rig.helperStats();
  r.falseOffline = after && before ? after.drops - before.drops : null;
  r.requestTimeouts = after && before ? after.timeouts - before.timeouts : null;
  r.stuckProcesses = await stuckProcesses();
  await rig.unmount();
  results.push(r);
  save();
  log(`   write ${r.writeOk ? "ok" : "FAILED"} in ${r.writeMs} ms, read ${r.readOk ? "ok" : "FAILED"} in ${r.readMs} ms, false offline ${r.falseOffline}, timeouts ${r.requestTimeouts}`);
}

/**
 * Live gate 2 only (--only sleep-wake): the owner puts the Mac to sleep with a mount active and
 * a read in flight on a 20 Mbit/s link, wakes it, and presses Enter. Records whether the read
 * finished or failed and how, whether the link dropped and came back, and whether the mount
 * answers afterwards (review S1).
 */
async function sleepWake() {
  const r: Record<string, unknown> = { scenario: "sleep-wake", op: "read 1 GiB at 20 Mbit/s", fault: "the Mac sleeps and wakes" };
  await rig.mount(POLICY);
  await rig.setLink({ rateKbps: 20000, jitterMs: 5, bufKB: 256 });
  const before = await rig.helperStats();
  const t0 = performance.now();
  const child = Bun.spawn({ cmd: [BUN, RW, "read", rig.remotePath("big1g.bin")], stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const so = new Response(child.stdout).text(), se = new Response(child.stderr).text();
  console.log("\nA read is in flight. Put the Mac to sleep now (Apple menu > Sleep), wake it after about a minute, then press Enter here.");
  for await (const _ of console) break;
  r.enterAfterMs = Math.round(performance.now() - t0);
  const exited = await Promise.race([child.exited.then(() => true), sleep(120_000).then(() => false)]);
  r.readMs = Math.round(performance.now() - t0);
  r.readFinished = exited;
  if (exited) {
    r.readCode = child.exitCode;
    const o = outcome(await Promise.race([so, sleep(2000).then(() => "")]));
    r.sawError = o.code ? `${o.code}: ${o.message}` : firstError(await Promise.race([se, sleep(2000).then(() => "")]));
  } else await reap(child, r);
  await rig.setLink({ rateKbps: 0, jitterMs: 0 });
  r.afterWake = await probe("stat", rig.remotePath("clover", "package.json"), 15000);
  const after = await rig.helperStats();
  r.drops = after && before ? after.drops - before.drops : null;
  r.reconnects = after && before ? after.reconnects - before.reconnects : null;
  r.stuckProcesses = await stuckProcesses();
  await rig.unmount();
  r.mountGone = !(await mounted(TREE));
  results.push(r);
  save();
  log(`   read ${r.readFinished ? `ended (exit ${r.readCode})` : "STILL RUNNING"} after ${r.readMs} ms; afterwards ${JSON.stringify(r.afterWake)}`);
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
  if (rig.nfs) {
    // The daemon is the helper's parent: it learns of the death at once and force-unmounts, so
    // callers in the NFS client fail now instead of waiting for macOS's dead timeout (S1).
    const td = performance.now();
    r.detachAtDeath = await rig.detach();
    r.detachAtDeathMs = Math.round(performance.now() - td);
  }
  const exited = await Promise.race([child.exited.then(() => true), sleep(HANG_MS).then(() => false)]);
  r.failMs = Math.round(performance.now() - t0);
  if (!exited) await reap(child, r);
  const o = outcome(await Promise.race([so, sleep(2000).then(() => "")]));
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
    ["slow-link", slowLink],
  ];
  if (!IS_WIN) plan.splice(3, 0, ["read+freeze", () => inflight("read", "freeze")]);
  // An FSKit volume has no helper process of ours to kill; the gate script tests the module's
  // own process separately, because a dead module can leave callers stuck.
  if (rig.fskit) plan.splice(plan.findIndex(([n]) => n === "read+helper-crash"), 1);
  if (rig.fskit) plan.splice(plan.findIndex(([n]) => n === "slow-link"), 1);
  if (only?.includes("sleep-wake")) plan.push(["sleep-wake", sleepWake]);
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
  if (rig.nfs) out.nfs = nfsInfo(rig);
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
