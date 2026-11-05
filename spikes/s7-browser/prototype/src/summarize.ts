#!/usr/bin/env bun
// Turn the CI results (one JSON per job) into Markdown tables, for the job summary and the report.
//   bun run src/summarize.ts <results folder> [> summary.md]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".json")) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const f1 = (v: unknown, d = 1): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : v === undefined || v === null ? "–" : String(v));
const ms = (s: J | undefined): string => (s === undefined || !s.n ? "–" : `${f1(s.p50, 0)} / ${f1(s.p95, 0)}`);
const table = (head: string[], rows: string[][]): string => [`| ${head.join(" | ")} |`, `| ${head.map(() => ":-").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

function electron(name: string, j: J): string {
  const m = j.meta ?? {};
  const c = j.checks ?? {};
  const out: string[] = [`### Electron · ${m.label} (${name})`, "", `Electron ${m.electron} (Chromium ${m.chrome}), ${m.platform}-${m.arch} ${m.osRelease}, ozone ${m.ozone}, displays ${(m.displays ?? []).join(", ")}, status **${m.status}**, ${f1(m.seconds, 0)} s${(j.errors ?? []).length ? `, errors: ${j.errors.join("; ")}` : ""}`, ""];
  if (c.move) {
    out.push("**Q1 hidden ⇄ shown** (5 cycles; times are p50 / p95 ms from the move)", "");
    out.push(table(["hidden place", "same document", "field", "scroll", "SSE", "media ×", "decoded fps", "→shown resize", "first rAF", "fresh picture", "→hidden resize", "layout hidden → shown", "error"],
      ["detached", "hiddenWindow"].filter((k) => c.move[k]).map((k) => {
        const r = c.move[k];
        return [k, f1(r.checks?.sameDocument), f1(r.checks?.fieldKept), f1(r.checks?.scrollKept), `${f1(r.checks?.sseKept)} (${f1(r.checks?.sseOpensServer, 0)} opens)`, f1(r.checks?.mediaPlayedPerSec, 2), f1(r.checks?.mediaDecodedFps, 1),
          ms(r.timing?.showResizeMs), ms(r.timing?.showFirstRafMs), ms(r.timing?.showFreshPictureMs), ms(r.timing?.hideResizeMs), `${r.layout?.hidden} → ${r.layout?.shown}`, r.error ?? ""];
      })));
    out.push("");
    for (const k of ["detached", "hiddenWindow"]) {
      const r = c.move[k];
      if (!r?.cycles?.length) continue;
      const h = r.cycles.map((x: J) => x.hiddenRates).filter(Boolean);
      const s = r.cycles.map((x: J) => x.shownRates).filter(Boolean);
      const avg = (a: J[], f: string) => (a.length ? a.reduce((t, x) => t + (x[f] ?? 0), 0) / a.length : NaN);
      out.push(`- ${k}: while hidden, interval ${f1(avg(h, "intervalHz"))} Hz, rAF ${f1(avg(h, "rafHz"))} Hz, media ×${f1(avg(h, "mediaPlayedPerSec"), 2)}, decoded ${f1(avg(h, "decodedFps"))} fps, visibility ${h[0]?.visibility}; while shown, rAF ${f1(avg(s, "rafHz"))} Hz, visibility ${s[0]?.visibility}; initial (hidden) rAF ${f1(r.initialRates?.rafHz)} Hz`);
    }
    out.push("");
  }
  if (c.throttle) {
    out.push("**Q2 throttling** (5 s windows)", "");
    out.push(table(["config", "visibility", "interval Hz", "chain Hz", "rAF Hz", "max rAF gap ms", "media ×", "decoded fps", "audio", "renderer CPU %", "error"],
      c.throttle.map((r: J) => [r.config, r.rates?.visibility ?? "–", f1(r.rates?.intervalHz), f1(r.rates?.chainHz), f1(r.rates?.rafHz), f1(r.rates?.maxRafGapMs, 0), f1(r.rates?.mediaPlayedPerSec, 2), f1(r.rates?.decodedFps), r.rates?.audioState ?? "–", f1(r.rendererCpuPct), r.error ?? ""])));
    out.push("");
  }
  if (c.capture) {
    out.push("**Q2 pictures of tabs** (8 tries; ms and staleness are p50 / p95; stale < 0 means drawn after the call began)", "");
    out.push(table(["place", "throttling", "method", "ok", "decoded", "ms", "stale ms", "size", "CPU ms/picture", "frames/s", "visibility events", "errors"],
      c.capture.map((r: J) => [r.place, f1(r.throttling), r.method, `${r.ok}/${r.tries}`, f1(r.decoded, 0), ms(r.ms), ms(r.staleMs), r.size, f1(r.cpuMsPerPicture, 0), f1(r.framesPerSec), (r.visibilityEvents ?? []).length ? r.visibilityEvents.join(" ") : "", (r.errors ?? []).join("; ")])));
    out.push("");
  }
  if (c.cost) {
    const k = c.cost;
    out.push("**Q2 cost**", "");
    out.push(table(["idle hidden tabs", "memory MiB", "kind", "RSS MiB", "processes", "CPU %"], (k.idle ?? []).map((s: J) => [f1(s.tabs, 0), f1(s.memBest / 1048576, 0), s.memKind, f1(s.memRss / 1048576, 0), f1(s.procs, 0), f1(s.cpuPct)])));
    out.push("", `Per idle hidden tab: **${f1(k.perIdleTabMiB, 0)} MiB**, ${f1(k.perIdleTabCpuPct, 2)}% CPU. Four tabs: one partition +${f1(k.partitions?.samePartitionMiB, 0)} MiB, four partitions +${f1(k.partitions?.ownPartitionsMiB, 0)} MiB.${k.error ? ` Error: ${k.error}` : ""}`, "");
    out.push(table(["animated tab", "all CPU %", "renderer %", "GPU %"], (k.animated ?? []).map((a: J) => [a.config, f1(a.cpuPct), f1(a.rendererPct), f1(a.gpuPct)])));
    out.push("");
  }
  if (c.stream) {
    out.push("**Q6 streamed view** (10 s at the viewer; latency p50 / p95 ms)", "");
    out.push(table(["road", "content", "source", "fps", "decoded fps", "latency", "gap p95", "kbit/s", "bytes/frame", "sender CPU %", "viewer CPU %", "notes"],
      c.stream.map((r: J) => [r.road, r.scenario, r.source, f1(r.framesPerSec), f1(r.decodedPerSec), ms(r.latencyMs), f1(r.interFrameMs?.p95, 0), f1(r.kbitPerSec, 0), f1(r.avgFrameBytes, 0), f1(r.senderCpuPct, 0), f1(r.viewerCpuPct, 0),
        [r.extra?.sender?.encoderImplementation, r.extra?.viewer?.codec, r.extra?.viewer?.decoderImplementation, r.extra?.mainThreadJpegMsPerFrame !== undefined ? `toJPEG ${f1(r.extra.mainThreadJpegMsPerFrame)} ms` : undefined, r.extra?.encoder?.hardware, ...(r.errors ?? []).slice(0, 2)].filter(Boolean).join("; ")])));
    out.push("");
  }
  if (c.long) {
    out.push("**Long run** (rates in each window)", "");
    out.push(table(["config", "at", "visibility", "interval Hz", "chain Hz", "rAF Hz", "max chain gap ms"], c.long.map((r: J) => [r.config, r.at, r.rates?.visibility ?? "–", f1(r.rates?.intervalHz, 2), f1(r.rates?.chainHz, 2), f1(r.rates?.rafHz, 2), f1(r.rates?.maxChainGapMs, 0)])));
    out.push("");
  }
  return out.join("\n");
}

function cft(name: string, j: J): string {
  const m = j.meta ?? {};
  const out: string[] = [`### Chrome for Testing · ${m.platform}-${m.arch} (${name})`, "", `${m.osRelease}, ${m.cpus} CPUs, ${m.memGiB} GiB, Bun ${m.bun}, status **${m.status}**, ${f1(m.seconds, 0)} s`, ""];
  for (const [artifact, r] of Object.entries(j.results ?? {}) as Array<[string, J]>) {
    const i = r.install ?? {};
    out.push(`**${artifact}** — ${r.product ?? ""}; sandbox ${r.sandbox ?? "–"}${r.sandboxedStartError ? ` (sandboxed start failed: ${String(r.sandboxedStartError).slice(0, 160)})` : ""}`, "");
    out.push(`- install: ${f1(i.zipBytes / 1048576, 0)} MiB archive, ${f1(i.unpackedBytes / 1048576, 0)} MiB unpacked, ${i.files} files, ${i.symlinks} symlinks; download ${f1(i.downloadMs, 0)} ms, unpack ${f1(i.extractMs, 0)} ms; sha256 \`${i.sha256}\` (${i.verified ? "matches the pin" : "trust on first use"}; server MD5 ${f1(i.serverMd5Matched)})`);
    if (r.start) out.push(`- start: cold ${f1(r.start.coldPipeMs, 0)} ms, warm ${f1(r.start.warmPipeMs, 0)} ms over the pipe; port ${r.start.portMs !== undefined ? `${f1(r.start.portMs, 0)} ms` : r.start.portError}`);
    if (r.tabs) out.push(`- tabs: ${(r.tabs as J[]).map((t) => `${t.tab}: ${t.visibility}, ${t.layout}, interval ${f1(t.intervalHz)} Hz, rAF ${f1(t.rafHz)} Hz, media ×${f1(t.mediaPlayedPerSec, 2)}, decoded ${f1(t.decodedFps)} fps, audio ${t.audioState}`).join("; ")}`);
    if (r.resize) out.push(`- resize to 1000×700 and back: ${f1(r.resize.toViewMs, 0)} ms / ${f1(r.resize.backMs, 0)} ms, same document ${f1(r.resize.sameDocument)} (${(r.resize.layouts ?? []).join(" → ")})`);
    if (r.screenshots) out.push(`- screenshots: png ${ms(r.screenshots.png?.ms)} ms (${f1(r.screenshots.png?.bytes?.p50 / 1024, 0)} KiB, CPU ${f1(r.screenshots.png?.cpuMsPerShot, 0)} ms), jpeg ${ms(r.screenshots.jpeg?.ms)} ms (${f1(r.screenshots.jpeg?.bytes?.p50 / 1024, 0)} KiB, stale ${ms(r.screenshots.jpeg?.staleMs)} ms, CPU ${f1(r.screenshots.jpeg?.cpuMsPerShot, 0)} ms)`);
    if (r.screencast) out.push(`- screencast: ${f1(r.screencast.framesPerSec)} fps, ${f1(r.screencast.kbitPerSec, 0)} kbit/s, ${f1(r.screencast.avgFrameBytes / 1024, 0)} KiB/frame, latency ${ms(r.screencast.latencyMs)} ms, browser CPU ${f1(r.screencast.browserCpuPct, 0)}%`);
    if (r.profiles) out.push(`- per-bot profiles: isolated ${f1(r.profiles.isolated)}, persisted across a restart ${f1(r.profiles.persisted)}`);
    if (r.cost) {
      out.push(`- cost: browser base ${f1(r.cost.browserBaseMiB, 0)} MiB, per idle tab ${f1(r.cost.perIdleTabMiB, 0)} MiB, 4 browser contexts +${f1(r.cost.fourContextsMiB, 0)} MiB, a second bot's browser ${f1(r.cost.secondBrowserBaseMiB, 0)} MiB (${r.cost.secondBrowserProcs} processes), animated tab ${f1(r.cost.animatedTabCpuPct)}% CPU`);
      out.push(`  - steps: ${(r.cost.steps as J[]).map((s) => `${s.tabs} tabs ${f1(s.memMiB, 0)} MiB ${s.memKind} / ${f1(s.cpuPct)}%`).join(", ")}`);
    }
    if ((r.errors ?? []).length) out.push(`- errors: ${r.errors.join("; ")}`);
    out.push("");
  }
  return out.join("\n");
}

function pair(name: string, j: J): string {
  const m = j.meta ?? {};
  const out: string[] = [`### The pair · ${m.platform}-${m.arch} (${name})`, "", `${m.osRelease}, ${f1(m.seconds, 0)} s, state **${m.state}**${m.windowsAppStart ? `, Windows app start: ${m.windowsAppStart}` : ""}`, ""];
  for (const s of j.steps ?? []) {
    const { step, ...rest } = s as J;
    if (step === "uninstall") continue;
    const brief = JSON.stringify(rest, (k, v) => (k === "out" && typeof v === "string" ? v.slice(0, 160) : k === "unit" || k === "registeredForLogin" || k === "install" ? undefined : v));
    out.push(`- **${step}**: ${brief.slice(0, 900)}`);
  }
  out.push("");
  return out.join("\n");
}

const dir = process.argv[2] ?? "out/results";
const parts: string[] = ["## Spike S7 results", ""];
for (const f of files(dir)) {
  let j: J;
  try { j = JSON.parse(readFileSync(f, "utf8")) as J; } catch { continue; }
  const name = basename(f);
  if (j.checks !== undefined) parts.push(electron(name, j));
  else if (j.results !== undefined) parts.push(cft(name, j));
  else if (j.steps !== undefined) parts.push(pair(name, j));
}
console.log(parts.join("\n"));
