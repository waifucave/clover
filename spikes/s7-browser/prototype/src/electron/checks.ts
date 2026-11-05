// Questions 1 and 2 (and 3, when the same checks run under Wayland): moving tabs between hidden and shown, hidden
// tabs' throttling, pictures of hidden tabs, and what tabs cost.
import { cpuBetween, memTotals, sample } from "./metrics.ts";
import { AGENT_W, SHOWN_W, TabHost, type CaptureResult, type Place, type Snapshot, type Tab } from "./tabs.ts";
import { errorText, rate, sleep, summarize, waitFor } from "../shared/stats.ts";
import type { SpikeServer } from "../shared/server.ts";

type Log = (line: string) => void;

const PROBE = "/pages/probe.html?scenario=probe";

// --- rates between two snapshots -------------------------------------------------------------------------------------

export interface Rates {
  seconds: number;
  intervalHz: number;
  chainHz: number;
  rafHz: number;
  maxIntervalGapMs: number;
  maxChainGapMs: number;
  maxRafGapMs: number;
  visibility: string;
  mediaPlayedPerSec?: number;
  decodedFps?: number;
  paused?: boolean;
  audioState?: string;
  audioTimePerSec?: number;
}

export function rates(a: Snapshot, b: Snapshot): Rates {
  const r: Rates = {
    seconds: (b.now - a.now) / 1000,
    intervalHz: rate(a.interval.n, a.now, b.interval.n, b.now),
    chainHz: rate(a.chain.n, a.now, b.chain.n, b.now),
    rafHz: rate(a.raf.n, a.now, b.raf.n, b.now),
    maxIntervalGapMs: b.interval.maxGap,
    maxChainGapMs: b.chain.maxGap,
    maxRafGapMs: b.raf.maxGap,
    visibility: b.visibility,
  };
  if (a.media !== null && b.media !== null) {
    r.mediaPlayedPerSec = (b.media.played - a.media.played) / r.seconds;
    r.decodedFps = (b.media.decodedFrames - a.media.decodedFrames) / r.seconds;
    r.paused = b.media.paused;
    r.audioState = b.media.audioState;
    r.audioTimePerSec = (b.media.audioTime - a.media.audioTime) / r.seconds;
  }
  return r;
}

// --- Q1: hidden <-> shown without a reload --------------------------------------------------------------------------

export interface MoveCycle {
  toShown: { resizeMs?: number; visibleMs?: number; firstRafMs?: number; freshPictureMs?: number; pictureWidth?: number };
  toHidden: { resizeMs?: number; hiddenMs?: number };
  shownRates?: Rates;
  hiddenRates?: Rates;
}

export interface MoveResult {
  place: string;
  ok: boolean;
  reloaded: boolean;
  checks: Record<string, boolean | string | number>;
  cycles: MoveCycle[];
  timing: Record<string, ReturnType<typeof summarize>>;
  layout: { hidden: string; shown: string };
  initialRates?: Rates;
  error?: string;
}

async function waitLayout(host: TabHost, tab: Tab, width: number, ms: number): Promise<Snapshot | undefined> {
  return waitFor(async () => {
    const s = await host.snapshot(tab);
    return s.innerWidth === width ? s : undefined;
  }, ms, 20);
}

export async function moveCheck(host: TabHost, server: SpikeServer, place: "detached" | "hiddenWindow", log: Log, cycles = 5): Promise<MoveResult> {
  const result: MoveResult = { place, ok: false, reloaded: false, checks: {}, cycles: [], timing: {}, layout: { hidden: "", shown: "" } };
  let tab: Tab | undefined;
  try {
    tab = await host.create({ place, partition: "persist:bot-move", throttling: false, path: `${PROBE}&media=1` });
    const setup = await host.exec<{ media: string; scrollY: number }>(tab, `window.__s7.setup({ field: "typed before moving", scroll: 1234, media: true })`, 10_000);
    result.checks.mediaStart = setup.media;
    await sleep(1500);
    const s0 = await host.snapshot(tab);
    await host.exec(tab, "window.__s7.resetGaps()");
    await sleep(2000);
    const s0b = await host.snapshot(tab);
    result.initialRates = rates(s0, s0b);
    result.layout.hidden = `${s0.innerWidth}x${s0.innerHeight}@${s0.dpr}`;
    const loadsAfterSetup = tab.loads;
    const navsAfterSetup = tab.navigations;
    const snaps: Snapshot[] = [s0, s0b];
    for (let i = 0; i < cycles; i++) {
      const c: MoveCycle = { toShown: {}, toHidden: {} };
      // to shown
      const t0 = Date.now();
      host.show(tab);
      const shownSnap = await waitLayout(host, tab, SHOWN_W, 5000);
      if (shownSnap !== undefined) {
        const tr = shownSnap.events.find((e) => e.t >= t0 && e.kind === "resize");
        if (tr !== undefined) c.toShown.resizeMs = tr.t - t0;
        result.layout.shown = `${shownSnap.innerWidth}x${shownSnap.innerHeight}@${shownSnap.dpr}`;
      }
      const vis = await waitFor(async () => { const v = await host.exec<number>(tab!, `window.__s7.eventAfter(${t0}, "visibility", "visible")`); return v > 0 ? v : undefined; }, 1500, 25);
      if (vis !== undefined) c.toShown.visibleMs = vis - t0;
      const raf = await waitFor(async () => { const v = await host.exec<number>(tab!, `window.__s7.rafAfter(${t0})`); return v > 0 ? v : undefined; }, 3000, 25);
      if (raf !== undefined) c.toShown.firstRafMs = raf - t0;
      // the first picture drawn after the move, at the shown size
      const pic = await waitFor(async () => {
        const r = await host.capture(tab!, "capturePage", SHOWN_W, 2000);
        // drawn after the move began, and at least the shown width (device pixels)
        return r.ok && r.staleMs !== undefined && r.askedAt - r.staleMs >= t0 && r.width >= SHOWN_W ? r : undefined;
      }, 4000, 30);
      if (pic !== undefined) { c.toShown.freshPictureMs = Date.now() - t0; c.toShown.pictureWidth = pic.width; }
      await host.exec(tab, "window.__s7.resetGaps()");
      const sa = await host.snapshot(tab);
      await sleep(1500);
      const sb = await host.snapshot(tab);
      c.shownRates = rates(sa, sb);
      snaps.push(sa, sb);
      // back to hidden
      const t1 = Date.now();
      host.hide(tab, place);
      const hiddenSnap = await waitLayout(host, tab, AGENT_W, 5000);
      if (hiddenSnap !== undefined) {
        const tr = hiddenSnap.events.find((e) => e.t >= t1 && e.kind === "resize");
        if (tr !== undefined) c.toHidden.resizeMs = tr.t - t1;
      }
      const hid = await waitFor(async () => { const v = await host.exec<number>(tab!, `window.__s7.eventAfter(${t1}, "visibility", "hidden")`); return v > 0 ? v : undefined; }, 800, 25);
      if (hid !== undefined) c.toHidden.hiddenMs = hid - t1;
      await host.exec(tab, "window.__s7.resetGaps()");
      const ha = await host.snapshot(tab);
      await sleep(2000);
      const hb = await host.snapshot(tab);
      c.hiddenRates = rates(ha, hb);
      snaps.push(ha, hb);
      result.cycles.push(c);
      log(`  move ${place} cycle ${i + 1}: shown resize ${c.toShown.resizeMs ?? "-"} ms, first rAF ${c.toShown.firstRafMs ?? "-"} ms, fresh picture ${c.toShown.freshPictureMs ?? "-"} ms; hidden resize ${c.toHidden.resizeMs ?? "-"} ms`);
    }
    const last = snaps[snaps.length - 1]!;
    const first = snaps[0]!;
    result.reloaded = snaps.some((s) => s.token !== first.token) || tab.loads !== loadsAfterSetup || tab.navigations !== navsAfterSetup;
    result.checks.sameDocument = !result.reloaded;
    result.checks.navigationsDuringMoves = tab.navigations - navsAfterSetup;
    result.checks.loadsDuringMoves = tab.loads - loadsAfterSetup;
    result.checks.fieldKept = snaps.every((s) => s.field === "typed before moving");
    result.checks.sessionStorageKept = snaps.every((s) => s.session === "typed before moving");
    result.checks.scrollKept = snaps.every((s) => s.scrollY === 1234);
    result.checks.scrollSeen = snaps.map((s) => s.scrollY).filter((v, i, a) => a.indexOf(v) === i).join(",");
    result.checks.sseOpensPage = last.sse.opens;
    result.checks.sseOpensServer = server.sseOpens(tab.id);
    result.checks.sseErrors = last.sse.errors;
    result.checks.sseGaps = last.sse.gaps;
    result.checks.sseKept = last.sse.opens === 1 && server.sseOpens(tab.id) === 1;
    if (first.media !== null && last.media !== null) {
      const wall = (last.now - first.now) / 1000;
      result.checks.mediaPlayedPerSec = Number(((last.media.played - first.media.played) / wall).toFixed(3));
      result.checks.mediaPausedAtEnd = last.media.paused;
      result.checks.mediaPauseEvents = last.media.pauses;
      result.checks.mediaDecodedFps = Number(((last.media.decodedFrames - first.media.decodedFrames) / wall).toFixed(2));
      result.checks.audioState = last.media.audioState;
      result.checks.mediaKept = !last.media.paused && (last.media.played - first.media.played) / wall > 0.9;
    }
    result.checks.processGone = tab.gone.join(",") || "none";
    const pick = (f: (c: MoveCycle) => number | undefined) => summarize(result.cycles.map(f).filter((v): v is number => v !== undefined));
    result.timing = {
      showResizeMs: pick((c) => c.toShown.resizeMs),
      showFirstRafMs: pick((c) => c.toShown.firstRafMs),
      showVisibleEventMs: pick((c) => c.toShown.visibleMs),
      showFreshPictureMs: pick((c) => c.toShown.freshPictureMs),
      hideResizeMs: pick((c) => c.toHidden.resizeMs),
      hideHiddenEventMs: pick((c) => c.toHidden.hiddenMs),
    };
    result.ok = !result.reloaded && result.checks.fieldKept === true && result.checks.sseKept === true;
  } catch (e) {
    result.error = errorText(e);
  } finally {
    if (tab !== undefined) await host.close(tab);
  }
  return result;
}

// --- Q2a: throttling of hidden tabs -----------------------------------------------------------------------------------

export interface ThrottleRow {
  config: string;
  place: Place;
  throttling: boolean;
  rates?: Rates;
  rendererCpuPct?: number;
  layout?: string;
  error?: string;
}

async function measureTab(host: TabHost, tab: Tab, seconds: number): Promise<{ rates: Rates; cpu: number; layout: string }> {
  await host.exec(tab, "window.__s7.resetGaps()");
  const a = await host.snapshot(tab);
  const ma = sample();
  await sleep(seconds * 1000);
  const b = await host.snapshot(tab);
  const mb = sample();
  const cpu = cpuBetween(ma, mb).byPid[String(tab.wc.getOSProcessId())] ?? Number.NaN;
  return { rates: rates(a, b), cpu, layout: `${b.innerWidth}x${b.innerHeight}` };
}

export async function throttleCheck(host: TabHost, log: Log): Promise<ThrottleRow[]> {
  const rows: ThrottleRow[] = [];
  const configs: Array<{ config: string; place: Place; throttling: boolean }> = [
    { config: "shown (reference)", place: "shown", throttling: true },
    { config: "detached, throttling on (default)", place: "detached", throttling: true },
    { config: "detached, throttling off", place: "detached", throttling: false },
    { config: "own hidden window, throttling on (default)", place: "ownHiddenWindow", throttling: true },
    { config: "own hidden window, throttling off", place: "ownHiddenWindow", throttling: false },
    { config: "osr, throttling on (default)", place: "osr", throttling: true },
    { config: "osr, throttling off", place: "osr", throttling: false },
  ];
  for (const c of configs) {
    let tab: Tab | undefined;
    const row: ThrottleRow = { ...c };
    try {
      tab = await host.create({ place: c.place, partition: `bot-throttle-${rows.length}`, throttling: c.throttling, path: `${PROBE}&media=1&sse=0` });
      await host.exec(tab, `window.__s7.setup({ media: true })`, 10_000);
      await sleep(2000);
      const m = await measureTab(host, tab, 5);
      row.rates = m.rates;
      row.rendererCpuPct = m.cpu;
      row.layout = m.layout;
      log(`  throttle ${c.config}: interval ${m.rates.intervalHz.toFixed(1)} Hz, rAF ${m.rates.rafHz.toFixed(1)} Hz, media x${(m.rates.mediaPlayedPerSec ?? 0).toFixed(2)}, ${m.rates.visibility}, cpu ${m.cpu.toFixed(1)}%`);
    } catch (e) {
      row.error = errorText(e);
      log(`  throttle ${c.config}: ERROR ${row.error}`);
    } finally {
      if (tab !== undefined) await host.close(tab);
    }
    rows.push(row);
  }

  // Two tabs in ONE hidden window, one with throttling off: is the switch per tab, or per window?
  {
    let a: Tab | undefined, b: Tab | undefined;
    try {
      a = await host.create({ place: "hiddenWindow", partition: "bot-shared-a", throttling: false, path: `${PROBE}&sse=0` });
      b = await host.create({ place: "hiddenWindow", partition: "bot-shared-b", throttling: true, path: `${PROBE}&sse=0` });
      await sleep(2000);
      await host.exec(a, "window.__s7.resetGaps()");
      await host.exec(b, "window.__s7.resetGaps()");
      const [a0, b0] = [await host.snapshot(a), await host.snapshot(b)];
      await sleep(5000);
      const [a1, b1] = [await host.snapshot(a), await host.snapshot(b)];
      rows.push({ config: "shared hidden window: tab A, throttling off", place: "hiddenWindow", throttling: false, rates: rates(a0, a1) });
      rows.push({ config: "shared hidden window: tab B, throttling on", place: "hiddenWindow", throttling: true, rates: rates(b0, b1) });
      log(`  throttle shared window: A interval ${rates(a0, a1).intervalHz.toFixed(1)} Hz rAF ${rates(a0, a1).rafHz.toFixed(1)}; B interval ${rates(b0, b1).intervalHz.toFixed(1)} Hz rAF ${rates(b0, b1).rafHz.toFixed(1)}`);
    } catch (e) {
      rows.push({ config: "shared hidden window", place: "hiddenWindow", throttling: false, error: errorText(e) });
    } finally {
      if (a !== undefined) await host.close(a);
      if (b !== undefined) await host.close(b);
    }
  }

  // Turning throttling off at runtime, per tab (webContents.setBackgroundThrottling).
  {
    let t: Tab | undefined;
    try {
      t = await host.create({ place: "ownHiddenWindow", partition: "bot-toggle", throttling: true, path: `${PROBE}&sse=0` });
      await sleep(2000);
      const before = await measureTab(host, t, 4);
      t.wc.setBackgroundThrottling(false);
      await sleep(500);
      const after = await measureTab(host, t, 4);
      rows.push({ config: "own hidden window, on then setBackgroundThrottling(false): before", place: "ownHiddenWindow", throttling: true, rates: before.rates, rendererCpuPct: before.cpu });
      rows.push({ config: "own hidden window, on then setBackgroundThrottling(false): after", place: "ownHiddenWindow", throttling: false, rates: after.rates, rendererCpuPct: after.cpu });
      log(`  throttle runtime toggle: before ${before.rates.intervalHz.toFixed(1)} Hz/${before.rates.rafHz.toFixed(1)} rAF, after ${after.rates.intervalHz.toFixed(1)} Hz/${after.rates.rafHz.toFixed(1)} rAF`);
    } catch (e) {
      rows.push({ config: "runtime toggle", place: "ownHiddenWindow", throttling: true, error: errorText(e) });
    } finally {
      if (t !== undefined) await host.close(t);
    }
  }
  return rows;
}

// --- Q2b: pictures of hidden tabs -------------------------------------------------------------------------------------

export interface CaptureRow {
  place: Place;
  throttling: boolean;
  method: string;
  tries: number;
  ok: number;
  decoded: number;
  ms: ReturnType<typeof summarize>;
  staleMs: ReturnType<typeof summarize>;
  size: string;
  errors: string[];
  /** visibilitychange events the page saw during the captures. */
  visibilityEvents: string[];
  /** All the app's CPU, ms per picture (main, GPU and renderer together). */
  cpuMsPerPicture?: number;
  /** beginFrameSubscription / paint: frames per second delivered while hidden. */
  framesPerSec?: number;
}

export async function captureCheck(host: TabHost, log: Log): Promise<CaptureRow[]> {
  const rows: CaptureRow[] = [];
  const places: Array<{ place: Place; throttling: boolean }> = [
    { place: "shown", throttling: true },
    { place: "detached", throttling: false },
    { place: "hiddenWindow", throttling: false },
    { place: "ownHiddenWindow", throttling: true },
    { place: "osr", throttling: false },
  ];
  for (const p of places) {
    let tab: Tab | undefined;
    try {
      tab = await host.create({ place: p.place, partition: `bot-capture-${rows.length}`, throttling: p.throttling, path: "/pages/probe.html?scenario=anim&sse=0" });
      await sleep(1500);
      const snap = await host.snapshot(tab);
      const methods = p.place === "osr" ? ["osrPaint", "capturePage", "cdpJpeg"] : ["capturePageHidden", "capturePage", "cdpPng", "cdpJpeg"];
      for (const method of methods) {
        const tries = 8;
        const results: CaptureResult[] = [];
        const t0 = Date.now();
        const m0 = sample();
        for (let i = 0; i < tries; i++) {
          results.push(await host.capture(tab, method, snap.innerWidth, 5000));
          await sleep(100);
        }
        const m1 = sample();
        const spent = cpuBetween(m0, m1);
        const after = await host.snapshot(tab);
        const vis = after.events.filter((e) => e.t >= t0 && e.kind === "visibility").map((e) => `${e.t - t0}:${e.detail}`);
        const good = results.filter((r) => r.ok);
        const row: CaptureRow = {
          place: p.place,
          throttling: p.throttling,
          method,
          tries,
          ok: good.length,
          decoded: results.filter((r) => r.staleMs !== undefined).length,
          ms: summarize(good.map((r) => r.ms)),
          staleMs: summarize(results.map((r) => r.staleMs ?? Number.NaN)),
          size: good.length > 0 ? `${good[0]!.width}x${good[0]!.height}` : "-",
          errors: [...new Set(results.map((r) => r.error).filter((e): e is string => e !== undefined))],
          visibilityEvents: vis,
          // includes the page's own animation over the burst (the same for every method in this place)
          cpuMsPerPicture: ((spent.total / 100) * spent.seconds * 1000) / tries,
        };
        rows.push(row);
        log(`  capture ${p.place}/${method}: ${row.ok}/${tries} ok, ${row.decoded} decoded, p50 ${row.ms.p50} ms, stale p50 ${row.staleMs.p50} ms, ${row.size}${row.errors.length ? ` errors: ${row.errors.join("; ")}` : ""}`);
      }
      // frames delivered while in this place: beginFrameSubscription (not OSR) or paint events (OSR)
      if (p.place === "osr") {
        const n0 = tab.paints;
        await sleep(2000);
        rows.push({ place: p.place, throttling: p.throttling, method: "paint events", tries: 0, ok: 0, decoded: 0, ms: summarize([]), staleMs: summarize([]), size: "-", errors: [], visibilityEvents: [], framesPerSec: (tab.paints - n0) / 2 });
      } else {
        let frames = 0;
        tab.wc.beginFrameSubscription(false, () => { frames++; });
        await sleep(2000);
        tab.wc.endFrameSubscription();
        rows.push({ place: p.place, throttling: p.throttling, method: "beginFrameSubscription", tries: 0, ok: 0, decoded: 0, ms: summarize([]), staleMs: summarize([]), size: "-", errors: [], visibilityEvents: [], framesPerSec: frames / 2 });
        log(`  capture ${p.place}/beginFrameSubscription: ${(frames / 2).toFixed(1)} frames/s`);
      }
    } catch (e) {
      rows.push({ place: p.place, throttling: p.throttling, method: "setup", tries: 0, ok: 0, decoded: 0, ms: summarize([]), staleMs: summarize([]), size: "-", errors: [errorText(e)], visibilityEvents: [] });
      log(`  capture ${p.place}: ERROR ${errorText(e)}`);
    } finally {
      if (tab !== undefined) await host.close(tab);
    }
  }
  return rows;
}

// --- Q2c: what tabs cost ----------------------------------------------------------------------------------------------

export interface CostStep {
  tabs: number;
  memBest: number;
  memKind: string;
  memRss: number;
  cpuPct: number;
  cpuByType: Record<string, number>;
  procs: number;
}

export interface CostResult {
  idle: CostStep[];
  perIdleTabMiB?: number;
  perIdleTabCpuPct?: number;
  animated: Array<{ config: string; cpuPct: number; rendererPct: number; gpuPct: number }>;
  partitions: { samePartitionMiB?: number; ownPartitionsMiB?: number };
  error?: string;
}

async function costStep(tabs: number, settleMs = 3000, windowMs = 4000): Promise<CostStep> {
  await sleep(settleMs);
  const mem = memTotals(sample(true));
  const a = sample();
  await sleep(windowMs);
  const b = sample();
  const cpu = cpuBetween(a, b);
  return { tabs, memBest: mem.best, memKind: mem.bestKind, memRss: mem.rss, cpuPct: cpu.total, cpuByType: cpu.byType, procs: mem.procs };
}

export async function costCheck(host: TabHost, log: Log): Promise<CostResult> {
  const result: CostResult = { idle: [], animated: [], partitions: {} };
  const tabs: Tab[] = [];
  try {
    host.host(); // the hidden host window exists before the baseline
    result.idle.push(await costStep(0));
    for (const target of [1, 2, 4, 8]) {
      while (tabs.length < target) {
        tabs.push(await host.create({ place: "hiddenWindow", partition: `bot-cost-${tabs.length}`, throttling: false, path: "/pages/probe.html?scenario=static&sse=0" }));
      }
      const step = await costStep(target);
      result.idle.push(step);
      log(`  cost ${target} idle hidden tabs: ${(step.memBest / 1048576).toFixed(0)} MiB (${step.memKind}), cpu ${step.cpuPct.toFixed(1)}%, ${step.procs} processes`);
    }
    const first = result.idle[0]!, last = result.idle[result.idle.length - 1]!;
    result.perIdleTabMiB = (last.memBest - first.memBest) / last.tabs / 1048576;
    result.perIdleTabCpuPct = (last.cpuPct - first.cpuPct) / last.tabs;
    for (const t of tabs.splice(0)) await host.close(t);

    // same partition vs own partitions, 4 tabs each
    const base = await costStep(0, 3000, 1000);
    for (let i = 0; i < 4; i++) tabs.push(await host.create({ place: "hiddenWindow", partition: "bot-cost-shared", throttling: false, path: "/pages/probe.html?scenario=static&sse=0" }));
    const same = await costStep(4, 3000, 1000);
    for (const t of tabs.splice(0)) await host.close(t);
    const base2 = await costStep(0, 3000, 1000);
    for (let i = 0; i < 4; i++) tabs.push(await host.create({ place: "hiddenWindow", partition: `bot-cost-own-${i}`, throttling: false, path: "/pages/probe.html?scenario=static&sse=0" }));
    const own = await costStep(4, 3000, 1000);
    for (const t of tabs.splice(0)) await host.close(t);
    result.partitions = { samePartitionMiB: (same.memBest - base.memBest) / 1048576, ownPartitionsMiB: (own.memBest - base2.memBest) / 1048576 };
    log(`  cost 4 tabs: one partition +${result.partitions.samePartitionMiB?.toFixed(0)} MiB, own partitions +${result.partitions.ownPartitionsMiB?.toFixed(0)} MiB`);

    // an animated hidden tab, throttled or not, against a shown one
    for (const c of [
      { config: "animated, shown", place: "shown" as Place, throttling: true },
      { config: "animated, hidden window, throttling off", place: "ownHiddenWindow" as Place, throttling: false },
      { config: "animated, hidden window, throttling on", place: "ownHiddenWindow" as Place, throttling: true },
      { config: "animated, osr 30 fps, throttling off", place: "osr" as Place, throttling: false },
    ]) {
      const t = await host.create({ place: c.place, partition: "bot-cost-anim", throttling: c.throttling, path: "/pages/probe.html?scenario=anim&sse=0" });
      await sleep(2000);
      const a = sample();
      await sleep(4000);
      const b = sample();
      const cpu = cpuBetween(a, b);
      const rendererPct = cpu.byPid[String(t.wc.getOSProcessId())] ?? Number.NaN;
      result.animated.push({ config: c.config, cpuPct: cpu.total, rendererPct, gpuPct: cpu.byType.GPU ?? 0 });
      log(`  cost ${c.config}: all ${cpu.total.toFixed(1)}%, renderer ${rendererPct.toFixed(1)}%, gpu ${(cpu.byType.GPU ?? 0).toFixed(1)}%`);
      await host.close(t);
    }
  } catch (e) {
    result.error = errorText(e);
    log(`  cost: ERROR ${result.error}`);
  } finally {
    for (const t of tabs) await host.close(t);
  }
  return result;
}

// --- the long run: does a hidden tab stay unthrottled past Chrome's five-minute intensive throttling? ----------------

export interface LongRow { config: string; at: string; rates?: Rates; error?: string }

export async function longCheck(host: TabHost, log: Log, minutes = 6.5): Promise<LongRow[]> {
  const rows: LongRow[] = [];
  const configs: Array<{ config: string; place: Place; throttling: boolean }> = [
    { config: "own hidden window, throttling on", place: "ownHiddenWindow", throttling: true },
    { config: "own hidden window, throttling off", place: "ownHiddenWindow", throttling: false },
    { config: "detached, throttling off", place: "detached", throttling: false },
  ];
  const tabs: Array<{ c: (typeof configs)[number]; t: Tab }> = [];
  try {
    for (const c of configs) tabs.push({ c, t: await host.create({ place: c.place, partition: `bot-long-${tabs.length}`, throttling: c.throttling, path: `${PROBE}&sse=0` }) });
    const start = Date.now();
    const marks = [0.5, 5, minutes]; // the last window is wholly past Chrome's five minutes
    let prev = new Map<Tab, Snapshot>();
    for (const { t } of tabs) { await host.exec(t, "window.__s7.resetGaps()"); prev.set(t, await host.snapshot(t)); }
    for (const m of marks) {
      while (Date.now() - start < m * 60_000) {
        await sleep(Math.min(30_000, m * 60_000 - (Date.now() - start)));
        log(`  long: ${((Date.now() - start) / 60_000).toFixed(1)} min`);
      }
      const next = new Map<Tab, Snapshot>();
      for (const { c, t } of tabs) {
        try {
          const s = await host.snapshot(t);
          rows.push({ config: c.config, at: `${m} min`, rates: rates(prev.get(t)!, s) });
          next.set(t, s);
          await host.exec(t, "window.__s7.resetGaps()");
        } catch (e) {
          rows.push({ config: c.config, at: `${m} min`, error: errorText(e) });
        }
      }
      prev = next;
    }
  } finally {
    for (const { t } of tabs) await host.close(t);
  }
  return rows;
}
