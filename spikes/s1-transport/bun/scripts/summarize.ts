// Turns S1 result files into Markdown tables (for $GITHUB_STEP_SUMMARY) and a few compact
// GitHub notices (readable without auth from the public check-runs API).
//
//   bun scripts/summarize.ts platform|nat|netem <results.jsonl> [more.jsonl...]

import { appendFileSync, readFileSync } from "node:fs";

type R = Record<string, any>;
const [kind, ...files] = process.argv.slice(2);
const rows: R[] = files.flatMap((f) =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l) as R;
      } catch {
        return { check: "unparsed", ok: false, error: l.slice(0, 200) };
      }
    }),
);

const md: string[] = [];
const notices: Array<[string, string]> = [];
const f1 = (x: unknown) => (typeof x === "number" ? (Math.round(x * 10) / 10).toString() : "–");
const f2 = (x: unknown) => (typeof x === "number" ? (Math.round(x * 100) / 100).toString() : "–");

if (kind === "platform") {
  const platform = rows.find((r) => r.platform)?.platform ?? "unknown";
  md.push(`### S1 platform checks · ${platform}`, "", "| check | compiled | ok | numbers |", "| :- | :- | :- | :- |");
  const compact: R = { platform };
  for (const r of rows) {
    const name = `${r.check}${r.browser ? `-${r.browser}` : ""}${r.runtime?.startsWith("node") ? "-node" : ""}${r.cc && r.cc !== "cubic" ? `-${r.cc}` : ""}${r.sizes?.yieldEvery > 0 ? "-yield" : ""}`;
    let nums = "";
    if (r.bulk) nums += `bulk ${f1(r.bulk.MBps)} MB/s; `;
    if (r.rpcStream) nums += `rpc p50 ${f2(r.rpcStream.p50)} ms; `;
    if (r.rtt64B) nums += `rtt p50 ${f2(r.rtt64B.p50)} ms; `;
    if (r.rpcUnderLoad_prioritised)
      nums += `under load p50 ${f2(r.rpcUnderLoad_prioritised.p50)} p99 ${f2(r.rpcUnderLoad_prioritised.p99)} ms (n ${r.rpcUnderLoad_prioritised.n}); `;
    if (r.rttUnderLoad) nums += `under load p50 ${f2(r.rttUnderLoad.p50)} ms (n ${r.rttUnderLoad.n}); `;
    if (r.binaries) nums += Object.entries(r.binaries as Record<string, { MB: number }>).map(([k, v]) => `${k} ${v.MB} MB`).join(", ");
    if (r.rttUnderUpload) nums += `under upload p50 ${f2(r.rttUnderUpload.p50)} ms; `;
    if (r.uploadMBps) nums += `up ${f1(r.uploadMBps)} / down ${f1(r.downloadMBps)} MB/s; `;
    if (r.openMs) nums += `open ${f1(r.openMs)} ms; `;
    if (r.echo) nums += `echo ${f1(r.echo.MBpsEachWay)} MB/s; `;
    if (r.bulk?.timer10msDuringBulk) nums += `timer ${r.bulk.timer10msDuringBulk.fired}/${r.bulk.timer10msDuringBulk.expected}; `;
    if (r.bulk?.timer10ms) nums += `timer ${r.bulk.timer10ms.fired}/${r.bulk.timer10ms.expected}; `;
    if (r.loadMs !== undefined && r.check?.startsWith("iroh")) nums += `load ${f1(r.loadMs)} ms; `;
    if (!r.ok) nums = String(r.error ?? "").replace(/\s+/g, " ").slice(0, 160);
    md.push(`| ${name} | ${r.compiled ? "yes" : ""} | ${r.ok ? "yes" : "**no**"} | ${nums} |`);
    compact[name + (r.compiled ? "-c" : "")] = r.ok
      ? (r.bulk?.MBps ?? r.uploadMBps ?? r.echo?.MBpsEachWay ?? true)
      : false;
  }
  notices.push([`S1 platform ${platform}`, JSON.stringify(compact)]);
} else if (kind === "nat") {
  const runs = new Map<string, R[]>();
  for (const r of rows.filter((r) => r.name === "a")) {
    const key = `${r.transport}/${r.strategy}`;
    runs.set(key, [...(runs.get(key) ?? []), r]);
  }
  for (const [key, rs] of runs) {
    const types = [...new Set(rs.flatMap((r) => [r.natA, r.natB]))].filter((t) => t !== "lan");
    md.push(`### Direct connection without a relay · ${key}`, "", `| a \\ b | ${types.join(" | ")} |`, `| :- |${types.map(() => " :-: |").join("")}`);
    const cell = (a: string, b: string) => {
      const r = rs.find((x) => x.natA === a && x.natB === b) ?? (key.endsWith("both") ? rs.find((x) => x.natA === b && x.natB === a) : undefined);
      if (!r) return "";
      return r.ok ? `yes ${Math.round(r.connectMs)} ms` : "**no**";
    };
    for (const a of types) md.push(`| ${a} | ${types.map((b) => cell(a, b)).join(" | ")} |`);
    const lan = rs.find((r) => r.natA === "lan");
    if (lan) md.push("", `Same LAN behind one router: ${lan.ok ? `yes, ${Math.round(lan.connectMs)} ms, via ${JSON.stringify(lan.pathAtConnect)}` : `**no** (${lan.error})`}`);
    md.push("");
    const ok = rs.filter((r) => r.ok && r.natA !== "lan");
    const fails = rs.filter((r) => !r.ok).map((r) => `${r.natA}x${r.natB}`);
    const ms = ok.map((r) => r.connectMs as number).sort((x, y) => x - y);
    notices.push([
      `S1 NAT ${key}`,
      JSON.stringify({ direct: `${ok.length}/${rs.filter((r) => r.natA !== "lan").length}`, lan: lan?.ok ?? null, connectMsP50: ms[Math.floor(ms.length / 2)] ?? null, fails }),
    ]);
  }
} else if (kind === "netem") {
  const profiles = [...new Set(rows.map((r) => r.profile))];
  for (const p of profiles) {
    const rs = rows.filter((r) => r.profile === p);
    const n = rs[0]?.netem;
    md.push(
      `### ${p}: ${n?.oneWayDelayMs} ms each way, ${n?.lossPct}% loss, ${n?.rate}`,
      "",
      "| impl | connect ms | rpc p50 / p99 ms | per-stream rpc p50 | bulk MB/s | 1 MB shot p50 ms | under load, prioritised p50 / p99 | under load, equal p50 / p99 |",
      "| :- | -: | -: | -: | -: | -: | -: | -: |",
    );
    const compact: R = {};
    for (const r of rs) {
      const name = `${r.impl}/${r.cc}`;
      if (!r.ok) {
        md.push(`| ${name} | **failed**: ${String(r.error).replace(/\s+/g, " ").slice(0, 120)} |||||||`);
        compact[name] = false;
        continue;
      }
      const lp = r.rpcUnderLoad_prioritised;
      const le = r.rpcUnderLoad_equal;
      md.push(
        `| ${name} | ${f1(r.connectMs)} | ${f2(r.rpcStream?.p50)} / ${f2(r.rpcStream?.p99)} | ${f2(r.rpcPerStream?.p50)} | ${f1(r.bulk?.MBps)} | ${f1(r.screenshot1MB?.p50)} | ${f1(lp?.p50)} / ${f1(lp?.p99)} | ${f1(le?.p50)} / ${f1(le?.p99)} |`,
      );
      compact[name] = [r.rpcStream?.p50, r.bulk?.MBps, lp?.p50, lp?.p99].map((x) => (typeof x === "number" ? Math.round(x * 10) / 10 : null));
    }
    md.push("");
    notices.push([`S1 netem ${p} [rpc p50, MB/s, load p50, load p99]`, JSON.stringify(compact)]);
  }
} else if (kind === "migrate") {
  md.push(
    "### One connection through network changes",
    "",
    "| transport | scenario | all replies back | replies | longest gap ms | last reply s | connection lost |",
    "| :- | :- | :- | -: | -: | -: | :- |",
  );
  const compact: R = {};
  for (const r of rows) {
    const lost = r.connectionLost ? String(r.error ?? "yes").replace(/\s+/g, " ").slice(0, 80) : "";
    md.push(`| ${r.transport} | ${r.label} | ${r.recovered ? "yes" : "**no**"} | ${r.received}/${r.sent} | ${f1(r.maxGapMs)} | ${f2(r.lastReplyAtS)} | ${lost} |`);
    compact[`${r.transport}/${r.label}`] = r.recovered ? Math.round(r.maxGapMs) : false;
  }
  notices.push(["S1 network changes [longest gap ms, false = replies never all came back]", JSON.stringify(compact)]);
} else {
  console.error("usage: summarize.ts platform|nat|netem|migrate <files...>");
  process.exit(2);
}

const text = md.join("\n") + "\n";
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
for (const [title, body] of notices.slice(0, 10)) console.log(`::notice title=${title}::${body}`);
