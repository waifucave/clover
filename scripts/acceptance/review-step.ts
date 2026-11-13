// The Review control on a plugin's OK card (checklist row 3.33; the owner's ruling, 2026-11-13). The card's own page (the app's
// fallback window) shows a Review button and, once pressed, the report as TEXT under a heading that says it is a model's
// reading: advice, never an answer. The run's fake provider answers the review prompt (fake-anthropic.ts REVIEW_MARK, naming
// the plugin it was given). The row presses the button with a real pointer click (the page ignores a script's), and checks:
// the note names the model the files go to (before and after), the report shows with its heading, the card is unchanged and
// still waiting, and the card is then denied (the plugin never installs).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail, sleep, until, type ExampleCtx } from "./example-steps";

export const REVIEW_STEP = "Review on a plugin's OK card: pressed on the card's own page, the report (the fake model's reading of this plugin's files) shows as text under a heading that says it is a model's reading, the note names the model, and the card is unchanged and still waiting";

const FIXTURE_DIR = resolve(import.meta.dir, "fixtures", "acceptance-page");
const PLUGIN_ID = "acceptance-page";
const REPORT_MARK = `ACCEPTANCE-REVIEW ${PLUGIN_ID}`;
// The card page's own words (apps/desktop/src/main/sealed-pages.ts REVIEW_*), kept here so the harness reads them as a user does.
const HEAD_TEXT = "A model's reading of the plugin's files";
const NOTE_BEFORE = "Review sends this plugin's files to a model.";

/** What the card page shows of its Review, as read from its DOM. */
export interface ReviewView { state: string | null; note: string; headHidden: boolean; head: string; report: string; buttonDisabled: boolean }

/** Why a finished Review view is wrong, or undefined. `model` is the tag the core says the files go to. Exported for the unit test. */
export function reviewProblem(v: ReviewView, model: string): string | undefined {
  if (v.state !== "done") return `the card page's review is "${v.state}", not done`;
  if (v.headHidden || v.head.trim() !== HEAD_TEXT) return `the report's heading reads "${v.head.trim()}"${v.headHidden ? " (hidden)" : ""}, not "${HEAD_TEXT}"`;
  if (!v.report.includes(REPORT_MARK)) return `the report doesn't carry the fake model's reading of ${PLUGIN_ID}: "${v.report.slice(0, 120)}"`;
  if (!v.report.includes("model's reading")) return "the report ends without Clover's own line that it is a model's reading";
  if (model === "" || !v.note.includes(model)) return `the note doesn't name the model ${model || "(none)"}: "${v.note.slice(0, 160)}"`;
  if (v.note.startsWith(NOTE_BEFORE)) return "the note still reads as before the model was known";
  return undefined;
}

export async function reviewStep(ctx: ExampleCtx, _session: string): Promise<string> {
  const { cdp, rpc } = ctx;
  let cardId: string | undefined;
  let installed = false;
  let roleSet = false;
  let settingsBefore: string | undefined;
  try {
    const r = await rpc.request<{ id: string; card?: string }>("plugin.install", { source: { from: "folder", path: FIXTURE_DIR } }, 60_000);
    if (r.id !== PLUGIN_ID) fail(`${PLUGIN_ID} installed as ${r.id}`);
    installed = true;
    const card = await until(`${PLUGIN_ID}'s OK card`, 30_000, async () => {
      const all = (await rpc.request<{ cards: { id: string; kind: string; pluginId?: string; hash: string }[] }>("card.list", {})).cards;
      return all.find((c) => c.kind === "plugin-ok" && c.pluginId === PLUGIN_ID);
    });
    cardId = card.id;
    // Clover's own jobs run on the run's key (Anthropic, the fake) only with a model chosen for the role: it won't pick one
    // on that provider by itself ("Settings > Roles"). The reviewer role is set to the model Alpha runs, as a user would.
    const tag = (await rpc.request<{ bots: { id: string; model?: string }[] }>("bot.list", {})).bots.find((x) => x.id === "alpha")?.model;
    if (tag === undefined || !tag.startsWith("anthropic/")) fail(`Alpha runs ${tag ?? "no model"}, not an Anthropic one the run's key can drive`);
    // The home's settings.json (the daemon reads a change live): `reviewer.model`, merged into what the run already wrote there.
    const file = join(ctx.home, "settings.json");
    settingsBefore = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const now = settingsBefore === undefined ? {} : (JSON.parse(settingsBefore) as Record<string, unknown>);
    writeFileSync(file, `${JSON.stringify({ ...now, provider: { ...(typeof now.provider === "object" && now.provider !== null ? now.provider : {}), model: tag }, reviewer: { ...(typeof now.reviewer === "object" && now.reviewer !== null ? now.reviewer : {}), model: tag } }, null, 2)}\n`, { mode: 0o600 });
    roleSet = true;
    await until("the daemon to take the reviewer role", 30_000, async () => {
      const v = await rpc.request<{ state: string; model?: string }>("plugin.review", { card: card.id, peek: true });
      return v.state !== "unavailable" ? v : undefined;
    }, async () => `plugin.review (peek) stayed unavailable after the reviewer role was set in settings.json: ${readFileSync(file, "utf8").replace(/\s+/g, " ").slice(0, 600)}`);
    // The card's own page: the fallback window the app draws when no part shows the card.
    const url = `clover-sealed://card/${encodeURIComponent(card.id)}/own`;
    const page = await until("the card's own page", 45_000, async () => (await cdp.documents()).find((d) => d.url.startsWith(url)));
    const s = page.session;
    const read = async (): Promise<ReviewView> => JSON.parse(String(await cdp.evaluate(s, `JSON.stringify((() => {
      const sec = document.querySelector('.review');
      const h = document.querySelector('.review-head');
      const b = document.querySelector('.review-button');
      return { state: sec ? sec.dataset.review ?? null : null, note: (document.querySelector('.review-note') || {}).textContent || '', headHidden: h ? h.hidden : true, head: h ? h.textContent || '' : '', report: (document.querySelector('.review-report') || {}).textContent || '', buttonDisabled: b ? b.disabled : true };
    })())`))) as ReviewView;
    const before = await until("the Review control on the card's page", 20_000, async () => { const v = await read(); return v.state === null ? undefined : v; });
    // Before the click the note already names the model the files would go to (a peek starts nothing).
    const named = await until("the note naming the model", 20_000, async () => { const v = await read(); return v.note.startsWith(NOTE_BEFORE) ? undefined : v; }).catch(() => before);
    if (named.report !== "") fail("the report shows before the Review was pressed");

    // The card's window is small: the button is scrolled into view before it is pressed (a press outside the viewport reaches nothing).
    const place = async () => {
      await cdp.evaluate(s, "document.querySelector('.review-button')?.scrollIntoView({ block: 'center' })").catch(() => undefined);
      await sleep(200);
      return until("the Review button's place", 10_000, async () => {
        const c = await cdp.centerOf(s, ".review-button");
        const inView = c !== undefined && c.x >= 0 && c.y >= 0 && (await cdp.evaluate(s, `${c.x} <= innerWidth && ${c.y} <= innerHeight`)) === true;
        return inView ? c : undefined;
      });
    };
    await cdp.evaluate(s, "window.__c = []; for (const t of ['pointerdown','mousedown','mouseup','click']) document.addEventListener(t, (e) => window.__c.push(t + ':' + e.isTrusted + ':' + (e.target.className || e.target.tagName)), true)");
    for (let attempt = 0; attempt < 3; attempt++) {
      const btn = await place();
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: btn.x, y: btn.y, button: "none", buttons: 0 }, s);
      await sleep(300);
      await cdp.click(s, btn.x, btn.y);
      // A pressed button is disabled at once and the report shows "Reviewing…".
      const started = await until("the press to start a review", 4_000, async () => { const v = await read(); return v.buttonDisabled || v.state !== "idle" ? v : undefined; }).catch(() => undefined);
      if (started !== undefined) break;
      if (attempt === 2) { const probe = await cdp.evaluate(s, "JSON.stringify({ review: typeof (window.cloverSealed || {}).review, scripts: document.scripts.length, url: location.pathname, seen: window.__c, at: (() => { const e = document.elementFromPoint(53, 300); return e ? e.tagName + '.' + e.className : null; })(), btn: JSON.stringify(document.querySelector('.review-button')?.getBoundingClientRect()), ready: document.body.dataset.ready, vis: document.visibilityState, focus: document.hasFocus() })").catch((e: Error) => e.message); const said = cdp.console.filter((c) => c.session === s).map((c) => `${c.level}: ${c.text}`).slice(-6).join(' | '); fail(`probe ${String(probe)}; console: ${said}; pressing the Review button at (${Math.round(btn.x)},${Math.round(btn.y)}) started nothing (viewport ${String(await cdp.evaluate(s, "innerWidth + 'x' + innerHeight"))}; ${JSON.stringify(await read())})`); }
    }
    const done = await until("the report on the card's page", 120_000, async () => { const v = await read(); return v.state === "done" || v.state === "failed" || v.state === "unavailable" ? v : undefined; },
      async () => JSON.stringify(await read().catch(() => null)));
    // Which model the core says the files went to, to hold the page's note to.
    const view = await rpc.request<{ state: string; model?: string }>("plugin.review", { card: card.id }).catch((e: Error) => fail(`${e.message}; the card page's review view was ${JSON.stringify(done)}`));
    const bad = reviewProblem(done, view.model ?? "");
    if (bad !== undefined) fail(bad);
    // Advice only: the card is the same one and still waits.
    const after = (await rpc.request<{ card: { hash: string } }>("card.get", { id: card.id })).card;
    if (after.hash !== card.hash) fail("the Review changed the card");
    const still = (await rpc.request<{ cards: { id: string }[] }>("card.list", {})).cards.some((c) => c.id === card.id);
    if (!still) fail("the Review answered the card");
    return `pressed on the card's own page, the report "${done.report.slice(0, 60).replace(/\s+/g, " ")}…" showed under "${HEAD_TEXT}", the note named ${view.model}, and the card stayed the same and waiting`;
  } finally {
    if (roleSet) { const file = join(ctx.home, "settings.json"); try { if (settingsBefore === undefined) rmSync(file, { force: true }); else writeFileSync(file, settingsBefore, { mode: 0o600 }); } catch { /* best effort */ } }
    if (cardId !== undefined) await ctx.denyCard(cardId).catch(() => undefined);
    if (installed) {
      const rm = await rpc.request<{ card?: string }>("plugin.remove", { id: PLUGIN_ID }).catch(() => undefined);
      if (rm?.card !== undefined) await ctx.approveCard(rm.card).catch(() => undefined);
    }
  }
}
