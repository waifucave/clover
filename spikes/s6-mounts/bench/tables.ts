#!/usr/bin/env bun
// Turns the S6 result files (spikes/s6-mounts/results/*.json) into the report's markdown tables.
//   bun bench/tables.ts spikes/s6-mounts/results

import * as fs from "node:fs";
import * as path from "node:path";
import { shrinkVerdict } from "./coherence";

const dir = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "..", "results"));
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const fmt = (ms?: number, timedOut?: boolean, ok?: boolean) => {
  if (timedOut) return "timeout";
  if (ok === false) return "fails";
  if (ms === undefined) return "–";
  return ms >= 10000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
};

// ---- speed ------------------------------------------------------------------------------------
// One table per mount kind: linux, windows, macos-nfs, macos-fskit. A later run of the same
// workload (a rerun after a fix) replaces the earlier rows; each file says when it started.
const speedByOs = new Map<string, any[]>();
const speedFiles = files.filter((f) => f.includes("speed")).map((f) => ({ f, d: load(f) }))
  .sort((a, b) => String(a.d.started).localeCompare(String(b.d.started)));
const rowKey = (r: any) => [r.workload, r.where, r.policy, r.rttMs, r.phase].join("|");
for (const { f, d } of speedFiles) {
  const os = f.replace(/-speed.*$/, "") + (f.includes("nfs") ? "-nfs" : "");
  const fresh = d.rows.map((r: any) => ({ ...r, file: f }));
  const keys = new Set(fresh.map(rowKey));
  speedByOs.set(os, [...(speedByOs.get(os) ?? []).filter((r) => !keys.has(rowKey(r))), ...fresh]);
}
for (const [os, rows] of speedByOs) {
  const workloads = [...new Set(rows.map((r) => r.workload))];
  const mounts = [...new Set(rows.filter((r) => r.where === "mount").map((r) => `${r.policy} +${r.rttMs}`))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  console.log(`\n#### ${os}: time (cold / warm)\n`);
  console.log(`| workload | local | ${mounts.join(" | ")} |`);
  console.log(`| :- | -: |${mounts.map(() => " -: |").join("")}`);
  for (const w of workloads) {
    const cell = (pick: (r: any) => boolean) => {
      const c = rows.find((r) => r.workload === w && r.phase === "cold" && pick(r));
      const h = rows.find((r) => r.workload === w && r.phase === "warm" && pick(r));
      return `${fmt(c?.ms, c?.timedOut, c?.ok)} / ${fmt(h?.ms, h?.timedOut, h?.ok)}`;
    };
    console.log(`| ${w} | ${cell((r) => r.where === "local")} | ${mounts.map((m) => cell((r) => r.where === "mount" && `${r.policy} +${r.rttMs}` === m)).join(" | ")} |`);
  }
  console.log(`\n#### ${os}: requests that crossed the link (cold / warm)\n`);
  console.log(`| workload | ${mounts.join(" | ")} |`);
  console.log(`| :- |${mounts.map(() => " -: |").join("")}`);
  for (const w of workloads) {
    const cell = (m: string) => {
      const c = rows.find((r) => r.workload === w && r.phase === "cold" && r.where === "mount" && `${r.policy} +${r.rttMs}` === m);
      const h = rows.find((r) => r.workload === w && r.phase === "warm" && r.where === "mount" && `${r.policy} +${r.rttMs}` === m);
      return `${c?.requests ?? "–"} / ${h?.requests ?? "–"}`;
    };
    console.log(`| ${w} | ${mounts.map(cell).join(" | ")} |`);
  }
  if (rows.some((r) => r.nfsCallsTotal !== undefined)) {
    console.log(`\n#### ${os}: NFS calls the kernel made, and the helper's time on them (cold / warm)\n`);
    console.log(`| workload | ${mounts.join(" | ")} |`);
    console.log(`| :- |${mounts.map(() => " -: |").join("")}`);
    for (const w of workloads) {
      const cell = (m: string) => {
        const c = rows.find((r) => r.workload === w && r.phase === "cold" && r.where === "mount" && `${r.policy} +${r.rttMs}` === m);
        const h = rows.find((r) => r.workload === w && r.phase === "warm" && r.where === "mount" && `${r.policy} +${r.rttMs}` === m);
        const one = (r: any) => (r?.nfsCallsTotal === undefined ? "–" : `${r.nfsCallsTotal} (${fmt(r.nfsHelperMs)})`);
        return `${one(c)} / ${one(h)}`;
      };
      console.log(`| ${w} | ${mounts.map(cell).join(" | ")} |`);
    }
  }
  const failures = rows.filter((r) => !r.ok && !r.timedOut);
  if (failures.length) {
    console.log(`\nFailures on ${os}:`);
    for (const r of failures) console.log(`- ${r.workload} ${r.where} ${r.policy ?? ""} +${r.rttMs ?? 0} ${r.phase}: ${r.err}`);
  }
}

// ---- fail-fast --------------------------------------------------------------------------------
for (const f of files.filter((f) => f.includes("failfast"))) {
  const d = load(f);
  console.log(`\n#### fail-fast: ${f.replace(".json", "")} (${d.machine.os} ${d.machine.release}, ${d.policy}, +${d.rttMs} ms)\n`);
  console.log("| scenario | in-flight op fails after | what the program saw | a new op while away | stuck processes | works again after |");
  console.log("| :- | -: | :- | :- | -: | -: |");
  for (const r of d.results) {
    if (r.scenario === "slow-link") {
      const why = (err?: string) => { try { const e = JSON.parse(String(err)); return e.message ?? e.code ?? String(err); } catch { return String(err ?? ""); } };
      const one = (ok: boolean, ms: number, err?: string) => (ok ? `ok in ${fmt(ms)}` : `**failed** after ${fmt(ms)}: ${why(err).replace(/\|/g, "/").slice(0, 70)}`);
      console.log(`| slow link (${r.fault}) | write: ${one(r.writeOk, r.writeMs, r.writeError)}; read: ${one(r.readOk, r.readMs, r.readError)} | false offline: ${r.falseOffline ?? "–"}, request timeouts: ${r.requestTimeouts ?? "–"} | – | ${r.stuckProcesses?.length ?? 0} | – |`);
      continue;
    }
    const hung = r.killedBySigkill ? "**hung**, SIGKILL freed it" : r.freedByDetachMs > 0 ? `**hung**, umount -f freed it after ${r.freedByDetachMs} ms` : "**hung**, still stuck";
    const fail = r.hung ? hung : r.failMs !== undefined ? `${r.failMs} ms` : r.firstCall ? `${Math.round(r.firstCall.ms)} ms (first call)` : "–";
    const saw = String(r.sawError ?? r.firstCall?.code ?? r.listComputer?.code ?? r.error ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 80);
    const p = r.whileDown ?? r.laterCall ?? r.statFile ?? r.deadMount;
    const down = p ? (p.ok ? `ok in ${Math.round(p.ms)} ms` : `${p.code} in ${p.ms < 1 ? "<1" : Math.round(p.ms)} ms`) : "–";
    const stuck = (r.stuckProcesses?.length ?? 0) + (r.stuckAfter?.length ?? 0);
    const back = r.recoverMs ?? r.remountMs;
    const detach = r.detachAtDeathMs !== undefined ? ` (the daemon's force-unmount at the helper's death took ${r.detachAtDeathMs} ms)` : "";
    console.log(`| ${r.scenario} | ${fail}${detach} | ${saw} | ${down} | ${stuck} | ${back !== undefined ? `${back} ms` : "–"} |`);
  }
  if (d.nfs) {
    const n = d.nfs;
    const opts = [n.ac, n.timeo !== undefined ? `timeo=${n.timeo}` : "", n.rsize ? `rsize=${n.rsize}` : "", n.readahead ? `readahead=${n.readahead}` : ""].filter(Boolean).join(", ");
    console.log(`\nNFS mounted as: ${n.mountedAs}${n.userMountError ? ` (as the user: ${n.userMountError})` : ""}${opts ? `; ${opts}` : ""}${n.treeRootMode ? `; tree root ${n.treeRootMode}` : ""}`);
  }
}

// ---- macOS volume checks (bench/volume.ts) ------------------------------------------------------
for (const f of files.filter((f) => f.includes("volume"))) {
  const d = load(f);
  console.log(`\n#### volume: ${f.replace(".json", "")} (${d.machine.os} ${d.machine.release})\n`);
  console.log("| mount | the holder's folder after xattr -w, cp -p and ditto | xattr -w | mdutil -s | tmutil isexcluded |");
  console.log("| :- | :- | :- | :- | :- |");
  const cell = (v: unknown) => String(v ?? "–").replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 90);
  for (const r of d.runs) {
    const seen = r.mountError ? `mount failed: ${cell(r.mountError)}` : (r.holderSees ?? []).join(", ");
    console.log(`| ${r.label} | ${seen} | ${cell(r.xattrWrite) || "ok"} | ${cell(r.mdutil)} | ${cell(r.tmutilIsExcluded)} |`);
  }
  console.log(`\nDSDontWriteNetworkStores: ${cell(d.dsDontWriteNetworkStores)}`);
}

// ---- coherence --------------------------------------------------------------------------------
for (const f of files.filter((f) => f.includes("coherence"))) {
  const d = load(f);
  console.log(`\n#### coherence: ${f.replace(".json", "")} (${d.machine.os} ${d.machine.release})\n`);
  console.log("| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |");
  console.log("| :- | :- | :- | :- | -: | :- | -: | -: | -: |");
  for (const r of d.results) {
    const t = (v: number) => (v < 0 ? "never (10 s)" : `${v} ms`);
    const so = r.statOnlyShrunkRead ? shrinkVerdict(r.statOnlyShrunkRead) : "–";
    console.log(`| ${r.label} | ${so} | ${r.statOnlyGrowVerdict ?? "–"} | ${r.shrunkRead ? shrinkVerdict(r.shrunkRead) : r.shrinkVerdict} | ${t(r.sizeFreshAfterMs)} | ${r.growVerdict} | ${t(r.grownFreshAfterMs)} | ${t(r.newNameVisibleAfterMs)} | ${r.newNameVisibleAfterMs < 0 ? "(never seen)" : t(r.deletedGoneAfterMs)} |`);
  }
  if (d.selfLink) console.log(`\nhome/<this computer>: ${JSON.stringify(d.selfLink)}`);
}
