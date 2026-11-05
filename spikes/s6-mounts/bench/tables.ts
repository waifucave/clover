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
const speedByOs = new Map<string, any[]>();
for (const f of files.filter((f) => f.includes("speed"))) {
  const d = load(f);
  const os = f.split("-")[0]!;
  speedByOs.set(os, [...(speedByOs.get(os) ?? []), ...d.rows.map((r: any) => ({ ...r, file: f }))]);
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
    const fail = r.hung ? "**hung**" : r.failMs !== undefined ? `${r.failMs} ms` : r.firstCall ? `${Math.round(r.firstCall.ms)} ms (first call)` : "–";
    const saw = String(r.sawError ?? r.firstCall?.code ?? r.listComputer?.code ?? r.error ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 80);
    const p = r.whileDown ?? r.laterCall ?? r.statFile ?? r.deadMount;
    const down = p ? (p.ok ? `ok in ${Math.round(p.ms)} ms` : `${p.code} in ${p.ms < 1 ? "<1" : Math.round(p.ms)} ms`) : "–";
    const stuck = (r.stuckProcesses?.length ?? 0) + (r.stuckAfter?.length ?? 0);
    const back = r.recoverMs ?? r.remountMs;
    console.log(`| ${r.scenario} | ${fail} | ${saw} | ${down} | ${stuck} | ${back !== undefined ? `${back} ms` : "–"} |`);
  }
  if (d.nfs) console.log(`\nNFS mounted as: ${d.nfs.mountedAs}${d.nfs.userMountError ? ` (as the user: ${d.nfs.userMountError})` : ""}`);
}

// ---- coherence --------------------------------------------------------------------------------
for (const f of files.filter((f) => f.includes("coherence"))) {
  const d = load(f);
  console.log(`\n#### coherence: ${f.replace(".json", "")} (${d.machine.os} ${d.machine.release})\n`);
  console.log("| mount | file shrinks behind it | size seen after | file grows behind it | grown content seen after | new name seen after | delete seen after |");
  console.log("| :- | :- | -: | :- | -: | -: | -: |");
  for (const r of d.results) {
    const t = (v: number) => (v < 0 ? "never (10 s)" : `${v} ms`);
    console.log(`| ${r.label} | ${r.shrunkRead ? shrinkVerdict(r.shrunkRead) : r.shrinkVerdict} | ${t(r.sizeFreshAfterMs)} | ${r.growVerdict} | ${t(r.grownFreshAfterMs)} | ${t(r.newNameVisibleAfterMs)} | ${t(r.deletedGoneAfterMs)} |`);
  }
  if (d.selfLink) console.log(`\nhome/<this computer>: ${JSON.stringify(d.selfLink)}`);
}
