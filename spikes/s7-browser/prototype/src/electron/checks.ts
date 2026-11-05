// Questions 1 and 2 (and 3, when the same checks run under Wayland): moving tabs between hidden and shown, hidden
// tabs' throttling, pictures of hidden tabs, and what tabs cost.
import { cpuBetween, memTotals, sample } from "./metrics.ts";
import { AGENT_W, placeAvailable, SHOWN_W, TabHost, type CaptureResult, type HeadlessPlace, type Place, type Snapshot, type Tab } from "./tabs.ts";
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
  layout: string;
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
    layout: `${b.innerWidth}x${b.innerHeight}`,
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
  toShown: { resizeMs?: number; visibleMs?: number; firstRafMs?: number; freshPictureMs?: number; pictureWidth?: number; layout?: string };
  toHidden: { resizeMs?: number; hiddenMs?: number; layoutAfter?: string; fitMs?: number; layoutFitted?: string };
  shownRates?: Rates;
  hiddenRates?: Rates;
}

export interface MoveResult {
  place: string;
  fit: boolean;
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

/**
 * Move one tab hidden → shown → hidden `cycles` times. With `fit`, a hidden tab is held at the agent's 1280x800 by a
 * device-metrics override (cleared while it is shown), since a hidden view does not follow its bounds.
 */
export async function moveCheck(host: TabHost, server: SpikeServer, place: HeadlessPlace, log: Log, opts: { cycles?: number; fit?: boolean } = {}): Promise<MoveResult> {
  const cycles = opts.cycles ?? 4;
  const fit = opts.fit === true;
  const result: MoveResult = { place, fit, ok: false, reloaded: false, checks: {}, cycles: [], timing: {}, layout: { hidden: "", shown: "" } };
  let tab: Tab | undefined;
  try {
    tab = await host.create({ place, partition: "persist:bot-move", throttling: false, path: `${PROBE}&media=1` });
    const setup = await host.exec<{ media: string; scrollY: number }>(tab, `window.__s7.setup({ field: "typed before moving", scroll: 1234, media: true })`, 10_000);
    result.checks.mediaStart = setup.media;
    if (fit) await host.fit(tab);
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
      if (fit) await host.unfit(tab);
      // the first picture drawn after the move at the shown size, polled from the moment of the move
      const pic = await waitFor(async () => {
        const r = await host.capture(tab!, "capturePage", SHOWN_W, 2000);
        return r.ok && r.staleMs !== undefined && r.askedAt - r.staleMs >= t0 && r.width >= SHOWN_W ? r : undefined;
      }, 4000, 10);
      if (pic !== undefined) { c.toShown.freshPictureMs = Date.now() - t0; c.toShown.pictureWidth = pic.width; }
      const shownSnap = await waitLayout(host, tab, SHOWN_W, 5000);
      const nowSnap = shownSnap ?? (await host.snapshot(tab));
      c.toShown.layout = `${nowSnap.innerWidth}x${nowSnap.innerHeight}`;
      const tr = nowSnap.events.find((e) => e.t >= t0 && e.kind === "resize");
      if (tr !== undefined) c.toShown.resizeMs = tr.t - t0;
      result.layout.shown = `${nowSnap.innerWidth}x${nowSnap.innerHeight}@${nowSnap.dpr}`;
      const raf = await waitFor(async () => { const v = await host.exec<number>(tab!, `window.__s7.rafAfter(${t0})`); return v > 0 ? v : undefined; }, 3000, 25);
      if (raf !== undefined) c.toShown.firstRafMs = raf - t0;
      const vis = await host.exec<number>(tab, `window.__s7.eventAfter(${t0}, "visibility", "visible")`);
      if (vis > 0) c.toShown.visibleMs = vis - t0;
      await host.exec(tab, "window.__s7.resetGaps()");
      const sa = await host.snapshot(tab);
      await sleep(1500);
      const sb = await host.snapshot(tab);
      c.shownRates = rates(sa, sb);
      snaps.push(sa, sb);
      // back to hidden: does the page come back to the agent's 1280x800 by itself?
      const t1 = Date.now();
      host.hide(tab);
      const back = await waitLayout(host, tab, AGENT_W, 1500);
      const after = back ?? (await host.snapshot(tab));
      c.toHidden.layoutAfter = `${after.innerWidth}x${after.innerHeight}`;
      const trh = after.events.find((e) => e.t >= t1 && e.kind === "resize");
      if (back !== undefined && trh !== undefined) c.toHidden.resizeMs = trh.t - t1;
      if (fit) {
        const tf = Date.now();
        await host.fit(tab);
        const fitted = await waitLayout(host, tab, AGENT_W, 3000);
        if (fitted !== undefined) c.toHidden.fitMs = Date.now() - tf;
        c.toHidden.layoutFitted = fitted === undefined ? "not fitted in 3 s" : `${fitted.innerWidth}x${fitted.innerHeight}`;
      }
      const hid = await host.exec<number>(tab, `window.__s7.eventAfter(${t1}, "visibility", "hidden")`);
      if (hid > 0) c.toHidden.hiddenMs = hid - t1;
      await host.exec(tab, "window.__s7.resetGaps()");
      const ha = await host.snapshot(tab);
      await sleep(2000);
      const hb = await host.snapshot(tab);
      c.hiddenRates = rates(ha, hb);
      snaps.push(ha, hb);
      result.cycles.push(c);
      log(`  move ${place}${fit ? " (fit)" : ""} cycle ${i + 1}: fresh picture ${c.toShown.freshPictureMs ?? "-"} ms, first rAF ${c.toShown.firstRafMs ?? "-"} ms, shown ${c.toShown.layout}; hidden again ${c.toHidden.layoutAfter}${fit ? `, fitted ${c.toHidden.layoutFitted} in ${c.toHidden.fitMs ?? "-"} ms` : ""}; hidden rAF ${c.hiddenRates.rafHz.toFixed(1)} Hz`);
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
    result.checks.layoutBackToAgentSize = result.cycles.every((c) => c.toHidden.layoutAfter === `${AGENT_W}x800`);
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
      hideFitMs: pick((c) => c.toHidden.fitMs),
      hideHiddenEventMs: pick((c) => c.toHidden.hiddenMs),
    };
    result.ok = !result.reloaded && result.checks.fieldKept === true && result.checks.sseKept === true;
  } catch (e) {
    result.error = errorText(e);
    log(`  move ${place}: ERROR ${result.error}`);
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
  media: boolean;
  rates?: Rates;
  rendererCpuPct?: number;
  allCpuPct?: number;
  pumpFps?: number;
  error?: string;
}

async function measureTab(host: TabHost, tab: Tab, seconds: number): Promise<{ rates: Rates; cpu: number; all: number; pumpFps?: number }> {
  await host.exec(tab, "window.__s7.resetGaps()");
  const a = await host.snapshot(tab);
  const p0 = tab.pumpFrames;
  const ma = sample();
  await sleep(seconds * 1000);
  const b = await host.snapshot(tab);
  const mb = sample();
  const cpu = cpuBetween(ma, mb);
  return { rates: rates(a, b), cpu: cpu.byPid[String(tab.wc.getOSProcessId())] ?? Number.NaN, all: cpu.total, pumpFps: tab.pumping ? (tab.pumpFrames - p0) / seconds : undefined };
}

interface ThrottleConfig { config: string; place: Place; throttling: boolean; media?: boolean; pump?: boolean; toggle?: boolean }

export async function throttleCheck(host: TabHost, log: Log): Promise<ThrottleRow[]> {
  const rows: ThrottleRow[] = [];
  const configs: ThrottleConfig[] = [
    { config: "shown (reference)", place: "shown", throttling: true },
    { config: "detached, throttling on (default)", place: "detached", throttling: true },
    { config: "detached, throttling off", place: "detached", throttling: false },
    { config: "never-shown window, throttling on (default)", place: "ownHiddenWindow", throttling: true },
    { config: "never-shown window, throttling off", place: "ownHiddenWindow", throttling: false },
    { config: "never-shown window, on, then setBackgroundThrottling(false)", place: "ownHiddenWindow", throttling: true, toggle: true },
    { config: "never-shown window, throttling off + frame pump", place: "ownHiddenWindow", throttling: false, pump: true },
    { config: "detached, throttling off + frame pump", place: "detached", throttling: false, pump: true },
    { config: "invisible shown window, throttling off", place: "invisibleWindow", throttling: false },
    { config: "1x1 shown window, throttling off", place: "tinyWindow", throttling: false },
    { config: "osr window 30 fps, throttling off", place: "osr", throttling: false },
    { config: "osr view (no window) 30 fps, throttling off", place: "osrView", throttling: false },
    // a page playing sound is exempt from Chrome's background throttling whatever the setting: measured apart
    { config: "never-shown window, throttling on, playing media", place: "ownHiddenWindow", throttling: true, media: true },
    { config: "never-shown window, throttling off, playing media", place: "ownHiddenWindow", throttling: false, media: true },
    { config: "detached, throttling off, playing media", place: "detached", throttling: false, media: true },
  ];
  for (const c of configs) {
    const row: ThrottleRow = { config: c.config, place: c.place, throttling: c.throttling && c.toggle !== true, media: c.media === true };
    if (!placeAvailable(c.place)) { row.error = "not possible here"; rows.push(row); continue; }
    let tab: Tab | undefined;
    try {
      tab = await host.create({ place: c.place, partition: `bot-throttle-${rows.length}`, throttling: c.throttling, path: `${PROBE}&sse=0${c.media ? "&media=1" : ""}` });
      if (c.media) await host.exec(tab, `window.__s7.setup({ media: true })`, 10_000);
      if (c.toggle) { await sleep(1500); tab.wc.setBackgroundThrottling(false); }
      if (c.pump) host.startPump(tab);
      await sleep(2000);
      const m = await measureTab(host, tab, 5);
      row.rates = m.rates;
      row.rendererCpuPct = m.cpu;
      row.allCpuPct = m.all;
      row.pumpFps = m.pumpFps;
      log(`  throttle ${c.config}: interval ${m.rates.intervalHz.toFixed(1)} Hz, chain ${m.rates.chainHz.toFixed(1)} Hz, rAF ${m.rates.rafHz.toFixed(1)} Hz, ${m.rates.visibility}${c.media ? `, media x${(m.rates.mediaPlayedPerSec ?? 0).toFixed(2)} ${(m.rates.decodedFps ?? 0).toFixed(0)} fps` : ""}${m.pumpFps !== undefined ? `, pump ${m.pumpFps.toFixed(0)} fps` : ""}, renderer ${m.cpu.toFixed(1)}%`);
    } catch (e) {
      row.error = errorText(e);
      log(`  throttle ${c.config}: ERROR ${row.error}`);
    } finally {
      if (tab !== undefined) await host.close(tab);
    }
    rows.push(row);
  }

  // Two tabs in ONE never-shown window, one with throttling off: is the switch per tab, or per window?
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
      rows.push({ config: "one never-shown window: tab A, throttling off", place: "hiddenWindow", throttling: false, media: false, rates: rates(a0, a1) });
      rows.push({ config: "one never-shown window: tab B, throttling on", place: "hiddenWindow", throttling: true, media: false, rates: rates(b0, b1) });
    } catch (e) {
      rows.push({ config: "one never-shown window", place: "hiddenWindow", throttling: false, media: false, error: errorText(e) });
    } finally {
      if (a !== undefined) await host.close(a);
      if (b !== undefined) await host.close(b);
    }
  }
  return rows;
}

// --- Q2b: pictures of hidden tabs -------------------------------------------------------------------------------------

export interface CaptureRow {
  place: Place;
  throttling: boolean;
  pump: boolean;
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
  /** All the app's CPU, ms per picture (main, GPU and renderer together; the page's own animation included). */
  cpuMsPerPicture?: number;
  /** beginFrameSubscription / paint: frames per second delivered while there. */
  framesPerSec?: number;
}

const empty = summarize([]);

export async function captureCheck(host: TabHost, log: Log): Promise<CaptureRow[]> {
  const rows: CaptureRow[] = [];
  const places: Array<{ place: Place; throttling: boolean; pump?: boolean }> = [
    { place: "shown", throttling: true },
    { place: "detached", throttling: false },
    { place: "hiddenWindow", throttling: false },
    { place: "hiddenWindow", throttling: false, pump: true },
    { place: "invisibleWindow", throttling: false },
    { place: "tinyWindow", throttling: false },
    { place: "osr", throttling: false },
    { place: "osrView", throttling: false },
  ];
  for (const p of places) {
    const label = { place: p.place, throttling: p.throttling, pump: p.pump === true };
    if (!placeAvailable(p.place)) { rows.push({ ...label, method: "-", tries: 0, ok: 0, decoded: 0, ms: empty, staleMs: empty, size: "-", errors: ["not possible here"], visibilityEvents: [] }); continue; }
    let tab: Tab | undefined;
    try {
      tab = await host.create({ place: p.place, partition: `bot-capture-${rows.length}`, throttling: p.throttling, path: "/pages/probe.html?scenario=anim&sse=0" });
      if (p.pump) host.startPump(tab);
      await sleep(1500);
      const snap = await host.snapshot(tab);
      const osr = p.place === "osr" || p.place === "osrView";
      const methods = osr ? ["osrPaint", "capturePage", "cdpJpeg"] : ["capturePageHidden", "capturePage", "cdpJpeg", "frameSub", ...(p.place === "shown" ? ["cdpPng"] : [])];
      for (const method of methods) {
        const tries = 6;
        const results: CaptureResult[] = [];
        const t0 = Date.now();
        const m0 = sample();
        let timeouts = 0;
        for (let i = 0; i < tries; i++) {
          const r = await host.capture(tab, method, snap.innerWidth, 5000);
          results.push(r);
          if (r.error?.includes("timed out")) timeouts++;
          if (timeouts >= 2) break; // two timeouts: it isn't going to work here
          await sleep(100);
        }
        const m1 = sample();
        const spent = cpuBetween(m0, m1);
        const after = await host.snapshot(tab);
        const vis = after.events.filter((e) => e.t >= t0 && e.kind === "visibility").map((e) => `${e.t - t0}:${e.detail}`);
        const good = results.filter((r) => r.ok);
        const row: CaptureRow = {
          ...label,
          method,
          tries: results.length,
          ok: good.length,
          decoded: results.filter((r) => r.staleMs !== undefined).length,
          ms: summarize(good.map((r) => r.ms)),
          staleMs: summarize(results.map((r) => r.staleMs ?? Number.NaN)),
          size: good.length > 0 ? `${good[0]!.width}x${good[0]!.height}` : "-",
          errors: [...new Set(results.map((r) => r.error).filter((e): e is string => e !== undefined))],
          visibilityEvents: vis,
          cpuMsPerPicture: ((spent.total / 100) * spent.seconds * 1000) / results.length,
        };
        rows.push(row);
        log(`  capture ${p.place}${p.pump ? "+pump" : ""}/${method}: ${row.ok}/${row.tries} ok, ${row.decoded} decoded, p50 ${row.ms.p50} ms, stale p50 ${row.staleMs.p50} ms, ${row.size}${row.errors.length ? ` errors: ${row.errors.join("; ")}` : ""}`);
      }
      // frames delivered while in this place: a frame subscription (views) or paint events (OSR)
      if (osr) {
        const n0 = tab.paints;
        await sleep(2000);
        rows.push({ ...label, method: "paint events", tries: 0, ok: 0, decoded: 0, ms: empty, staleMs: empty, size: "-", errors: [], visibilityEvents: [], framesPerSec: (tab.paints - n0) / 2 });
      } else {
        host.stopPump(tab);
        let frames = 0;
        tab.wc.beginFrameSubscription(false, () => { frames++; });
        await sleep(2000);
        tab.wc.endFrameSubscription();
        rows.push({ ...label, method: "beginFrameSubscription", tries: 0, ok: 0, decoded: 0, ms: empty, staleMs: empty, size: "-", errors: [], visibilityEvents: [], framesPerSec: frames / 2 });
        log(`  capture ${p.place}/beginFrameSubscription: ${(frames / 2).toFixed(1)} frames/s`);
      }
    } catch (e) {
      rows.push({ ...label, method: "setup", tries: 0, ok: 0, decoded: 0, ms: empty, staleMs: empty, size: "-", errors: [errorText(e)], visibilityEvents: [] });
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
  animated: Array<{ config: string; cpuPct: number; rendererPct: number; gpuPct: number; rafHz?: number }>;
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

    // an animated tab in each place: what keeping its frames coming costs
    const anim: Array<{ config: string; place: Place; throttling: boolean; pump?: boolean }> = [
      { config: "animated, shown", place: "shown", throttling: true },
      { config: "animated, never-shown window, throttling off", place: "ownHiddenWindow", throttling: false },
      { config: "animated, never-shown window, throttling on", place: "ownHiddenWindow", throttling: true },
      { config: "animated, never-shown window, throttling off + frame pump", place: "ownHiddenWindow", throttling: false, pump: true },
      { config: "animated, invisible shown window", place: "invisibleWindow", throttling: false },
      { config: "animated, 1x1 shown window", place: "tinyWindow", throttling: false },
      { config: "animated, osr 30 fps", place: "osr", throttling: false },
    ];
    for (const c of anim) {
      if (!placeAvailable(c.place)) continue;
      const t = await host.create({ place: c.place, partition: "bot-cost-anim", throttling: c.throttling, path: "/pages/probe.html?scenario=anim&sse=0" });
      if (c.pump) host.startPump(t);
      await sleep(2000);
      const s0 = await host.snapshot(t);
      const a = sample();
      await sleep(4000);
      const b = sample();
      const s1 = await host.snapshot(t);
      const cpu = cpuBetween(a, b);
      const rendererPct = cpu.byPid[String(t.wc.getOSProcessId())] ?? Number.NaN;
      const rafHz = rates(s0, s1).rafHz;
      result.animated.push({ config: c.config, cpuPct: cpu.total, rendererPct, gpuPct: cpu.byType.GPU ?? 0, rafHz });
      log(`  cost ${c.config}: all ${cpu.total.toFixed(1)}%, renderer ${rendererPct.toFixed(1)}%, gpu ${(cpu.byType.GPU ?? 0).toFixed(1)}%, rAF ${rafHz.toFixed(0)} Hz`);
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
    { config: "never-shown window, throttling on", place: "ownHiddenWindow", throttling: true },
    { config: "never-shown window, throttling off", place: "ownHiddenWindow", throttling: false },
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
