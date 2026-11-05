#!/usr/bin/env bun
// Question 4: the browser where no app runs. The daemon installs a pinned Chrome for Testing (the headless shell and
// full Chrome in headless mode, to compare), starts one browser per bot with its own profile over the DevTools pipe,
// and runs the same tab operations as the app's checks: timers and rAF in background tabs, a resize without a
// reload, screenshots, a screencast, persistent per-bot profiles, and what a browser and a tab cost.
//   CI only (it launches a browser):  bun run src/cft/run.ts --out=out/results/cft.json [--artifacts=…] [--home=…]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import jpeg from "jpeg-js";
import { Browser, Page } from "./cdp.ts";
import { install, type Artifact, type InstallResult } from "./install.ts";
import { ageMs, decodeMarker, rgbaReader } from "../shared/marker.ts";
import { sampleTree, treeCpuPct } from "../shared/procmem.ts";
import { startServer, type SpikeServer } from "../shared/server.ts";
import { errorText, rate, rounded, sleep, summarize, waitFor } from "../shared/stats.ts";

if (process.env.CI !== "true" && process.env.S7_ALLOW_LOCAL !== "1") {
  console.error("cft: refusing to run here — it launches a browser. It runs in CI (set S7_ALLOW_LOCAL=1 only on a machine nobody is using).");
  process.exit(2);
}

const ROOT = resolve(import.meta.dir, "..", "..");
function arg(name: string, fallback: string): string {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a === undefined ? fallback : a.slice(p.length);
}
const outFile = resolve(arg("out", join(ROOT, "out", "results", "cft.json")));
const artifacts = arg("artifacts", "chrome-headless-shell,chrome").split(",").filter(Boolean) as Artifact[];
const home = resolve(arg("home", mkdtempSync(join(tmpdir(), "clover-s7-home-"))));
const only = arg("only", "").split(",").filter(Boolean);
const keepHome = process.argv.includes("--keep-home");
const started = Date.now();
const log = (s: string): void => console.log(`[cft ${((Date.now() - started) / 1000).toFixed(1)}s] ${s}`);
const want = (step: string): boolean => only.length === 0 || only.includes(step);

interface Snap {
  token: string; now: number; visibility: string; innerWidth: number; innerHeight: number;
  interval: { n: number; maxGap: number }; raf: { n: number; maxGap: number }; chain: { n: number; maxGap: number };
  media: null | { played: number; decodedFrames: number; paused: boolean; audioState: string };
}

function baseArgs(artifact: Artifact, profile: string, extra: string[]): string[] {
  return [
    ...(artifact === "chrome" ? ["--headless"] : []),
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--disable-default-apps", "--mute-audio", "--hide-scrollbars",
    "--window-size=1280,800", "--use-mock-keychain", "--password-store=basic", ...extra, "about:blank",
  ];
}

interface Launcher { bin: string; artifact: Artifact; extra: string[]; sandbox: string }

async function launch(l: Launcher, profile: string, transport: "pipe" | "port" = "pipe"): Promise<{ b: Browser; ms: number }> {
  const t0 = Date.now();
  const b = await Browser.launch(l.bin, baseArgs(l.artifact, profile, l.extra), transport);
  return { b, ms: Date.now() - t0 };
}

function decodeJpeg(data: Buffer, pageWidth: number, at: number): number | undefined {
  try {
    const img = jpeg.decode(data, { useTArray: true, formatAsRGBA: true });
    const m = decodeMarker(rgbaReader(img.data, img.width, img.height), img.width / pageWidth);
    return m === null ? undefined : ageMs(at, m.t24);
  } catch {
    return undefined;
  }
}

async function probeTab(b: Browser, server: SpikeServer, query: string, contextId?: string): Promise<Page> {
  const p = await Page.open(b, `${server.origin}/pages/probe.html?${query}`, contextId);
  await waitFor(() => p.eval<boolean>("typeof window.__s7 === 'object'").then((v) => (v ? true : undefined)), 5000);
  return p;
}

async function forArtifact(artifact: Artifact, server: SpikeServer): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { artifact };
  const errors: string[] = [];
  out.errors = errors;
  let inst: InstallResult;
  try {
    inst = await install(home, artifact, log);
    out.install = inst;
    log(`${artifact}: ${(inst.zipBytes / 1048576).toFixed(0)} MiB archive in ${inst.downloadMs} ms, ${(inst.unpackedBytes / 1048576).toFixed(0)} MiB unpacked (${inst.files} files) in ${inst.extractMs} ms, sha256 ${inst.sha256.slice(0, 16)}… ${inst.verified ? "matches the pin" : "(trust on first use)"}`);
  } catch (e) {
    errors.push(`install: ${errorText(e)}`);
    return out;
  }
  const l: Launcher = { bin: inst.bin, artifact, extra: [], sandbox: "on" };
  const profiles = join(home, "browsers", "profiles");

  // --- start: cold, warm, the pipe and the port --------------------------------------------------------------------
  try {
    const prof = join(profiles, `${artifact}-start`);
    let first: { b: Browser; ms: number };
    try {
      first = await launch(l, prof);
    } catch (e) {
      // Ubuntu 23.10+ restricts unprivileged user namespaces: without an AppArmor profile Chrome's sandbox can't start.
      out.sandboxedStartError = errorText(e);
      l.extra = ["--no-sandbox"];
      l.sandbox = "off (--no-sandbox: the sandboxed start failed)";
      first = await launch(l, prof);
    }
    const version = await first.b.send<{ product: string; userAgent: string }>("Browser.getVersion");
    out.product = version.product;
    out.sandbox = l.sandbox;
    await first.b.close();
    const warm = await launch(l, prof);
    await warm.b.close();
    let port: { ms?: number; error?: string } = {};
    try {
      const p = await launch(l, join(profiles, `${artifact}-port`), "port");
      port = { ms: p.ms };
      await p.b.close();
    } catch (e) {
      port = { error: errorText(e) };
    }
    out.start = { coldPipeMs: first.ms, warmPipeMs: warm.ms, portMs: port.ms, portError: port.error, pipe: "works" };
    log(`${artifact}: ${version.product}, cold start ${first.ms} ms, warm ${warm.ms} ms over the pipe; sandbox ${l.sandbox}`);
  } catch (e) {
    errors.push(`start: ${errorText(e)}`);
    return out;
  }

  const b = (await launch(l, join(profiles, `${artifact}-main`))).b;
  try {
    // --- background tabs: are timers, rAF and media throttled? ------------------------------------------------------
    if (want("tabs")) {
      try {
        const t1 = await probeTab(b, server, "scenario=probe&media=1&sse=0&tab=c1");
        const t2 = await probeTab(b, server, "scenario=probe&media=1&sse=0&tab=c2");
        for (const t of [t1, t2]) await t.eval("window.__s7.setup({ media: true })", 15_000);
        await sleep(2000);
        for (const t of [t1, t2]) await t.eval("window.__s7.resetGaps()");
        const a = [await t1.eval<Snap>("window.__s7.snapshot()"), await t2.eval<Snap>("window.__s7.snapshot()")];
        await sleep(5000);
        const z = [await t1.eval<Snap>("window.__s7.snapshot()"), await t2.eval<Snap>("window.__s7.snapshot()")];
        out.tabs = [0, 1].map((i) => {
          const s0 = a[i]!, s1 = z[i]!;
          const secs = (s1.now - s0.now) / 1000;
          return {
            tab: i === 0 ? "first (created first)" : "second (created last)",
            visibility: s1.visibility,
            layout: `${s1.innerWidth}x${s1.innerHeight}`,
            intervalHz: rate(s0.interval.n, s0.now, s1.interval.n, s1.now),
            chainHz: rate(s0.chain.n, s0.now, s1.chain.n, s1.now),
            rafHz: rate(s0.raf.n, s0.now, s1.raf.n, s1.now),
            maxRafGapMs: s1.raf.maxGap,
            mediaPlayedPerSec: s0.media && s1.media ? (s1.media.played - s0.media.played) / secs : undefined,
            decodedFps: s0.media && s1.media ? (s1.media.decodedFrames - s0.media.decodedFrames) / secs : undefined,
            audioState: s1.media?.audioState,
          };
        });
        log(`${artifact}: tabs ${JSON.stringify(rounded(out.tabs, 1))}`);

        // --- a resize (a person watching at another size) without a reload ----------------------------------------
        const before = await t1.eval<Snap>("window.__s7.snapshot()");
        let r0 = Date.now();
        await t1.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
        const resized = await waitFor(async () => { const s = await t1.eval<Snap>("window.__s7.snapshot()"); return s.innerWidth === 1000 ? s : undefined; }, 5000, 20);
        const toViewMs = Date.now() - r0;
        r0 = Date.now();
        await t1.send("Emulation.clearDeviceMetricsOverride");
        const back = await waitFor(async () => { const s = await t1.eval<Snap>("window.__s7.snapshot()"); return s.innerWidth === 1280 ? s : undefined; }, 5000, 20);
        out.resize = { toViewMs, backMs: Date.now() - r0, sameDocument: resized?.token === before.token && back?.token === before.token, layouts: [before.innerWidth, resized?.innerWidth, back?.innerWidth] };
        await t1.close();
        await t2.close();
      } catch (e) {
        errors.push(`tabs: ${errorText(e)}`);
      }
    }

    // --- screenshots ---------------------------------------------------------------------------------------------
    if (want("screenshots")) {
      try {
        const t = await probeTab(b, server, "scenario=anim&sse=0&tab=c3");
        await sleep(1000);
        const width = (await t.eval<Snap>("window.__s7.snapshot()")).innerWidth;
        const shots: Record<string, unknown> = {};
        for (const format of ["png", "jpeg"]) {
          const ms: number[] = [], stale: number[] = [], sizes: number[] = [];
          const c0 = await sampleTree(b.proc.pid!);
          for (let i = 0; i < 8; i++) {
            const at = Date.now();
            const r = await t.send<{ data: string }>("Page.captureScreenshot", format === "png" ? { format } : { format, quality: 80 });
            ms.push(Date.now() - at);
            const buf = Buffer.from(r.data, "base64");
            sizes.push(buf.length);
            if (format === "jpeg") { const s = decodeJpeg(buf, width, at); if (s !== undefined) stale.push(s); }
            await sleep(100);
          }
          const c1 = await sampleTree(b.proc.pid!);
          shots[format] = { ms: summarize(ms), staleMs: summarize(stale), bytes: summarize(sizes), cpuMsPerShot: ((treeCpuPct(c0, c1) / 100) * ((c1.at - c0.at) / 1000) * 1000) / 8 };
        }
        out.screenshots = shots;
        log(`${artifact}: screenshots ${JSON.stringify(rounded(shots, 0))}`);

        // --- screencast ------------------------------------------------------------------------------------------
        let frames = 0, bytes = 0;
        const lat: number[] = [], arrivals: number[] = [];
        const off = b.on((e) => {
          if (e.sessionId !== t.sessionId || e.method !== "Page.screencastFrame") return;
          const at = Date.now();
          void t.send("Page.screencastFrameAck", { sessionId: e.params.sessionId }).catch(() => undefined);
          const buf = Buffer.from(String(e.params.data), "base64");
          frames++;
          bytes += buf.length;
          arrivals.push(at);
          const meta = e.params.metadata as { deviceWidth?: number } | undefined;
          const s = decodeJpeg(buf, meta?.deviceWidth ?? width, at);
          if (s !== undefined) lat.push(s);
        });
        await t.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
        await sleep(1500);
        frames = 0; bytes = 0; lat.length = 0; arrivals.length = 0;
        const c0 = await sampleTree(b.proc.pid!);
        await sleep(8000);
        const c1 = await sampleTree(b.proc.pid!);
        await t.send("Page.stopScreencast");
        off();
        const gaps = arrivals.slice(1).map((x, i) => x - arrivals[i]!);
        out.screencast = { framesPerSec: frames / 8, kbitPerSec: (bytes * 8) / 8 / 1000, avgFrameBytes: frames > 0 ? bytes / frames : 0, latencyMs: summarize(lat), interFrameMs: summarize(gaps), browserCpuPct: treeCpuPct(c0, c1), note: "latency is measured after a JavaScript JPEG decode in the daemon (~10–30 ms of it)" };
        log(`${artifact}: screencast ${JSON.stringify(rounded(out.screencast, 1))}`);
        await t.close();
      } catch (e) {
        errors.push(`screenshots: ${errorText(e)}`);
      }
    }
  } finally {
    await b.close();
  }

  // --- per-bot profiles: two bots, two browsers, two profiles ------------------------------------------------------
  if (want("profiles")) {
    let alpha: Browser | undefined, beta: Browser | undefined;
    try {
      const pa = join(profiles, "bot-alpha"), pb = join(profiles, "bot-beta");
      alpha = (await launch(l, pa)).b;
      beta = (await launch(l, pb)).b;
      const read = async (br: Browser): Promise<{ cookie: string; local: string | null }> => {
        const p = await Page.open(br, `${server.origin}/cookie/read`);
        const text = await p.eval<string>("document.getElementById('r').textContent");
        const local = await p.eval<string | null>("localStorage.getItem('s7bot')");
        await p.close();
        return { cookie: (JSON.parse(text) as { cookie: string }).cookie, local };
      };
      const set = async (br: Browser, bot: string): Promise<void> => { const p = await Page.open(br, `${server.origin}/cookie/set?bot=${bot}`); await sleep(300); await p.close(); };
      await set(alpha, "alpha");
      await set(beta, "beta");
      const aRead = await read(alpha), bRead = await read(beta);
      await alpha.close();
      alpha = (await launch(l, pa)).b;
      const aAgain = await read(alpha);
      out.profiles = {
        alphaSees: aRead, betaSees: bRead, alphaAfterRestart: aAgain,
        isolated: aRead.cookie.includes("s7bot=alpha") && !aRead.cookie.includes("beta") && bRead.cookie.includes("s7bot=beta") && !bRead.cookie.includes("alpha"),
        persisted: aAgain.cookie.includes("s7bot=alpha") && aAgain.local === "alpha",
        note: "--password-store=basic / --use-mock-keychain: cookies on disk are not encrypted with an OS key here",
      };
      log(`${artifact}: profiles ${JSON.stringify(out.profiles)}`);
    } catch (e) {
      errors.push(`profiles: ${errorText(e)}`);
    } finally {
      await alpha?.close();
      await beta?.close();
    }
  }

  // --- cost: a browser, its tabs, a second bot's browser, browser contexts ------------------------------------------
  if (want("cost")) {
    let main: Browser | undefined, second: Browser | undefined;
    const pages: Page[] = [];
    try {
      main = (await launch(l, join(profiles, `${artifact}-cost`))).b;
      const step = async (n: number): Promise<Record<string, number | string>> => {
        await sleep(3000);
        const s0 = await sampleTree(main!.proc.pid!);
        await sleep(4000);
        const s1 = await sampleTree(main!.proc.pid!);
        return { tabs: n, memMiB: s1.best / 1048576, memKind: s1.bestKind, rssMiB: s1.rss / 1048576, procs: s1.procs.length, cpuPct: treeCpuPct(s0, s1) };
      };
      const steps: Array<Record<string, number | string>> = [await step(0)];
      for (const target of [1, 2, 4, 8]) {
        while (pages.length < target) pages.push(await probeTab(main, server, `scenario=static&sse=0&tab=k${pages.length}`));
        steps.push(await step(target));
        log(`${artifact}: cost ${target} tabs: ${JSON.stringify(rounded(steps[steps.length - 1], 1))}`);
      }
      const s0 = steps[0]!, s8 = steps[steps.length - 1]!;
      const perTabMiB = (Number(s8.memMiB) - Number(s0.memMiB)) / 8;
      for (const p of pages.splice(0)) await p.close();
      // browser contexts (in-memory, like Electron's non-persist partitions): 4 tabs in 4 contexts
      const ctxBase = await step(0);
      for (let i = 0; i < 4; i++) {
        const { browserContextId } = await main.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: false });
        pages.push(await probeTab(main, server, `scenario=static&sse=0&tab=x${i}`, browserContextId));
      }
      const ctx4 = await step(4);
      for (const p of pages.splice(0)) await p.close();
      // an animated tab
      const anim = await probeTab(main, server, "scenario=anim&sse=0&tab=an");
      const animStep = await step(1);
      await anim.close();
      // a second bot = a second browser with its own profile: its base cost
      const before = await sampleTree(main.proc.pid!);
      second = (await launch(l, join(profiles, `${artifact}-cost-2`))).b;
      await sleep(3000);
      const secondTree = await sampleTree(second.proc.pid!);
      out.cost = {
        steps, perIdleTabMiB: perTabMiB, browserBaseMiB: Number(s0.memMiB),
        fourContextsMiB: Number(ctx4.memMiB) - Number(ctxBase.memMiB), animatedTabCpuPct: Number(animStep.cpuPct) - Number(ctxBase.cpuPct),
        secondBrowserBaseMiB: secondTree.best / 1048576, secondBrowserProcs: secondTree.procs.length, firstBrowserMiBAtThatMoment: before.best / 1048576,
      };
      log(`${artifact}: cost ${JSON.stringify(rounded(out.cost, 1))}`);
    } catch (e) {
      errors.push(`cost: ${errorText(e)}`);
    } finally {
      for (const p of pages) await p.close().catch(() => undefined);
      await main?.close();
      await second?.close();
    }
  }
  return out;
}

async function main(): Promise<void> {
  const server = await startServer({ pagesDir: join(ROOT, "out", "pages"), fixturesDir: join(ROOT, "fixtures") });
  const results: Record<string, unknown> = {};
  for (const a of artifacts) {
    log(`artifact ${a}`);
    results[a] = await forArtifact(a, server);
    write(results, "running");
  }
  write(results, "done");
  await server.close();
  if (!keepHome) rmSync(home, { recursive: true, force: true });
  log("done");
}

function write(results: Record<string, unknown>, status: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  const meta = { status, platform: process.platform, arch: process.arch, osRelease: release(), cpus: cpus().length, memGiB: Math.round(totalmem() / 1073741824), bun: Bun.version, seconds: (Date.now() - started) / 1000 };
  writeFileSync(outFile, JSON.stringify(rounded({ meta, results }, 2), null, 2));
}

await main();
process.exit(0);
