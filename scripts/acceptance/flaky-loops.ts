// The two rows that fail about one run in five (the Settings window's Bots section; a third-party plugin's sealed card
// page) as loops: the same press or the same install over and over in one app, so a run of them gives the cause and,
// after a fix, the proof. --only-flaky settings|cards [--loops N] [--gaps 0,50,200] (run.ts).
//
//  settings: install acceptance-ui (OK card pressed, running), remove it (the registry changes: "N plugin(s) with UI"),
//            wait the gap, press the gear at once, and expect the Settings page's Bots section within 10 s.
//  cards:    install acceptance-cards-a (approvals, a bot) into the shell already served, raise its card at once (a turn
//            calling its tool), and expect A's page to place the card, its sealed frames to take room and the approve
//            page to be ready to answer; the card is then answered over RPC.
//
// Each iteration reads what it saw (frames, the sealed frames' own state marks, the app's log lines since it began), and
// the run says how many of N went red, with the first red one's readings.
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { clickTree, fail, leave, SIDEBAR_ITEMS, sleep, treeDocs, until, type ExampleCtx } from "./example-steps";

const FIXTURES = resolve(import.meta.dir, "fixtures");

type Card = { id: string; kind: string; change?: string; session?: string; pluginId?: string };

const frameDump = async (ctx: ExampleCtx): Promise<string> => {
  const out: string[] = [];
  for (const d of await ctx.cdp.documents()) {
    const seen = await ctx.cdp.evaluate(d.session, `JSON.stringify({ sealed: [...document.querySelectorAll('iframe[data-clover-sealed]')].map((f) => { const r = f.getBoundingClientRect(); return [f.dataset.cloverSealed, Math.round(r.width), Math.round(r.height), f.dataset.cloverSealedState ?? ''].join(' '); }), buttons: [...document.querySelectorAll('button')].length, text: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 60) })`).catch(() => "gone");
    out.push(`${d.url.replace(/mount=[0-9a-f]+/, "mount=…").slice(0, 70)} ${String(seen).slice(0, 300)}`);
  }
  return out.join(" || ");
};

/** The app's own lines (the log is two files joined, the app's output then the home's app.log) added since `before` lines. */
const since = (ctx: ExampleCtx, before: number): string => ctx.appLog().split("\n").slice(before).filter((l) => /layers:|card:|sealed:|frame|electron: Failed|probe:/.test(l)).slice(-40).join("\n");
const lineCount = (ctx: ExampleCtx): number => ctx.appLog().split("\n").length;

export interface LoopOpts { loops: number; gaps: number[] }

export async function flakyLoop(kind: "settings" | "cards", ctx: ExampleCtx, opts: LoopOpts): Promise<string> {
  const reds: string[] = [];
  const times: number[] = [];
  for (let i = 0; i < opts.loops; i++) {
    const gap = opts.gaps[i % opts.gaps.length]!;
    const before = lineCount(ctx);
    const began = Date.now();
    try {
      if (kind === "settings") await settingsOnce(ctx, gap);
      else await cardsOnce(ctx);
      times.push(Date.now() - began);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // Said at once and whole (the table cell cuts it): a red iteration's readings are what the diagnosis is made of.
      console.error(`flaky ${kind} #${i + 1} (gap ${gap} ms) red: ${why}\n  seen: ${await frameDump(ctx).catch(() => "?")}\n  log:\n${since(ctx, before)}`);
      reds.push(`#${i + 1}${kind === "settings" ? ` (gap ${gap} ms)` : ""}: ${why.slice(0, 600)}\n    seen: ${await frameDump(ctx).catch(() => "?")}\n    log:\n${since(ctx, before).split("\n").map((l) => `      ${l.slice(0, 220)}`).join("\n")}`);
    }
    // Whatever the iteration left is let go, so the next begins as the first did.
    await leaveAll(ctx);
  }
  const summary = `${kind}: ${opts.loops - reds.length}/${opts.loops} green${kind === "settings" ? ` (gaps ${opts.gaps.join("/")} ms)` : ""}; green iterations took ${times.length === 0 ? "-" : `${Math.round(times.reduce((a, b) => a + b, 0) / times.length)} ms`} on average`;
  if (reds.length > 0) fail(`${summary}\n${reds.slice(0, 3).join("\n")}`);
  return summary;
}

async function leaveAll(ctx: ExampleCtx): Promise<void> {
  for (const id of ["acceptance-ui", "acceptance-cards-a"]) await leave(ctx, id).catch(() => undefined);
  for (const d of await treeDocs(ctx.cdp)) for (const type of ["keyDown", "keyUp"]) await ctx.cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, d.session).catch(() => undefined);
  await sleep(300);
}

async function installFolder(ctx: ExampleCtx, id: string): Promise<void> {
  const installed = await ctx.rpc.request<{ id: string; state: string }>("plugin.install", { source: { from: "folder", path: join(FIXTURES, id) } }, 60_000);
  if (installed.id !== id) fail(`the fixture installed as ${installed.id}`);
  await ctx.pressCard(`${id}'s OK card`, (c) => c.kind === "plugin-ok" && c.pluginId === id);
  await until(`${id} running`, 30_000, async () => (((await ctx.rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state) === "running" ? true : undefined));
}

async function settingsOnce(ctx: ExampleCtx, gap: number): Promise<void> {
  const { cdp } = ctx;
  await installFolder(ctx, "acceptance-ui");
  // The window has drawn with the plugin in the registry; now it goes (the registry changes), and the gear is pressed after the gap.
  await sleep(600);
  await leave(ctx, "acceptance-ui");
  if (gap > 0) await sleep(gap);
  await clickTree(cdp, "the Settings button", "button[aria-label=Settings]", undefined, 10_000);
  await until("the Settings page's Bots section", 10_000, async () => {
    for (const d of await treeDocs(cdp)) if (await cdp.centerOf(d.session, "button.cl-settings__section", "Bots").catch(() => undefined) !== undefined) return true;
    return undefined;
  }, () => frameDump(ctx));
}

async function cardsOnce(ctx: ExampleCtx): Promise<void> {
  const { cdp, rpc } = ctx;
  const A = "acceptance-cards-a";
  const docsOf = async () => (await cdp.documents()).filter((d) => d.url.startsWith(`clover-plugin://${A}/`));
  await installFolder(ctx, A);
  const bot = await until("A's bot in bot.list", 60_000, async () => (await rpc.request<{ bots: { id: string; mainSession?: string }[] }>("bot.list", {})).bots.find((b) => b.id === `${A}/bot` && b.mainSession !== undefined));
  const session = bot.mainSession!;
  // At once: the card is raised while the window is still taking the new layer in (no wait for its page).
  const first = await rpc.request<{ seq: number }>("session.send", { id: session, message: { text: "ACCEPTANCE-CALL ask_card {}", clientMessageId: randomUUID() } }, 30_000);
  await clickTree(cdp, "A's sidebar entry", SIDEBAR_ITEMS, "Acceptance cards A", 20_000);
  let tool: Card | undefined;
  const settled = new Set<string>();
  await until("the tool card for A's bot's session", 90_000, async () => {
    for (const c of (await rpc.request<{ cards: Card[] }>("card.list")).cards) {
      if (c.session !== session) continue;
      if (c.kind === "tool") { tool = c; return true; }
      if (!settled.has(c.id)) { settled.add(c.id); await ctx.pressCard(`A's bot's ${c.kind} card`, (x) => x.id === c.id); }
    }
    return undefined;
  });
  // A's page has the card placed, and both sealed frames take room (the page told its frame a size) and are ready to answer.
  await until("A's page, its sealed frames sized", 15_000, async () => {
    for (const d of await docsOf()) {
      const sized = await cdp.evaluate(d.session, `(() => { const f = [...document.querySelectorAll('iframe[data-clover-sealed]')]; return f.length >= 2 && f.every((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); })()`).catch(() => false);
      if (sized === true) return true;
    }
    return undefined;
  }, () => frameDump(ctx));
  await until("the approve page ready to answer", 10_000, async () => {
    const approve = (await cdp.documents()).find((d) => d.url.startsWith(`clover-sealed://card/${encodeURIComponent(tool!.id)}/`) && /approve/.test(decodeURIComponent(d.url)));
    if (approve === undefined) return undefined;
    return (await cdp.evaluate(approve.session, "document.body.dataset.ready ?? 'none'").catch(() => "gone")) === "yes" ? true : undefined;
  }, () => frameDump(ctx));
  await ctx.approveCard(tool!.id);
  await until("the turn to finish", 60_000, async () => {
    const ev = (await rpc.request<{ events: { type?: string; seq?: number }[] }>("session.history", { id: session, limit: 200 }).catch(() => ({ events: [] }))).events;
    return ev.some((e) => e.type === "turn_completed" && typeof e.seq === "number" && e.seq > first.seq) ? true : undefined;
  });
}
