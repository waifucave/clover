#!/usr/bin/env bun
// S6 question 3: how fast is work across a mount, compared with the same work on local disk?
//
//   bun bench/speed.ts --root <export> --tree <mountpoint> --helper <clover-mount> --out <json>
//        [--policies cached,plain] [--rtts 0,20,80] [--workloads a,b] [--local 1] [--timeout 600]
//        [--copy-src <local dir to upload>] [--owner uid:gid]
//
// --owner makes the mount report another owner for every file (Linux), as a holder whose user
// has another uid would (a Mac's 501, a Linux box's 1000; Git for Windows always records 0).
// Before each cold run the holder runs its own `git status`, so the index carries the holder's
// stat data, as it does after anyone works on the repo there. git then finds every entry's
// owner changed and re-reads each tracked file across the mount.
//
// <export>/clover must be a git checkout with node_modules installed (the CI job makes one from
// this repo). "cold" means the client side's caches are empty: a fresh mount, or for local runs
// a dropped page cache (Linux). The holder's own disk cache is warm, since it just served the
// local runs. "warm" is the same command again straight after.

import * as fs from "node:fs";
import * as path from "node:path";
import { BUN, HERE, IS_WIN, Rig, dropCaches, log, machine, parseArgs, run, summary, writeJson } from "./lib";

const args = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(args.root!);
const TREE = IS_WIN ? args.tree! : path.resolve(args.tree!);
const OUT = path.resolve(args.out ?? "speed.json");
const POLICIES = (args.policies ?? "cached,plain").split(",");
const RTTS = (args.rtts ?? "0,20,80").split(",").map(Number);
const TIMEOUT = Number(args.timeout ?? 600) * 1000;
const NODE = process.env.NODE_BIN ?? "node";
const RW = path.join(HERE, "rw.ts");
const COPY_SRC = path.resolve(args["copy-src"] ?? path.join(ROOT, "clover", "packages", "protocol"));
const SCRATCH = path.resolve(args.scratch ?? path.join(path.dirname(ROOT), "scratch"));
const OWNER = args.owner;
fs.mkdirSync(SCRATCH, { recursive: true });

interface Workload { name: string; cmd: (base: string, tag: string) => string[]; cwd?: (base: string) => string; cleanup?: (tag: string) => void; optional?: boolean }
let seq = 0;
const WORKLOADS: Workload[] = [
  { name: "git-status", cmd: () => ["git", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "status", "--porcelain"], cwd: (b) => path.join(b, "clover") },
  // core.checkStat=minimal: git compares only whole-second mtimes and sizes, not owners or inodes
  { name: "git-status-minimal", optional: true, cmd: () => ["git", "-c", "core.checkStat=minimal", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "status", "--porcelain"], cwd: (b) => path.join(b, "clover") },
  { name: "tsc-protocol", cmd: (b) => [NODE, path.join(b, "clover", "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "packages/protocol"], cwd: (b) => path.join(b, "clover") },
  { name: "tsc-core", cmd: (b) => [NODE, path.join(b, "clover", "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "packages/core"], cwd: (b) => path.join(b, "clover") },
  { name: "read-256M", cmd: (b) => [BUN, RW, "read", path.join(b, "big.bin")] },
  { name: "write-256M", cmd: (b, tag) => [BUN, RW, "write", path.join(b, `out-${tag}.bin`), "256"], cleanup: (tag) => fs.rmSync(path.join(ROOT, `out-${tag}.bin`), { force: true }) },
  { name: "copy-out", cmd: (b, tag) => [BUN, RW, "copy", path.join(b, "clover", "packages", "protocol"), path.join(SCRATCH, `out-${tag}`)], cleanup: (tag) => fs.rmSync(path.join(SCRATCH, `out-${tag}`), { recursive: true, force: true }) },
  { name: "copy-in", cmd: (b, tag) => [BUN, RW, "copy", COPY_SRC, path.join(b, `in-${tag}`)], cleanup: (tag) => fs.rmSync(path.join(ROOT, `in-${tag}`), { recursive: true, force: true }) },
];
const chosen = args.workloads ? WORKLOADS.filter((w) => args.workloads!.split(",").includes(w.name)) : WORKLOADS.filter((w) => !w.optional);
const label = (w: Workload) => (OWNER ? `${w.name}, other owner` : w.name);

interface Row {
  workload: string; where: "local" | "mount"; policy?: string; rttMs?: number; phase: "cold" | "warm";
  ms: number; ok: boolean; code: number | null; timedOut: boolean; requests?: number; ops?: Record<string, number>;
  helper?: unknown; err?: string; cacheDropped?: boolean;
}
const rows: Row[] = [];
const result: { [k: string]: any; rows: Row[] } = { spike: "S6", question: "speed", machine: machine(), started: new Date().toISOString(), rows };
const save = () => writeJson(OUT, result);

const rig = new Rig({
  root: ROOT, tree: TREE, helperBin: path.resolve(args.helper!), logs: path.join(path.dirname(OUT), "logs", path.basename(OUT, ".json")),
  remoteName: "Desktop1", selfName: "Runner", selfHome: path.dirname(ROOT),
});
if (args["fskit-url"]) rig.fskit = { url: args["fskit-url"], mountpoint: path.resolve(args["fskit-mountpoint"]!) };
if (args["nfs-helper"]) rig.nfs = { bin: path.resolve(args["nfs-helper"]), port: 12049, mountpoint: path.resolve(args.tree!), ac: args["nfs-ac"], dead: args["nfs-dead"] === undefined ? undefined : Number(args["nfs-dead"]) };

async function once(w: Workload, base: string): Promise<Omit<Row, "workload" | "where" | "phase">> {
  const tag = `${process.pid}-${seq++}`;
  const r = await run(w.cmd(base, tag), { cwd: w.cwd?.(base), timeoutMs: TIMEOUT });
  try { w.cleanup?.(tag); } catch {}
  const out: Omit<Row, "workload" | "where" | "phase"> = { ms: Math.round(r.ms), ok: r.ok, code: r.code, timedOut: r.timedOut };
  if (!r.ok) out.err = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ").slice(0, 400);
  return out;
}

function sumOps(s: Record<string, number>) {
  let n = 0;
  for (const [k, v] of Object.entries(s)) if (/^[A-Z]+$/.test(k) && k !== "EVENTS") n += v;
  return n;
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, "big.bin"))) {
    await run([BUN, RW, "make", path.join(ROOT, "big.bin"), "256"], { timeoutMs: 120000 });
  }
  if (args.local !== "0") {
    for (const w of chosen) {
      const dropped = await dropCaches();
      const cold = await once(w, ROOT);
      rows.push({ workload: label(w), where: "local", phase: "cold", cacheDropped: dropped, ...cold });
      const warm = await once(w, ROOT);
      rows.push({ workload: label(w), where: "local", phase: "warm", ...warm });
      log(`local ${w.name}: cold ${cold.ms} ms, warm ${warm.ms} ms${cold.ok ? "" : ` FAILED ${cold.err}`}`);
      save();
    }
  }
  await rig.startService();
  await rig.startLink(0);
  try {
    for (const policy of POLICIES) {
      for (const rtt of RTTS) {
        await rig.setLink({ rttMs: rtt, mode: "pass" });
        for (const w of chosen) {
          if (OWNER && w.name.startsWith("git-status")) {
            const r = await run(["git", "status", "--porcelain"], { cwd: path.join(ROOT, "clover"), timeoutMs: 120000 });
            if (!r.ok) log(`the holder's own git status failed: ${r.stderr.trim()}`);
          }
          await rig.mount(policy, OWNER ? ["--owner", OWNER] : []);
          const base = rig.remotePath();
          await rig.resetServiceStats();
          const cold = await once(w, base);
          const coldOps = await rig.serviceStats();
          const coldHelper = await rig.helperStats();
          rows.push({ workload: label(w), where: "mount", policy, rttMs: rtt, phase: "cold", requests: sumOps(coldOps), ops: coldOps, helper: coldHelper, ...cold });
          await rig.resetServiceStats();
          const warm = await once(w, base);
          const warmOps = await rig.serviceStats();
          rows.push({ workload: label(w), where: "mount", policy, rttMs: rtt, phase: "warm", requests: sumOps(warmOps), ops: warmOps, ...warm });
          log(`${policy} +${rtt}ms ${label(w)}: cold ${cold.ms} ms (${sumOps(coldOps)} req), warm ${warm.ms} ms (${sumOps(warmOps)} req)` +
            (cold.ok ? "" : ` COLD FAILED ${cold.err}`) + (warm.ok ? "" : ` WARM FAILED ${warm.err}`));
          save();
          await rig.unmount();
        }
      }
    }
  } finally {
    await rig.stopAll();
  }
  if (rig.nfs) result.nfs = { mountedAs: rig.nfs.mountedAs, userMountError: rig.nfs.mountError };
  result.finished = new Date().toISOString();
  save();
  report();
}

function fmt(r?: Row) {
  if (!r) return "–";
  if (r.timedOut) return `>${TIMEOUT / 1000} s`;
  if (!r.ok) return "fails";
  return r.ms >= 10000 ? `${(r.ms / 1000).toFixed(0)} s` : r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)} s` : `${r.ms} ms`;
}

function report() {
  const cols: Array<{ label: string; pick: (r: Row) => boolean }> = [{ label: "local", pick: (r) => r.where === "local" }];
  for (const p of POLICIES) for (const t of RTTS) cols.push({ label: `${p} +${t}ms`, pick: (r) => r.where === "mount" && r.policy === p && r.rttMs === t });
  let md = `\n### S6 speed on ${result.machine.os} (${result.machine.release}), ${POLICIES.join("/")}\n\n`;
  md += `| workload | phase | ${cols.map((c) => c.label).join(" | ")} |\n| :- | :- |${cols.map(() => " -: |").join("")}\n`;
  for (const w of chosen) for (const phase of ["cold", "warm"] as const) {
    md += `| ${label(w)} | ${phase} | ${cols.map((c) => fmt(rows.find((r) => r.workload === label(w) && r.phase === phase && c.pick(r)))).join(" | ")} |\n`;
  }
  md += `\nRequests that crossed the link (cold / warm):\n\n| workload | ${cols.slice(1).map((c) => c.label).join(" | ")} |\n| :- |${cols.slice(1).map(() => " -: |").join("")}\n`;
  for (const w of chosen) {
    md += `| ${label(w)} | ${cols.slice(1).map((c) => {
      const cold = rows.find((r) => r.workload === label(w) && r.phase === "cold" && c.pick(r));
      const warm = rows.find((r) => r.workload === label(w) && r.phase === "warm" && c.pick(r));
      return `${cold?.requests ?? "–"} / ${warm?.requests ?? "–"}`;
    }).join(" | ")} |\n`;
  }
  summary(md);
}

main().catch(async (e) => { console.error(e); await rig.stopAll(); save(); process.exit(1); });
