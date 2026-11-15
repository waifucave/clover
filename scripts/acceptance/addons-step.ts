// A plugin's add-ons of its own, its own question card, and the Plugins page's Restart (checklist 1.19, 2.3 and its
// work-list row 16, 3.26), with one fixture (scripts/acceptance/fixtures/acceptance-addons):
// 1. Installed from its folder: its OK card says it loads add-ons of its own, which Clover doesn't check; pressed, it
//    runs, and Alpha's Glossary load of it names what its add-ons are.
// 2. A stamp (an add-on) put in its data folder, as the user would: Alpha's StampRun call makes the plugin's host half ask
//    with `confirm`, a sealed card from the plugin, pressed Yes in the window: the stamp runs, and its hash is kept.
// 3. The same stamp again: no question; a changed stamp asks again, and answered No it doesn't run.
// 4. Restart on its detail in the Plugins page: its host half starts again (it counts its starts), and what the user
//    trusted survives (the same stamp runs with no question).
import { ownTurnCompleted } from "./turn-end";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { callTurn, clickTree, fail, leave, openDetail, until, type ExampleCtx } from "./example-steps";

export const ADDONS_STEP = "a plugin's add-ons of its own: its OK card says it loads add-ons Clover doesn't check and Glossary names them; a new add-on runs only after the plugin's own question card is pressed Yes in the window, again with no card, a changed one asks again and No runs nothing; Restart on its detail in the Plugins page starts its host half again and the user's yes survives; its component asks through confirmCard too, Yes pressed in the window, then No";

const FIXTURE = resolve(import.meta.dir, "fixtures", "acceptance-addons");
export const ADDONS_ID = "acceptance-addons";
const NAME = "Acceptance add-ons";

type Ev = Record<string, unknown> & { type?: string; seq?: number };
interface Card { id: string; kind: string; session?: string; pluginId?: string }

const stateOf = async (ctx: ExampleCtx, id: string) => (await ctx.rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state;
const cardsNow = async (ctx: ExampleCtx) => (await ctx.rpc.request<{ cards: Card[] }>("card.list")).cards;

/** One StampRun call by Alpha: its tool card approved over RPC (the tool's own, not under test), the plugin's question
 *  card answered as `answer` says (pressed Yes in the window, or No over RPC), the result's text and the question cards seen. */
async function stampRun(ctx: ExampleCtx, session: string, input: { addon: string; text: string }, answer: "yes" | "no"): Promise<{ text: string; asked: number }> {
  const seen = ctx.requests().length;
  const before = new Set((await cardsNow(ctx)).map((c) => c.id));
  const sent = await ctx.rpc.request<{ seq: number }>("session.send", { id: session, message: { text: `ACCEPTANCE-CALL StampRun ${JSON.stringify(input)}`, clientMessageId: randomUUID() } }, 30_000);
  let asked = 0;
  await until("the StampRun turn to end", 120_000, async () => {
    for (const c of await cardsNow(ctx)) {
      if (before.has(c.id)) continue;
      before.add(c.id);
      if (c.kind === "confirm" && c.pluginId === ADDONS_ID) {
        asked++;
        const text = JSON.stringify((await ctx.rpc.request<{ card: unknown }>("card.get", { id: c.id })).card);
        if (!text.includes("A plugin asks") || !text.includes(`Run the stamp \\"${input.addon}\\"`)) fail(`the plugin's question card doesn't read as its own question: ${text.slice(0, 400)}`);
        if (answer === "yes") await ctx.pressCard("the plugin's question card", (x) => x.id === c.id);
        else await ctx.denyCard(c.id);
      } else if (c.session === session) {
        await ctx.approveCard(c.id);
      }
    }
    // The turn this message started (turn-end.ts), not another of the bot's that ended meanwhile.
    return ownTurnCompleted(await ctx.history(session), sent.seq, `ACCEPTANCE-CALL StampRun ${JSON.stringify(input)}`) !== undefined ? true : undefined;
  });
  const mine = ctx.requests().slice(seen);
  const result = mine.map((r) => r.toolResult).filter((x): x is { text: string; isError: boolean } => x !== undefined).at(-1);
  if (result === undefined) fail(`StampRun gave no result (${mine.map((r) => r.toolUse).filter(Boolean).join(", ") || "no tool called"})`);
  return { text: result!.text, asked };
}

export async function addonsStep(ctx: ExampleCtx, session: string): Promise<string> {
  try {
    return await run(ctx, session);
  } finally {
    await leave(ctx, ADDONS_ID);
  }
}

async function run(ctx: ExampleCtx, session: string): Promise<string> {
  const { rpc, home } = ctx;
  const done: string[] = [];

  // The app up and told of cards before the first one comes (its island's layer connected).
  await until("the app's island connected to the core", 30_000, () => (ctx.appLog().includes("layers: clover/island's layer connected to the core") ? true : undefined));
  await new Promise((r) => setTimeout(r, 2_000));
  // 1. Installed; its OK card's add-ons line; pressed; Glossary names its add-ons.
  const installed = await rpc.request<{ id: string; card?: string }>("plugin.install", { source: { from: "folder", path: FIXTURE } }, 60_000);
  if (installed.id !== ADDONS_ID) fail(`the fixture installed as ${installed.id}`);
  const ok = await until(`${ADDONS_ID}'s OK card`, 60_000, async () => (await cardsNow(ctx)).find((c) => c.kind === "plugin-ok" && c.pluginId === ADDONS_ID));
  const okText = JSON.stringify((await rpc.request<{ card: unknown }>("card.get", { id: ok.id })).card);
  if (!okText.includes("It loads add-ons of its own, which Clover doesn't check.")) fail(`its OK card doesn't say it loads add-ons of its own: ${okText.slice(0, 500)}`);
  await ctx.pressCard(`${ADDONS_ID}'s OK card`, (c) => c.id === ok.id);
  await until(`${ADDONS_ID} running after its OK`, 60_000, async () => ((await stateOf(ctx, ADDONS_ID)) === "running" ? true : undefined));
  const g = await callTurn(ctx, session, "Glossary", { load: ADDONS_ID });
  if (!g.result.text.includes("It takes add-ons: Stamps")) fail(`Alpha's Glossary load of ${ADDONS_ID} doesn't name its add-ons: "${g.result.text.slice(0, 400)}"`);
  done.push("1 its OK card says it loads add-ons Clover doesn't check, pressed; Glossary names them");

  // 2. A stamp in its data folder: asked, Yes pressed in the window, it runs.
  const data = join(home, "plugin-data", ADDONS_ID);
  const startsNow = () => { try { return Number(readFileSync(join(data, "starts"), "utf8")); } catch { return 0; } };
  const started = await until("its host half's first start counted", 30_000, () => (startsNow() >= 1 ? startsNow() : undefined));
  mkdirSync(join(data, "addons"), { recursive: true });
  writeFileSync(join(data, "addons", "shout.json"), JSON.stringify({ stamp: "LOUD" }));
  const first = await stampRun(ctx, session, { addon: "shout", text: "hello" }, "yes");
  if (first.asked !== 1 || !first.text.startsWith("acceptance-addons-stamped: LOUD: hello (trusted on the user's yes")) fail(`a new stamp: ${first.asked} question card(s), StampRun answered "${first.text.slice(0, 300)}"`);
  done.push("2 a new stamp: the plugin's question card (\"A plugin asks\", its own words) pressed Yes in the window; it ran");

  // 3. Again: no card. Changed: asked again, No: nothing runs.
  const again = await stampRun(ctx, session, { addon: "shout", text: "again" }, "yes");
  if (again.asked !== 0 || !again.text.startsWith("acceptance-addons-stamped: LOUD: again (trusted already")) fail(`the same stamp again: ${again.asked} question card(s), "${again.text.slice(0, 300)}"`);
  writeFileSync(join(data, "addons", "shout.json"), JSON.stringify({ stamp: "CHANGED" }));
  const changed = await stampRun(ctx, session, { addon: "shout", text: "changed" }, "no");
  if (changed.asked !== 1 || !changed.text.startsWith("acceptance-addons: not run: the user said no to shout")) fail(`a changed stamp answered No: ${changed.asked} question card(s), "${changed.text.slice(0, 300)}"`);
  writeFileSync(join(data, "addons", "shout.json"), JSON.stringify({ stamp: "LOUD" }));
  done.push("3 the same stamp: no card; a changed one asked again, No: not run");

  // 4. Restart from its detail in the Plugins page; the user's yes survives.
  await openDetail(ctx.cdp, NAME);
  await clickTree(ctx.cdp, "Restart", "button", "Restart");
  await until(`${ADDONS_ID} running after Restart`, 60_000, async () => ((await stateOf(ctx, ADDONS_ID)) === "running" ? true : undefined));
  // A host half starts when it is first called (no host.start): the next call starts it again, its second start.
  const after = await stampRun(ctx, session, { addon: "shout", text: "restarted" }, "yes");
  if (startsNow() <= started) fail(`after Restart its host half didn't start again (starts: ${startsNow()}; StampRun: "${after.text.slice(0, 200)}")`);
  if (after.asked !== 0 || !after.text.startsWith(`acceptance-addons-stamped: LOUD: restarted (trusted already; host start ${startsNow()})`)) fail(`after Restart: ${after.asked} question card(s), "${after.text.slice(0, 300)}" (starts ${startsNow()})`);
  done.push(`4 Restart on its detail: its host half started again (start ${startsNow()}); the trusted stamp ran with no card`);

  // 5. From its component (its status-bar button, a real click): `confirmCard` raises the same question card, pressed
  //    Yes in the window, then answered No; the component hears each answer with the card's id.
  const { cdp } = ctx;
  const buttonDoc = () => until("its status-bar button drawn", 30_000, async () => {
    for (const d of await cdp.documents()) {
      if (!d.url.startsWith(`clover-plugin://${ADDONS_ID}/`)) continue;
      if ((await cdp.evaluate(d.session, "!!document.querySelector('[data-addons=ask]')").catch(() => false)) === true) return d.session;
    }
    return undefined;
  });
  for (const [want, how] of [["yes", "press"], ["no", "deny"]] as const) {
    const doc = await buttonDoc();
    const before = new Set((await cardsNow(ctx)).map((c) => c.id));
    const at = await cdp.centerOf(doc, "[data-addons=ask]");
    if (at === undefined) fail("its status-bar button has no place on the screen");
    await cdp.click(doc, at!.x, at!.y);
    const card = await until("its component's question card", 30_000, async () => (await cardsNow(ctx)).find((c) => c.kind === "confirm" && c.pluginId === ADDONS_ID && !before.has(c.id)),
      async () => `the button says ${String(await cdp.evaluate(doc, "document.querySelector('[data-addons=ask]').getAttribute('data-answer')").catch(() => "?"))}`);
    if (how === "press") await ctx.pressCard("its component's question card", (c) => c.id === card.id);
    else await ctx.denyCard(card.id);
    const heard = await until(`the component to hear ${want}`, 20_000, async () => {
      const a = String(await cdp.evaluate(doc, "document.querySelector('[data-addons=ask]').getAttribute('data-answer')").catch(() => ""));
      return a.startsWith("yes ") || a.startsWith("no ") || a.startsWith("refused") ? a : undefined;
    });
    if (heard !== `${want} ${card.id}`) fail(`its component's confirmCard answered "${heard}", not "${want} ${card.id}"`);
  }
  done.push("5 from its component: confirmCard's question card pressed Yes in the window, then answered No; the component heard each with the card's id");

  return done.join("; ");
}
