// The router row (lane RT, spec revision 19 §3.5, ruling A): the engine's router places every pending card from the presence
// MOSS Code's main process reports, and the window and the island follow it. A card with no session (a plugin's OK card,
// from the run's own fixture) is placed in the focused window's strip (the core's own card page in the window) and its
// Approve is pressed there and taken; with the window visible but not focused (the seam's "back": a headless window is never
// the focused one, and stays visible) the router moves it to the island and the strip lets go; and the next card with no
// session (the plugin's OK card again, after it is removed and installed again) is the island's, which draws it and takes
// the press. Each placement is read from the app's own `router:` lines (ids and places only).
import { join } from "node:path";
import { fail, sleep, until, type ExampleCtx } from "./example-steps";

export const ROUTER_STEP = "the engine's router: a card with no session is placed in the focused window's strip and its Approve is taken there; the window visible but not focused moves it to the island, and the next such card is drawn and pressed on the island";

const ID = "acceptance-router";
interface Card { id: string; kind: string; pluginId?: string }

export async function routerStep(ctx: ExampleCtx): Promise<string> {
  if (ctx.setMainFront === undefined) fail("this run has no seam to say the window is in front");
  const front = ctx.setMainFront!;
  const { rpc, cdp } = ctx;
  const lines: string[] = [];
  const logHas = (re: RegExp) => ctx.appLog().split("\n").some((l) => re.test(l));
  const ownPage = async (id: string) => (await cdp.documents()).some((d) => d.url.startsWith(`moss-sealed://card/${encodeURIComponent(id)}/own`));
  const stateOf = async () => (await rpc.request<{ plugin?: { state?: string } }>("plugin.get", { id: ID }).catch(() => undefined))?.plugin?.state;
  try {
    // 1. The window focused: a plugin's OK card (no session) goes to the window's strip.
    front(true);
    await sleep(500);
    await rpc.request("plugin.install", { source: { from: "folder", path: join(import.meta.dir, "fixtures", ID) } }, 60_000);
    const ok = await until(`${ID}'s OK card`, 60_000, async () => (await rpc.request<{ cards: Card[] }>("card.list")).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === ID));
    const placed = (id: string, where: string) => new RegExp(`router: ${id} placed ${where}`);
    await until("the router placing the OK card in the window's strip", 20_000, () => (logHas(placed(ok.id, "strip \\(code main\\)")) ? true : undefined));
    await until("the window's strip drawing the OK card", 20_000, async () => ((await ownPage(ok.id)) ? true : undefined));
    lines.push("a card with no session, the window focused: placed in the window's strip, which drew it");
    // 2. Visible but not focused: the island takes it, and the strip lets go.
    front(false);
    await until("the router moving the OK card to the island", 20_000, () => (logHas(placed(ok.id, "island from strip")) ? true : undefined));
    await until("the window's strip letting go of the OK card", 20_000, async () => ((await ownPage(ok.id)) ? undefined : true));
    lines.push("the window visible but not focused: the router moved it to the island and the strip let go");
    // 3. Focused again: back in the strip, and its Approve there is taken.
    front(true);
    await until("the router moving the OK card back to the strip", 20_000, () => (logHas(placed(ok.id, "strip \\(code main\\) from island")) ? true : undefined));
    const strips = () => ctx.appLog().split("\n").filter((l) => l.includes(`the window's strip for ${ok.id}`)).length;
    if (strips() === 0) fail("the app never drew the OK card as the window's strip");
    if (logHas(new RegExp(`the fallback card for ${ok.id}`))) fail("the app drew the safety net's fallback card for the OK card, though the router placed it in the window's strip");
    // The run's app log is two files joined (its own output, then the home's app.log), so a position in it moves: each card's
    // id is unique, and the whole log is read.
    await ctx.pressCard(`${ID}'s OK card`, (c) => c.id === ok.id);
    const after = ctx.appLog();
    if (!after.includes(`sealed: answer accepted for ${ok.id}`)) fail(`the OK card's Approve in the strip wasn't taken: ${after.split("\n").filter((l) => l.includes("sealed:") && l.includes(ok.id)).slice(-4).join(" | ").slice(0, 400)}`);
    // The strip is the core's own card page (`own`); offscreen, its window may go unnamed in the press line.
    if (!new RegExp(`sealed: press on ${ok.id} own in `).test(after) || new RegExp(`sealed: press on ${ok.id} \\S+ in moss/island#island`).test(after)) fail(`the OK card was answered, but not by a press on the window's strip (the core's own card page): ${after.split("\n").filter((l) => l.includes(`sealed: press on ${ok.id}`)).slice(-3).join(" | ").slice(0, 400)}`);
    await until(`${ID} running`, 60_000, async () => ((await stateOf()) === "running" ? true : undefined));
    lines.push("its Approve pressed in the window's strip: taken by the app and the core, the plugin running");
    // 4. No window focused: the next card with no session (the same plugin's OK card again, after it is removed) is the
    // island's, which draws it and takes the press.
    const gone = await rpc.request<{ card?: string }>("plugin.remove", { id: ID }, 30_000);
    if (gone.card !== undefined) await ctx.approveCard(gone.card);
    await until(`${ID} removed`, 30_000, async () => ((await stateOf()) === undefined ? true : undefined));
    front(false);
    await sleep(500);
    await rpc.request("plugin.install", { source: { from: "folder", path: join(import.meta.dir, "fixtures", ID) } }, 60_000);
    const again = await until(`${ID}'s second OK card`, 60_000, async () => (await rpc.request<{ cards: Card[] }>("card.list")).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === ID && c.id !== ok.id));
    await until("the router placing the second OK card on the island", 20_000, () => (logHas(placed(again.id, "island")) ? true : undefined));
    await ctx.pressCard(`${ID}'s second OK card`, (c) => c.id === again.id);
    const after2 = ctx.appLog();
    if (!after2.includes(`sealed: answer accepted for ${again.id}`)) fail(`the second OK card's Approve wasn't taken: ${after2.split("\n").filter((l) => l.includes("sealed:") && l.includes(again.id)).slice(-4).join(" | ").slice(0, 400)}`);
    if (!new RegExp(`sealed: press on ${again.id} \\S+ in moss/island#island`).test(after2)) fail(`the second OK card, placed on the island, was not pressed on the island: ${after2.split("\n").filter((l) => l.includes(`sealed: press on ${again.id}`)).slice(-3).join(" | ").slice(0, 400)}`);
    await until(`${ID} running again`, 60_000, async () => ((await stateOf()) === "running" ? true : undefined));
    lines.push("no window focused (visible, not focused): the next card with no session placed on the island, which drew it and took the press");
    return lines.join("; ");
  } finally {
    front(false);
    // Whatever happened, the fixture goes (its removal card answered over RPC).
    if ((await stateOf()) !== undefined) {
      const r = await rpc.request<{ card?: string }>("plugin.remove", { id: ID }).catch(() => undefined);
      if (r?.card !== undefined) await ctx.approveCard(r.card).catch(() => undefined);
    }
  }
}
