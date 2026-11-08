// The browser's live gate, for the OWNER at their own terminal (plan §10): it opens a real window, serves a fixture
// site, and walks you through the checklist for this OS (`docs/live-gates/browser.md` is the same list), measuring
// what it can and asking you for the rest. Your answers go to JSON in the run folder. An agent never runs it, and it
// refuses to run in CI or without a terminal.
//
//   cd apps/desktop && bun run scripts/browser-live-gate.ts [--out <folder>] [--section <name>] [--all]
//
// `--out` is the run folder (default: a new folder under the system's temp folder; nothing is written anywhere else,
// and no Clover home, Keychain or account is touched). `--section` runs one section (macos, windows, linux-wayland,
// companion, proxy, server); `--all` lists every step whatever the OS (for the ones that need another machine).
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_ASSETS } from "../src/main/browser/assets";
import { newRun, parseAnswer, record, refusal, renderChecklist, SECTIONS, stepsFor, summarize, type Run, type Step } from "./browser-live-gate-lib";

const root = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv.includes("--write-doc")) {
  writeFileSync(join(root, "..", "..", "docs", "live-gates", "browser.md"), renderChecklist());
  process.exit(0);
}

const why = refusal(process.env, process.stdin.isTTY === true);
if (why !== undefined) {
  console.error(`browser-live-gate: ${why}.`);
  process.exit(1);
}

const out = flag("--out") ?? mkdtempSync(join(tmpdir(), "clover-browser-live-"));
mkdirSync(out, { recursive: true });
const section = flag("--section") as Step["section"] | undefined;
if (section !== undefined && !(section in SECTIONS)) {
  console.error(`unknown section ${section}; one of ${Object.keys(SECTIONS).join(", ")}`);
  process.exit(1);
}

// ------------------------------------------------------------------------------------------------
// The fixture site
// ------------------------------------------------------------------------------------------------
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Live gate page</title>
<style>body{margin:0;padding:12px;font:16px system-ui,sans-serif} #box{width:60px;height:60px;background:#c33;position:fixed;right:20px;top:20px}</style></head><body>
<h1 id="h">Clover browser live gate</h1>
<p id="sel">select and copy this sentence</p>
<textarea id="ime" rows="4" cols="60" placeholder="type here (IME)"></textarea><br>
<input type="file" id="file"> <button id="popup" onclick="window.open('/popup','p')">Open same-site window</button>
<div id="box"></div>
<div style="height:3000px;background:linear-gradient(#eee,#9ad)">scroll me, then pinch me</div>
<script>
  const post = (o) => navigator.sendBeacon('/report', JSON.stringify(o));
  window.__t = { token: Math.random().toString(36).slice(2), ticks: 0, hz: 0, loads: (performance.getEntriesByType('navigation')[0] || {}).type || '?' };
  setInterval(() => { window.__t.ticks++; }, 50);
  let frames = 0, since = performance.now();
  (function f(t){ frames++; document.getElementById('box').style.transform = 'translateX(' + (Math.sin(t/300) * 20) + 'px)'; if (t - since >= 2000) { window.__t.hz = Math.round(frames * 1000 / (t - since)); frames = 0; since = t; } requestAnimationFrame(f); })(performance.now());
  const ime = document.getElementById('ime');
  for (const type of ['compositionstart','compositionupdate','compositionend']) ime.addEventListener(type, (e) => post({ kind: 'composition', type, data: e.data }));
  ime.addEventListener('input', () => post({ kind: 'input', value: ime.value }));
  addEventListener('wheel', (e) => post({ kind: 'wheel', ctrl: e.ctrlKey, dy: e.deltaY }), { passive: true });
</script></body></html>`;
const POPUP = `<!doctype html><title>Same-site window</title><p>The same-site window opened.</p>`;
const reports: { at: number; [k: string]: unknown }[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/report") {
      try { reports.push({ at: Date.now(), ...(JSON.parse(await req.text()) as object) }); } catch { /* ignore */ }
      return new Response(null, { status: 204 });
    }
    return new Response(url.pathname === "/popup" ? POPUP : PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
const site = `http://127.0.0.1:${server.port}`;
const since = (t: number, kind: string): typeof reports => reports.filter((r) => r.at >= t && r.kind === kind);

// ------------------------------------------------------------------------------------------------
// The app
// ------------------------------------------------------------------------------------------------
async function buildApp(): Promise<{ main: string; preload: string; html: string }> {
  const main = await Bun.build({ entrypoints: [join(import.meta.dir, "browser-live-main.ts")], outdir: out, target: "node", format: "esm", external: ["electron"], naming: "live-main.mjs", ...{ macros: false } });
  if (!main.success) throw new Error(main.logs.map(String).join("\n"));
  const preload = await Bun.build({ entrypoints: [join(root, BROWSER_ASSETS.preload.entry)], outdir: out, target: "node", format: "cjs", external: ["electron"], naming: "viewport-preload.cjs", ...{ macros: false } });
  if (!preload.success) throw new Error(preload.logs.map(String).join("\n"));
  const html = join(out, "browser-viewport.html");
  copyFileSync(join(root, BROWSER_ASSETS.html.from), html);
  return { main: join(out, "live-main.mjs"), preload: join(out, "viewport-preload.cjs"), html };
}

const built = await buildApp();
const electron = createRequire(join(root, "package.json"))("electron") as string;
const env: NodeJS.ProcessEnv = { ...process.env, CLOVER_LIVE_SITE: site, CLOVER_LIVE_PRELOAD: built.preload, CLOVER_LIVE_HTML: built.html };
delete env.ELECTRON_RUN_AS_NODE;
// Its own user-data folder in the run folder, never the real app's; no proxy of its own (the browser sets its own).
const child = spawn(electron, [`--user-data-dir=${join(out, "user-data")}`, "--no-proxy-server", ...(flag("--electron-arg") !== undefined ? [flag("--electron-arg")!] : []), built.main], { env, stdio: ["pipe", "pipe", "inherit"] });
let nextId = 0;
const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
let ready: ((v: { electron: string }) => void) | undefined;
const readyP = new Promise<{ electron: string }>((r) => (ready = r));
createInterface({ input: child.stdout! }).on("line", (line) => {
  let m: { id?: number; ok?: boolean; result?: unknown; error?: string; ready?: boolean; electron?: string; log?: string; fatal?: string };
  try { m = JSON.parse(line); } catch { return; }
  if (m.ready === true) ready?.({ electron: m.electron ?? "" });
  else if (m.fatal !== undefined) console.error(`the app failed: ${m.fatal}`);
  else if (m.id !== undefined) {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.ok === true) w?.resolve(m.result); else w?.reject(new Error(m.error ?? "failed"));
  }
});
const rpc = (cmd: string, args: Record<string, unknown> = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    child.stdin!.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
  });
const info = await readyP;

// ------------------------------------------------------------------------------------------------
// The walk
// ------------------------------------------------------------------------------------------------
const rl = createInterface({ input: process.stdin, output: process.stdout });
let run: Run = newRun({ platform: process.platform, arch: process.arch, electron: info.electron });
const save = (): void => writeFileSync(join(out, "browser-live-gate.json"), JSON.stringify(run, null, 2));
const enter = async (text: string): Promise<void> => { await rl.question(`  ${text} [Enter] `); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The measuring each step does by itself, around the owner's part. Returns what it saw. */
async function auto(step: Step): Promise<unknown> {
  switch (step.auto) {
    case "no-reload": {
      await rpc("open");
      await sleep(1500);
      const first = await rpc("probe");
      const seen: unknown[] = [first];
      for (const place of ["shown", "headless", "shown"]) {
        await enter(`press to put the tab ${place === "shown" ? "in the window" : "back offscreen"}`);
        await rpc("place", { place });
        await sleep(1200);
        seen.push(await rpc("probe"));
      }
      const same = seen.every((p: any) => p.token === first.token && p.loads === first.loads);
      const ticking = (seen.at(-1) as any).ticks > (first as any).ticks;
      return { sameDocumentEveryTime: same, timerKeptRunning: ticking, probes: seen };
    }
    case "ime-composition": {
      await rpc("open").catch(() => undefined);
      await rpc("place", { place: "shown" });
      const t = Date.now();
      await enter("do the typing described above, then press");
      const ev = since(t, "composition");
      const count = (type: string) => ev.filter((e) => e.type === type).length;
      return { compositionstart: count("compositionstart"), compositionupdate: count("compositionupdate"), compositionend: count("compositionend"), committed: since(t, "input").at(-1)?.value ?? "" };
    }
    case "scroll-and-pinch": {
      await rpc("open").catch(() => undefined);
      await rpc("place", { place: "shown" });
      const t = Date.now();
      await enter("scroll and pinch the page, then press");
      const w = since(t, "wheel");
      return { wheelEvents: w.length, pinchEvents: w.filter((e) => e.ctrl === true).length };
    }
    case "refresh-rate": {
      await rpc("open").catch(() => undefined);
      await rpc("place", { place: "shown" });
      await sleep(6000);
      const p = await rpc("probe");
      return { pageFramesPerSecond: p.hz, display: await rpc("display") };
    }
    case "scale": {
      await rpc("open").catch(() => undefined);
      await rpc("place", { place: "shown" });
      await sleep(1500);
      return { display: await rpc("display"), page: await rpc("probe") };
    }
    case "reader-host": {
      await enter("turn the screen reader on as described, then press to open a new tab for the bot");
      const r = await rpc("readerTab");
      await sleep(1500);
      const before = await rpc("probe");
      await enter("press to show that tab in the window");
      await rpc("place", { place: "shown" });
      await sleep(1200);
      return { screenReaderOn: r.screenReaderOn, openedAt: r.tab.place, probeHidden: before, probeShown: await rpc("probe"), display: await rpc("display") };
    }
    case "proxy-load": {
      const kind = (await rl.question("  explicit proxy URL (http://, https://, socks5://), or 'system' for the OS's setting: ")).trim();
      const url = (await rl.question("  a public https URL to load through it [https://example.com/]: ")).trim() || "https://example.com/";
      const setting = kind === "system" ? { mode: "system" } : { mode: "explicit", url: kind };
      await rpc("open").catch(() => undefined);
      await rpc("proxy", { setting });
      const loaded = await rpc("load", { url, waitMs: 10_000 });
      await rpc("proxy", { setting: { mode: "off" } });
      return { setting: kind === "system" ? "system" : "explicit", url, loaded };
    }
    default:
      return undefined;
  }
}

const steps = stepsFor(process.platform, { all: argv.includes("--all"), ...(section !== undefined ? { section } : {}) });
console.log(`\nClover browser live gate: ${steps.length} steps for ${process.platform}. The run folder is ${out}\nAnswer p (pass), f (fail) or s (skip); add a note when asked. Ctrl+C stops; what you answered is saved.\n`);
let currentSection = "";
try {
  for (const step of steps) {
    if (step.section !== currentSection) {
      currentSection = step.section;
      console.log(`\n== ${SECTIONS[step.section]}`);
    }
    console.log(`\n${step.id}: ${step.title}`);
    for (const line of step.do) console.log(`  - ${line}`);
    console.log(`  Pass looks like: ${step.expect}`);
    let measured: unknown;
    if (step.auto !== undefined && (await rl.question("  run this step now? [Y/n] ")).trim().toLowerCase() !== "n") {
      try { measured = await auto(step); } catch (e) { measured = { error: e instanceof Error ? e.message : String(e) }; }
      console.log(`  measured: ${JSON.stringify(measured)}`);
    }
    let answer = parseAnswer(await rl.question("  result (p/f/s): "));
    while (answer === undefined) answer = parseAnswer(await rl.question("  p, f or s: "));
    const note = answer === "skip" ? "" : (await rl.question("  note (optional): ")).trim();
    run = record(run, step, answer, { note, auto: measured });
    save();
  }
} finally {
  save();
  await rpc("quit").catch(() => undefined);
  rl.close();
  server.stop(true);
  const n = summarize(run);
  console.log(`\nDone: ${n.pass} passed, ${n.fail} failed, ${n.skip} skipped. Your answers are in ${join(out, "browser-live-gate.json")}`);
  setTimeout(() => process.exit(0), 1500).unref();
}
