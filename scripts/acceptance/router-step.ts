// The router row (lane RT, spec revision 19 §3.5, ruling A): the engine's router places every pending card from the presence
// MOSS Code's main process reports, and the window and the island follow it. A card with no session (a plugin's OK card,
// from the run's own fixture) is placed in the focused window's strip (the core's own card page in the window) and its
// Approve is pressed there and taken; with the window visible but not focused (the seam's "back": a headless window is never
// the focused one, and stays visible) the router puts the next card (the plugin's removal) on the island, which draws it
// and takes the press. Each placement is read from the app's own `router:` lines (ids and places only).
import { join } from "node:path";
import { fail, sleep, until, type ExampleCtx } from "./example-steps";

export const ROUTER_STEP = "the engine's router: a card with no session is placed in the focused window's strip and its Approve is taken there; the window visible but not focused moves it to the island, which draws it and takes the press";

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
    const from = ctx.appLog().length;
    await ctx.pressCard(`${ID}'s OK card`, (c) => c.id === ok.id);
    const after = ctx.appLog().slice(from);
    if (!after.includes(`sealed: answer accepted for ${ok.id}`)) fail(`the OK card's Approve in the strip wasn't taken: ${after.split("\n").filter((l) => l.includes("sealed:")).slice(-4).join(" | ").slice(0, 400)}`);
    if (!new RegExp(`sealed: press on ${ok.id} \\S+ in the window's strip`).test(after)) fail(`the OK card was answered, but not by a press in the window's strip: ${after.split("\n").filter((l) => l.includes("sealed: press on")).slice(-3).join(" | ").slice(0, 400)}`);
    await until(`${ID} running`, 60_000, async () => ((await stateOf()) === "running" ? true : undefined));
    lines.push("its Approve pressed in the window's strip: taken by the app and the core, the plugin running");
    // 4. No window focused: the removal card (no session either) is the island's, which takes the press.
    front(false);
    await sleep(500);
    const gone = await rpc.request<{ card?: string }>("plugin.remove", { id: ID }, 30_000);
    if (gone.card === undefined) fail("removing the plugin raised no card");
    await until("the router placing the removal card on the island", 20_000, () => (logHas(placed(gone.card!, "island")) ? true : undefined));
    const from2 = ctx.appLog().length;
    await ctx.pressCard(`${ID}'s removal card`, (c) => c.id === gone.card);
    const after2 = ctx.appLog().slice(from2);
    if (!after2.includes(`sealed: answer accepted for ${gone.card}`)) fail(`the removal card's Approve wasn't taken: ${after2.split("\n").filter((l) => l.includes("sealed:")).slice(-4).join(" | ").slice(0, 400)}`);
    if (new RegExp(`sealed: press on ${gone.card} \\S+ in the window's strip`).test(after2)) fail("the removal card, placed on the island, was taken by a press in the window's strip");
    const onIsland = new RegExp(`sealed: press on ${gone.card} \\S+ in moss/island#island`).test(after2);
    if (!onIsland) fail(`the removal card, placed on the island, was not pressed on the island: ${after2.split("\n").filter((l) => l.includes("sealed: press on")).slice(-3).join(" | ").slice(0, 400)}`);
    await until(`${ID} removed`, 30_000, async () => ((await stateOf()) === undefined ? true : undefined));
    lines.push("no window focused: the removal card placed on the island, which drew it and took the press");
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
