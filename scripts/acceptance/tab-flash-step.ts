// The tab-flash row (the owner's report on try 14d: "the old layout we had for alpha shows for a split second when i
// move from reel to alpha tab"): coming back to Alpha's tab from an app's page, the Plugins page, the Archive and the
// Settings dialog, and the window at its start, never draws her tab in the stock layout or her conversation's empty
// state while it has a transcript. The window's own document (the `clover` layer's, which holds the shell, the stock
// sidebar, her layout and the conversation) is sampled at every frame it draws, from just before the press to a while
// after: which layout shows (the stock tab's `.cl-bot-tab`, her layout's part), whether the stock sidebar shows, whether
// "This is the start of your conversation" shows and how many rows the conversation has, and each of her frames
// (`alpha#…`: still loading, drawn, asleep; shown or not). A sample is a flash when her tab shows (her layout, or the
// stock tab with no app page) and any of: the stock tab, the empty state, or one of her frames shown before it has drawn.
// The stock sidebar is no flash: it is beside her tab as on every tab (Bots doesn't offer a bot the sidebar); every press
// here is the user's own, on the window's own sidebar.
import { join, resolve } from "node:path";
import type { Cdp } from "./cdp";
import { fail, sleep, until, type ExampleCtx } from "./example-steps";
import { dumpFrames, treeDocs } from "./ui-steps";

export const TAB_FLASH_STEP = "Alpha's tab never flashes the stock layout or an empty conversation: back from an app's page, the Plugins page, the Archive, the Settings dialog, after a minute away, and at the window's start, every frame drawn shows her layout, her frames drawn and her transcript";

const FIXTURES = resolve(import.meta.dir, "fixtures");
const APP_ID = "acceptance-ui";
const APP_TITLE = "Acceptance UI";

/** One sample of the window's document. */
export interface FlashSample {
  /** ms since the press. */
  t: number;
  stockTab: boolean;
  layout: boolean;
  stockSidebar: boolean;
  empty: boolean;
  rows: number;
  appPage: boolean;
  loadingNote: boolean;
  /** Her frames: `<entry>:<loading|drawn|asleep>[:hidden]`. */
  alpha: string[];
}

/** The sampler, installed in the window's document: every frame from now for `ms`, the samples that differ from the one
 *  before (with how many frames each lasted). */
const SAMPLER = (ms: number) => `(() => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const q = (s) => document.querySelector(s);
  const sample = () => ({
    stockTab: vis(q(".cl-bot-tab")),
    layout: [...document.querySelectorAll("[data-clover-layout-part]")].some(vis),
    stockSidebar: [...document.querySelectorAll(".cl-sidebar")].some(vis),
    empty: [...document.querySelectorAll(".cl-conv__empty")].some(vis),
    rows: [...document.querySelectorAll(".cl-conv__unit")].filter(vis).length,
    appPage: [...document.querySelectorAll('[data-clover-entry^="${APP_ID}#"]')].some((e) => e.tagName === "IFRAME" && vis(e) && e.getBoundingClientRect().height > 40),
    loadingNote: [...document.querySelectorAll(".cl-shell-empty")].some(vis),
    alpha: [...document.querySelectorAll('[data-clover-entry^="alpha#"]')].map((f) => f.getAttribute("data-clover-entry") + ":" + (f.tagName !== "IFRAME" ? (f.hasAttribute("data-clover-asleep") ? "asleep" : "inline") : (f.hasAttribute("data-clover-drawn") || (f.style.height !== "" && document.querySelector("iframe[data-clover-drawn]") === null) ? "drawn" : "loading")) + (vis(f) ? "" : ":hidden")).sort(),
  });
  const t0 = performance.now();
  const out = [];
  let last = "";
  let frames = 0;
  window.__cloverFlash = { done: false, out, frames: 0 };
  const tick = () => {
    frames++;
    const s = sample();
    const key = JSON.stringify(s);
    if (key !== last) { out.push({ t: Math.round(performance.now() - t0), n: 1, ...s }); last = key; }
    else out[out.length - 1].n++;
    window.__cloverFlash.frames = frames;
    if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick); else window.__cloverFlash.done = true;
  };
  requestAnimationFrame(tick);
  return true;
})()`;

/** Whether a sample is a flash of Alpha's tab, and why. */
export function flashOf(s: FlashSample): string | undefined {
  const herTab = s.layout || (s.stockTab && !s.appPage);
  if (!herTab) return undefined;
  const why: string[] = [];
  if (s.stockTab) why.push("the stock bot tab");
  if (s.empty) why.push("the empty conversation");
  if (s.loadingNote) why.push("a loading note");
  // Her frames shown before their documents drew, or asleep; an inline part of hers (her layout, drawn by the window's own
  // document) is drawn with it.
  const undrawn = s.alpha.filter((a) => !a.endsWith(":hidden") && !a.endsWith(":drawn") && !a.endsWith(":inline"));
  if (undrawn.length > 0) why.push(`her frames not drawn (${undrawn.join(", ")})`);
  return why.length > 0 ? why.join("; ") : undefined;
}

/** A timeline, short: each change with the frames it lasted. */
function timeline(samples: (FlashSample & { n: number })[]): string {
  return samples.map((s) => `${s.t}ms×${s.n} ${[s.layout ? "layout" : "", s.stockTab ? "STOCK-TAB" : "", s.stockSidebar ? "stock-sidebar" : "", s.empty ? "EMPTY" : "", `rows=${s.rows}`, s.appPage ? "app-page" : "", s.loadingNote ? "loading" : "", s.alpha.join("|")].filter((x) => x !== "").join(" ")}`).join("\n    ");
}

async function windowDoc(cdp: Cdp): Promise<string> {
  const d = await until("the window's document (the shell)", 30_000, async () => {
    for (const x of await treeDocs(cdp)) if (x.url.startsWith("clover-plugin://clover/") && (await cdp.evaluate(x.session, "!!document.querySelector('.cl-window')").catch(() => false)) === true) return x.session;
    return undefined;
  }, () => dumpFrames(cdp));
  return d;
}

/** Opens her tab when the window shows something else (her layout not showing): presses the sidebar's Alpha row. */
async function openHerTab(cdp: Cdp): Promise<void> {
  const win = await windowDoc(cdp);
  const hers = await cdp.evaluate(win, `[...document.querySelectorAll("[data-clover-layout-part]")].some((el) => el.getClientRects().length > 0)`).catch(() => false);
  if (hers === true) return;
  const at = await until("the sidebar's Alpha row", 20_000, async () => {
    for (const d of await treeDocs(cdp)) {
      const c = await cdp.centerOf(d.session, STOCK_ROWS, "Alpha").catch(() => undefined);
      if (c !== undefined) return { session: d.session, c };
    }
    return undefined;
  }, () => dumpFrames(cdp));
  await cdp.click(at.session, at.c.x, at.c.y);
}

/** Her tab, settled: her layout, her room drawn, her transcript's rows. */
async function herTabSettled(cdp: Cdp, minRows: number): Promise<void> {
  await until("Alpha's tab drawn (her layout, her room, her transcript)", 60_000, async () => {
    const s = await windowDoc(cdp).catch(() => undefined);
    if (s === undefined) return undefined;
    const v = (await cdp.evaluate(s, `(() => { const vis = (el) => !!el && el.getClientRects().length > 0; const room = document.querySelector('iframe[data-clover-entry="alpha#room"]'); return !!document.querySelector('[data-clover-layout-part]') && vis(room) && (room.getAttribute('data-clover-drawn') !== null || room.style.height !== '') && document.querySelectorAll('.cl-conv__unit').length >= ${minRows}; })()`).catch(() => false)) as boolean;
    return v ? true : undefined;
  }, () => dumpFrames(cdp));
}

/** Presses something (in any tree document: the shell's, the window's own sidebar), sampling the window's document from just
 *  before the press for `ms`. */
async function sampled(cdp: Cdp, what: string, press: { selector: string; text?: string }, ms = 1_500): Promise<(FlashSample & { n: number })[]> {
  const win = await windowDoc(cdp);
  const at = await until(what, 20_000, async () => {
    for (const d of await treeDocs(cdp)) {
      const c = await cdp.centerOf(d.session, press.selector, press.text).catch(() => undefined);
      if (c !== undefined) return { session: d.session, c };
    }
    return undefined;
  }, () => dumpFrames(cdp));
  await cdp.evaluate(win, SAMPLER(ms));
  await cdp.click(at.session, at.c.x, at.c.y);
  await until(`${what}: the samples`, ms + 10_000, async () => ((await cdp.evaluate(win, "window.__cloverFlash && window.__cloverFlash.done").catch(() => false)) === true ? true : undefined));
  const r = (await cdp.evaluate(win, "JSON.stringify(window.__cloverFlash)")) as string;
  return (JSON.parse(r) as { out: (FlashSample & { n: number })[] }).out;
}

const STOCK_ROWS = ".cl-sidebar button, .cl-sidebar a, .cl-sidebar [role=link]";
const SETTINGS = "button[aria-label=Settings]";

/** The window at its start: the window's document sampled from the moment the shell is there until her tab has settled
 *  (at most `ms`). */
export async function launchSamples(cdp: Cdp, ms = 6_000): Promise<(FlashSample & { n: number })[]> {
  const win = await windowDoc(cdp);
  await cdp.evaluate(win, SAMPLER(ms));
  await until("the window's start: the samples", ms + 10_000, async () => ((await cdp.evaluate(win, "window.__cloverFlash && window.__cloverFlash.done").catch(() => false)) === true ? true : undefined));
  return (JSON.parse((await cdp.evaluate(win, "JSON.stringify(window.__cloverFlash)")) as string) as { out: (FlashSample & { n: number })[] }).out;
}

/** How long her frames stay out of sight before they sleep when the row runs alone: the app's seam
 *  (CLOVER_TEST_SLEEP_AFTER_MS, a test or acceptance build's), so "a minute away" is this, not the layer's minute. */
export const TAB_FLASH_SLEEP_MS = 5_000;

/** Her frames in the window's document as the sampler names them (`<entry>:<state>[:hidden]`). */
const ALPHA_FRAMES = `[...document.querySelectorAll('[data-clover-entry^="alpha#"]')].map((f) => f.getAttribute("data-clover-entry") + ":" + (f.hasAttribute("data-clover-asleep") ? "asleep" : f.tagName))`;

/** `sleepAfterMs`: the app was started with that seam (the row alone); unset, the layer's own minute. */
export async function tabFlashStep(ctx: ExampleCtx, session: string, launch?: (FlashSample & { n: number })[], sleepAfterMs?: number): Promise<string> {
  const { cdp, rpc } = ctx;
  const lines: string[] = [];
  const flashes: string[] = [];
  // A transcript of her own: two turns.
  for (const ask of ["ACCEPTANCE-REPLY: say hello", "ACCEPTANCE-REPLY: say hello again"]) {
    const t = await ctx.turn(session, ask, 120_000);
    if (t.cards.length > 0) fail(`a history turn raised ${t.cards.join("; ")}`);
  }
  // An app with a page of its own (the reel-like page): installed from its folder, its OK pressed.
  const judge = (name: string, samples: (FlashSample & { n: number })[], backToHer: boolean) => {
    const bad = backToHer ? samples.filter((s) => flashOf(s) !== undefined) : [];
    const frames = samples.reduce((a, s) => a + s.n, 0);
    lines.push(`${name}: ${frames} frames${bad.length > 0 ? `, ${bad.reduce((a, s) => a + s.n, 0)} flashed` : ""}\n    ${timeline(samples)}`);
    for (const s of bad) flashes.push(`${name} at ${s.t} ms for ${s.n} frame(s): ${flashOf(s)}`);
  };
  const installed = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: join(FIXTURES, APP_ID) } }, 60_000);
  if (installed.id !== APP_ID) fail(`the app fixture installed as ${installed.id}`);
  try {
    await ctx.pressCard("the app's OK card", (c) => c.kind === "plugin-ok" && c.pluginId === APP_ID);
    await until(`${APP_ID} running`, 30_000, async () => ((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id: APP_ID }).catch(() => undefined))?.plugin.state === "running" ? true : undefined));
    // Installing it loads the window's document again (a layer it may now frame): her tab, settled. In the full table the
    // row starts wherever the row before it left the window (the new-message composer, say), so it opens her tab itself.
    await sleep(1_500);
    await openHerTab(cdp);
    await herTabSettled(cdp, 2);

    // 0. The window's start (sampled from the moment the shell was there, before anything else ran).
    if (launch !== undefined) judge("the window's start", launch, true);

    // 1. Her tab → the app's page (the sidebar's app row), and back by the sidebar's Alpha row: the owner's path.
    judge("her tab → the app's page", await sampled(cdp, "the sidebar's app row", { selector: STOCK_ROWS, text: APP_TITLE }), false);
    await until("the app's page", 20_000, async () => ((await treeDocs(cdp)).length > 0 ? true : undefined));
    await sleep(1_000);
    judge("the app's page → her tab", await sampled(cdp, "the sidebar's Alpha row", { selector: STOCK_ROWS, text: "Alpha" }), true);
    await herTabSettled(cdp, 2);

    // 2. The Plugins page, and back.
    judge("her tab → Plugins", await sampled(cdp, "the sidebar's Plugins row", { selector: STOCK_ROWS, text: "Plugins" }), false);
    await sleep(1_000);
    judge("Plugins → her tab", await sampled(cdp, "the sidebar's Alpha row", { selector: STOCK_ROWS, text: "Alpha" }), true);
    await herTabSettled(cdp, 2);

    // 3. The Archive (from her tab, the sidebar's Archive row), and back.
    judge("her tab → Archive", await sampled(cdp, "the sidebar's Archive row", { selector: STOCK_ROWS, text: "Archive" }), false);
    await sleep(1_000);
    judge("Archive → her tab", await sampled(cdp, "the sidebar's Alpha row", { selector: STOCK_ROWS, text: "Alpha" }), true);
    await herTabSettled(cdp, 2);

    // 4. The Settings dialog over her tab, closed with Escape.
    judge("her tab → Settings", await sampled(cdp, "the sidebar's Settings button", { selector: SETTINGS }), false);
    await sleep(800);
    const win = await windowDoc(cdp);
    await cdp.evaluate(win, SAMPLER(1_500));
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, win).catch(() => undefined);
    await until("Settings closed: the samples", 12_000, async () => ((await cdp.evaluate(win, "window.__cloverFlash && window.__cloverFlash.done").catch(() => false)) === true ? true : undefined));
    judge("Settings → her tab", (JSON.parse((await cdp.evaluate(win, "JSON.stringify(window.__cloverFlash)")) as string) as { out: (FlashSample & { n: number })[] }).out, true);
    await herTabSettled(cdp, 2);

    // 5. A minute away (her frames out of sight long enough to sleep), and back. Away until they have slept: past the
    // app's sleep time (the layer's minute, or the seam's when the row runs alone), and, where any frame of hers is a
    // sleeping kind, until every such frame says so (seen in the window's document), so the way back wakes them.
    await sampled(cdp, "the sidebar's app row", { selector: STOCK_ROWS, text: APP_TITLE }, 300);
    const away = sleepAfterMs ?? 60_000;
    const left = Date.now();
    await sleep(away + 1_000);
    const win5 = await windowDoc(cdp);
    const framesNow = async () => ((await cdp.evaluate(win5, ALPHA_FRAMES).catch(() => [])) as string[]);
    // A frame of hers that sleeps is an iframe while awake and a placeholder marked asleep after; her inline parts (the
    // layout the window's own document draws) never sleep. Away until no iframe of hers is left awake.
    const slept = await until(`her frames asleep ${Math.round(away / 1000)} s away`, 20_000, async () => {
      const f = await framesNow();
      return f.every((x) => !x.endsWith(":IFRAME")) ? f : undefined;
    }, async () => `her frames: ${(await framesNow()).join(", ") || "none"}`);
    lines.push(`away ${((Date.now() - left) / 1000).toFixed(1)} s (sleep after ${Math.round(away / 1000)} s): ${slept.join(", ") || "no frames"}`);
    judge("the app's page, a minute later → her tab", await sampled(cdp, "the sidebar's Alpha row", { selector: STOCK_ROWS, text: "Alpha" }, 2_500), true);
    await herTabSettled(cdp, 2);
  } finally {
    await rpc.request("plugin.remove", { id: APP_ID }).catch(() => undefined);
  }
  const report = lines.join("\n  ");
  console.error(`[tab-flash]\n  ${report}`);
  if (flashes.length > 0) fail(`her tab flashed: ${flashes.slice(0, 6).join(" | ")}${flashes.length > 6 ? ` (+${flashes.length - 6} more)` : ""}\n  ${report}`);
  return `no frame flashed coming back to her tab (from the app's page, Plugins, the Archive, the Settings dialog, a minute away); ${lines.map((l) => l.split("\n")[0]).join("; ")}`;
}
