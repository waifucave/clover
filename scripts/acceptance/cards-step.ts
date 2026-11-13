// The card-placing row: a third-party plugin with `approvals` places its own bot's approval card in a page of its own
// (not the conversation, not the island) with the SDK's card kit, and the run presses Approve there, in that frame, for
// real (a trusted click, which the main process sees as the person's): the tool runs. A second plugin that holds
// `approvals` too, but has no bot, is not told of that card: it is mounted the whole time (its badge says so, and says its
// own card list was answered), and it never lists it. With the first plugin's page out of the window, the card's buttons
// are drawn by what else shows them (the island; the app's own fallback card when nothing visible does), and one of
// those is pressed: the tool runs again.
//
// Two fixtures (scripts/acceptance/fixtures/acceptance-cards-a, -b), each installed from its folder on the Plugins page.
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { clickTree, fail, installFromPage, leave, SIDEBAR_ITEMS, sleep, until, type ExampleCtx } from "./example-steps";

export const CARDS_STEP = "a third-party plugin with `approvals` places its own bot's tool card in a page of its own and the run presses Approve in that frame (the tool runs); a second plugin with `approvals` and no bot is mounted, lists its cards, and is never told of it; with the page out of the window the card is still pressable (the island's buttons or the app's fallback card)";

const FIXTURES = resolve(import.meta.dir, "fixtures");
const A = "acceptance-cards-a";
const B = "acceptance-cards-b";
const sealedUrl = (id: string) => `clover-sealed://card/${encodeURIComponent(id)}/`;

type Ev = Record<string, unknown> & { type?: string; seq?: number };
interface Card { id: string; kind: string; change?: string; session?: string; pluginId?: string }

export async function cardsStep(ctx: ExampleCtx): Promise<string> {
  try {
    return await run(ctx);
  } finally {
    await leave(ctx, A);
    await leave(ctx, B);
  }
}

async function run(ctx: ExampleCtx): Promise<string> {
  const { cdp, rpc } = ctx;
  const done: string[] = [];
  const docsOf = async (id: string) => (await cdp.documents()).filter((d) => d.url.startsWith(`clover-plugin://${id}/`));
  /** What one data attribute of the first matching element of a plugin's documents says, or undefined when none is drawn. */
  const attr = async (id: string, selector: string, name: string): Promise<string | undefined> => {
    for (const d of await docsOf(id)) {
      const v = await cdp.evaluate(d.session, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? (e.getAttribute(${JSON.stringify(name)}) ?? '') : null; })()`).catch(() => null);
      if (typeof v === "string") return v;
    }
    return undefined;
  };
  const cardsNow = async () => (await rpc.request<{ cards: Card[] }>("card.list")).cards;
  const send = (session: string, text: string) => rpc.request<{ seq: number }>("session.send", { id: session, message: { text, clientMessageId: randomUUID() } }, 30_000);
  const history = async (session: string) => (await rpc.request<{ events: Ev[] }>("session.history", { id: session, limit: 200 }).catch(() => ({ events: [] as Ev[] }))).events;
  const completedAfter = async (session: string, seq: number) => (await history(session)).some((e) => e.type === "turn_completed" && typeof e.seq === "number" && e.seq > seq);

  // 1. Both installed the user's way, each OK card pressed.
  await installFromPage(ctx, join(FIXTURES, A), A);
  await installFromPage(ctx, join(FIXTURES, B), B);
  const bot = await until("A's bot in bot.list", 60_000, async () => (await rpc.request<{ bots: { id: string; mainSession?: string }[] }>("bot.list", {})).bots.find((b) => b.id === `${A}/bot` && b.mainSession !== undefined));
  const session = bot.mainSession!;
  // B's badge sits in the sidebar the whole time: mounted, and its own card list answered by the core (not refused).
  await until("B's badge, its card list answered", 60_000, async () => {
    const [mounted, listed] = [await attr(B, '[data-cards-b="badge"]', "data-mounted"), await attr(B, '[data-cards-b="badge"]', "data-listed")];
    return mounted === "yes" && listed === "answered" ? true : undefined;
  }, async () => `B says mounted=${await attr(B, '[data-cards-b="badge"]', "data-mounted")} listed=${await attr(B, '[data-cards-b="badge"]', "data-listed")}`);
  done.push("both installed from their folders and OK'd; B's badge mounted and its card list answered");

  // 2. A's page open, then a turn that calls its tool: the card is raised for A's own bot's session, and A's page is told of it.
  await clickTree(cdp, "A's sidebar entry", SIDEBAR_ITEMS, "Acceptance cards A");
  await until("A's page", 30_000, async () => ((await attr(A, '[data-cards-a="main"]', "data-ids")) !== undefined ? true : undefined));
  const first = await send(session, "ACCEPTANCE-CALL ask_card {}");
  // A turn may open with the bot's provider card (a change); it is pressed where it is drawn, and this waits for the tool's own.
  let tool: Card | undefined;
  const settled = new Set<string>();
  await until("the tool card for A's bot's session", 90_000, async () => {
    for (const c of await cardsNow()) {
      if (c.session !== session) continue;
      if (c.kind === "tool") { tool = c; return true; }
      if (!settled.has(c.id)) { settled.add(c.id); await ctx.pressCard(`A's bot's ${c.kind}${c.change !== undefined ? ` (${c.change})` : ""} card`, (x) => x.id === c.id); }
    }
    return undefined;
  });
  const card = tool!;
  const placed = await until("A's page to place the card (data-placed)", 30_000, async () => ((await attr(A, '[data-cards-a="main"]', "data-placed")) === card.id ? true : undefined),
    async () => `A's page says placed=${await attr(A, '[data-cards-a="main"]', "data-placed")} ids=${await attr(A, '[data-cards-a="main"]', "data-ids")}; A's badge ids=${await attr(A, '[data-cards-a="badge"]', "data-ids")}`);
  void placed;
  const aFrames = await until("A's approve and deny frames", 20_000, async () => {
    for (const d of await docsOf(A)) {
      const n = Number(await cdp.evaluate(d.session, `document.querySelectorAll('iframe[data-clover-sealed]').length`).catch(() => 0));
      if (n >= 2) return n;
    }
    return undefined;
  });
  done.push(`A's page, not the conversation, placed ${card.id} (${aFrames} sealed frames; the card is for ${A}'s bot's session)`);

  // 3. B is told of nothing: sampled for four seconds against the control (A's own badge heard it), by the event and by the list.
  const aBadge = await attr(A, '[data-cards-a="badge"]', "data-ids");
  if (aBadge === undefined || !aBadge.includes(card.id)) fail(`A's own badge (the control) wasn't told of the card: ${JSON.stringify(aBadge)}`);
  for (let i = 0; i < 8; i++) {
    const ids = await attr(B, '[data-cards-b="badge"]', "data-ids");
    const listed = await attr(B, '[data-cards-b="badge"]', "data-listed");
    if (ids === undefined) fail("B's badge went away while the card was pending (the check would prove nothing)");
    if (ids!.includes(card.id)) fail(`B (approvals, no bot) was told of A's bot's card: ${ids}`);
    if (listed !== "answered") fail(`B's own card list was not answered while the card was pending (${listed})`);
    await sleep(500);
  }
  done.push("B (mounted, list answered) was told of no card, by event or by list, while A's badge was");

  // 4. The press, in A's own frame: its iframe's src names the sealed document; the page says when it will take a press.
  const approveSrc = await attr(A, '[data-cards-a="approve"] iframe', "src");
  if (approveSrc === undefined || approveSrc === "") fail("A's approve frame has no src");
  const sealed = await until("the sealed button document A's frame loaded", 20_000, async () => (await cdp.documents()).find((d) => d.url === approveSrc));
  // The log is two files joined (the app's own output, then the home's app.log), so a position in it moves as the first grows:
  // the card's id is unique, and refusals are counted before and after.
  const refusals = (text: string) => (text.match(/sealed: (?:core refused answer|answer held back|answer refused)[^\n]*/g) ?? []).length;
  const refusedBefore = refusals(ctx.appLog());
  const press = await until("the approve button inside A's frame", 10_000, () => cdp.centerOf(sealed.session, ".seal-button[data-kind=approve]:not(.quiet):not([data-remember])"), async () => "no approve button");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: press.x, y: press.y, button: "none", buttons: 0 }, sealed.session).catch(() => undefined);
  const dumpPress = async (): Promise<string> => {
    const inSealed = await cdp.evaluate(sealed.session, "JSON.stringify({ready:document.body.dataset.ready??null,vis:document.visibilityState,w:innerWidth,h:innerHeight,btn:(()=>{const b=document.querySelector('.seal-button');if(!b)return null;const r=b.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()})").catch(() => "gone");
    let inA = "no A doc";
    for (const d of await docsOf(A)) {
      const v = await cdp.evaluate(d.session, `JSON.stringify((() => {
        const f = document.querySelector('[data-cards-a="approve"] iframe');
        if (!f) return { none: true, vis: document.visibilityState, url: location.href };
        const r = f.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const chain = []; for (let e = f; e && chain.length < 12; e = e.parentElement) { const c = getComputedStyle(e); chain.push([e.tagName, c.opacity, c.filter, c.transform, c.overflow, c.visibility].join('|')); }
        return { vis: document.visibilityState, rect: [r.x, r.y, r.width, r.height], win: [innerWidth, innerHeight], atPoint: at ? at.tagName + (at === f ? ' (the frame)' : ' (not the frame)') : null, chain };
      })())`).catch(() => "gone");
      inA = `${d.url.slice(0, 60)} ${String(v)}`;
    }
    return `sealed doc: ${String(inSealed)}; A's doc: ${inA}`;
  };
  await until("the sealed page ready to answer", 10_000, async () => {
    const v = await cdp.evaluate(sealed.session, "document.body.dataset.ready ?? 'none'").catch(() => "gone");
    return v === "yes" || v === "none" ? v : undefined;
  }, dumpPress);
  await sleep(400);
  // The sealed frame can be drawn again between the lookup and the press (the debugging protocol then says its session is gone): the
  // document is found again by its address and the press made on the new one.
  for (let attempt = 0; ; attempt++) {
    try {
      const now = (await cdp.documents()).find((d) => d.url === approveSrc) ?? sealed;
      const at = (await cdp.centerOf(now.session, ".seal-button[data-kind=approve]:not(.quiet):not([data-remember])")) ?? press;
      await cdp.click(now.session, at.x, at.y);
      break;
    } catch (err) {
      if (attempt >= 3 || !/Session with given id not found/.test(String((err as Error).message))) throw err;
      await sleep(500);
    }
  }
  await until(`the app to accept the answer for ${card.id}`, 15_000, async () => {
    const text = ctx.appLog();
    if (text.includes(`sealed: answer accepted for ${card.id}`)) return true;
    return refusals(text) > refusedBefore ? fail(`the press in A's frame was refused: ${/sealed: (?:core refused answer|answer held back|answer refused)[^\n]*/.exec(text.slice(text.lastIndexOf("sealed: ") - 1))?.[0] ?? "(see app.log)"}`) : undefined;
  });
  await until("the turn to complete after the press", 90_000, async () => ((await completedAfter(session, first.seq)) ? true : undefined));
  if (!ctx.requests().some((r) => r.toolResult?.text.includes("asked-ok"))) fail("the tool did not run after the press (no asked-ok result reached the model)");
  done.push("Approve pressed in A's own frame (accepted by the app and the core), and the tool ran (asked-ok)");

  // 5. A's page out of the window (B's page opens instead): the next card's buttons are drawn by what else shows them.
  await clickTree(cdp, "B's sidebar entry", SIDEBAR_ITEMS, "Acceptance cards B");
  await until("A's page gone", 20_000, async () => ((await attr(A, '[data-cards-a="main"]', "data-ids")) === undefined ? true : undefined));
  const second = await send(session, "ACCEPTANCE-CALL ask_card {}");
  const card2 = await until("the second tool card", 90_000, async () => (await cardsNow()).find((c) => c.kind === "tool" && c.session === session && c.id !== card.id));
  await sleep(2_500);
  const log = ctx.appLog();
  const fallback = new RegExp(`fallback card for ${card2.id}`).test(log);
  const docs2 = (await cdp.documents()).filter((d) => d.url.startsWith(sealedUrl(card2.id)));
  const drawn = docs2.map((d) => decodeURIComponent(d.url.slice(sealedUrl(card2.id).length).split("?")[0]!)).join(", ") || "none";
  if (docs2.length === 0 && !fallback) fail(`with A's page out, nothing drew ${card2.id}'s buttons and no fallback card was logged`);
  await ctx.pressCard("the second card, pressed where it is drawn", (c) => c.id === card2.id);
  await until("the second turn to complete", 90_000, async () => ((await completedAfter(session, second.seq)) ? true : undefined));
  done.push(`A's page out: ${card2.id} drawn as [${drawn}], app fallback card ${fallback ? "logged within 2.5 s" : "not logged (a visible button elsewhere, the island's, keeps it back)"}; pressed there, the tool ran again`);
  return done.join("; ");
}
