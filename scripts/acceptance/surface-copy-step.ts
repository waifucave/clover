// The surface rules' own clause (F4, the owner's ruling of 2026-11-15: no infrastructure in the core or the app that only one
// plugin uses). A copy of the island and a copy of the pill, folder-installed under other ids behind their OK cards, hold the same
// capabilities as the bundled two and take their place; the same rows must hold:
//   * each OK card says what the copy does, in the plain lines the catalog gives (shows all your cards, on top of everything,
//     sends messages as you), and both copies run after the press on their cards;
//   * with the bundled two switched off, the copy island draws a pending plugin OK card's sealed frames (its words and buttons)
//     in a document of its own plugin, lets go of them while MOSS's window is in front (one place at a time) and draws them again
//     when it is not, and the card is answered by a real press on the copy's own sealed buttons;
//   * the copy pill sends the user's words as the user on a real press of its Send circle (a click the page makes itself is no
//     press), and the bot's conversation holds them;
//   * a folder plugin with user.send held to a button for 6 s with a real press, released, and sending 3 s later sends the user's
//     words once (the hold's release gives its frame one send within 30 s, its activation long gone); a second send on that
//     release and a send after a press with no release are refused;
//   * the bundled two come back when switched on, and the copies are removed.
// Nothing here names the bundled plugins' ids but to switch them off and on: the copies are the island and the pill's own sources,
// built into a client module and given another id and name.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildPluginModule } from "../../packages/core/src/registry/build";
import { fail, layerDocs, sleep, until, type ExampleCtx } from "./example-steps";
import { islandDrawsOkCard } from "./usage-drawn";

export const SURFACE_COPY_STEP = "a folder-installed copy of the island and of the pill, under other ids and behind their OK cards (shows all your cards, on top of everything, sends as you), takes the bundled ones' place: its island draws a plugin's OK card's sealed buttons and takes the press, lets go while the window is in front and draws it again after, and its pill sends the user's words as the user on a real press";

const PLUGINS = resolve(import.meta.dir, "..", "..", "plugins", "moss", "plugins");
const FIXTURE = resolve(import.meta.dir, "fixtures", "acceptance-island");
const FIXTURE_ID = "acceptance-island";
const HOLD = resolve(import.meta.dir, "fixtures", "acceptance-hold");
/** R12's fixture: a third-party click-through part painted where the island draws (it holds no card). */
const COVER = resolve(import.meta.dir, "fixtures", "acceptance-cover");
const COVER_ID = "acceptance-cover";
const HOLD_ID = "acceptance-hold";

export type Mirror = "island" | "pill";
export const MIRROR_ID: Readonly<Record<Mirror, string>> = { island: "mirror-island", pill: "mirror-pill" };
const MIRROR_NAME: Readonly<Record<Mirror, string>> = { island: "Mirror island", pill: "Mirror pill" };
/** The bundled plugins the copies stand in for (switched off while the copies run, on again after). */
const BUNDLED: Readonly<Record<Mirror, string>> = { island: "moss/island", pill: "moss/pill" };

/** The OK card's plain lines for what the copies hold (the catalog's `ok` words). */
export const MIRROR_OK_LINES: Readonly<Record<Mirror, readonly string[]>> = {
  island: ["shows all your approval cards, whichever bot or plugin asks, and takes your yes or no on them", "shows windows on top of everything else on your screen"],
  pill: ["shows all your approval cards, whichever bot or plugin asks, and takes your yes or no on them", "shows windows on top of everything else on your screen", "sends messages to your bots and sessions as you, with text it chooses, when you click or press a key in its window, or press its own key anywhere in MOSS Code's window, or up to 30 seconds after you let go", "adds items to the menu in your menu bar"],
};

/** A copy's manifest: the bundled one's, with an id and a name of its own and its client built to one module. Its capabilities, its
 *  surface's `window` fields and its tray line are the bundled plugin's own, so what it may do is what its OK card says. */
export function mirrorManifest(kind: Mirror): Record<string, unknown> {
  const src = JSON.parse(readFileSync(join(PLUGINS, kind, "moss.json"), "utf8")) as Record<string, unknown> & { contributes: Record<string, unknown>; client: Record<string, unknown> };
  // The strings: the part's own English is built in, so the copy needs no locale file of the bundled plugin's namespace.
  const { locales: _locales, ...contributes } = src.contributes;
  return { ...src, id: MIRROR_ID[kind], name: MIRROR_NAME[kind], client: { ...src.client, entry: "client/index.js" }, contributes };
}

/** Writes a copy's folder under `root` and returns its path. The client is the bundled plugin's own source, built the way the
 *  registry builds a client entry (everything bundled in but the layers' bare imports). */
export async function buildMirror(kind: Mirror, root: string): Promise<string> {
  const dir = join(root, MIRROR_ID[kind]);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "client"), { recursive: true });
  writeFileSync(join(dir, "moss.json"), `${JSON.stringify(mirrorManifest(kind), null, 2)}\n`);
  await buildPluginModule({ entry: join(PLUGINS, kind, "client", "index.tsx"), outFile: join(dir, "client", "index.js"), side: "client" });
  if (!existsSync(join(dir, "client", "index.js"))) throw new Error(`the ${kind} copy's client wasn't built`);
  return dir;
}

interface PluginCard { id: string; kind: string; pluginId?: string }
const okCardOf = (ctx: ExampleCtx, id: string) => async (): Promise<PluginCard | undefined> =>
  (await ctx.rpc.request<{ cards: PluginCard[] }>("card.list", {})).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === id);

/** The count of sealed frames a document of `plugin` holds for a card. */
async function sealedFramesOf(ctx: ExampleCtx, plugin: string, cardId: string): Promise<number> {
  let most = 0;
  const cdp = ctx.islandCdp ?? ctx.cdp;
  for (const d of await layerDocs(cdp, plugin)) {
    const n = Number(await cdp.evaluate(d.session, `document.querySelectorAll('[data-moss-card="${cardId}"] iframe[data-moss-sealed]').length`).catch(() => 0));
    most = Math.max(most, n);
  }
  return most;
}

export async function surfaceCopyStep(ctx: ExampleCtx, session: string): Promise<string> {
  // lane HS: the screen's surfaces (the copies, the hold fixture, the cover) are the background host's documents while one
  // runs; the window's own card is the window's.
  const { rpc } = ctx;
  const cdp = ctx.islandCdp ?? ctx.cdp;
  const setFront = ctx.setMainFront;
  if (setFront === undefined) return fail("this run has no seam to say the window is in front");
  const said: string[] = [];
  const installed: string[] = [];
  const switchedOff: string[] = [];
  let fixtureCard: string | undefined;
  try {
    // 1. Both copies install behind their OK cards, which say what each holds, and run once pressed.
    for (const kind of ["island", "pill"] as const) {
      const folder = await buildMirror(kind, ctx.root);
      const r = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
      if (r.id !== MIRROR_ID[kind]) fail(`the ${kind} copy installed as ${r.id}`);
      installed.push(r.id);
      const card = await until(`the ${kind} copy's OK card`, 30_000, okCardOf(ctx, r.id), async () => "no plugin-ok card");
      const text = JSON.stringify((await rpc.request<{ card: unknown }>("card.get", { id: card.id })).card);
      for (const line of MIRROR_OK_LINES[kind]) if (!text.includes(line)) fail(`the ${kind} copy's OK card doesn't say "${line}": ${text.slice(0, 300)}`);
      await ctx.pressCard(`the ${kind} copy's OK card`, (c) => c.id === card.id);
      await until(`the ${kind} copy running`, 60_000, async () => ((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id: r.id }).catch(() => undefined))?.plugin.state === "running" ? true : undefined),
        async () => JSON.stringify(await rpc.request("plugin.get", { id: r.id }).catch(() => null)).slice(0, 300));
    }
    said.push("both copies installed behind OK cards that name what they hold, and run after the press");
    // R12 (the controller's ruling): a third-party on-screen part that holds no card, painted where the island draws, stands
    // down while the copy island (the card's drawer) draws the card and takes its press.
    {
      const cr = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: COVER } }, 60_000);
      if (cr.id !== COVER_ID) fail(`${COVER_ID} installed as ${cr.id}`);
      installed.push(cr.id);
      const ccard = await until(`${COVER_ID}'s OK card`, 30_000, okCardOf(ctx, COVER_ID));
      await ctx.pressCard(`${COVER_ID}'s OK card`, (c) => c.id === ccard.id);
      await until(`${COVER_ID}'s part on the screen`, 60_000, async () => ((await layerDocs(cdp, COVER_ID)).length > 0 ? true : undefined));
    }

    // 2. The copies take the bundled two's place: they are switched off (as a user would in the Plugins page), the copies' windows
    // draw. (Two islands at once would be two windows; the clause is about the copy alone.)
    for (const kind of ["island", "pill"] as const) {
      await rpc.request("plugin.setEnabled", { id: BUNDLED[kind], enabled: false }, 30_000);
      switchedOff.push(BUNDLED[kind]);
    }
    await until("the copy island's surface document", 40_000, async () => ((await layerDocs(cdp, MIRROR_ID.island)).length > 0 ? true : undefined), async () => ctx.appLog().split("\n").filter((l) => /surface|mirror/.test(l)).slice(-6).join(" | "));
    await until("the copy pill's surface document", 40_000, async () => ((await layerDocs(cdp, MIRROR_ID.pill)).length > 0 ? true : undefined));
    if ((await layerDocs(cdp, "moss")).some((d) => /[?&]surface=(island|pill)/.test(d.url))) fail("a bundled surface's document is still there with the bundled two switched off");

    // 3. A pending plugin OK card (no bot: only a plugin with approvals.all may place it) is drawn by the copy island.
    const r = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: FIXTURE } }, 60_000);
    if (r.id !== FIXTURE_ID) fail(`${FIXTURE_ID} installed as ${r.id}`);
    installed.push(r.id);
    const card = await until(`${FIXTURE_ID}'s OK card`, 30_000, okCardOf(ctx, FIXTURE_ID));
    fixtureCard = card.id;
    const frames = await until("the copy island to place the OK card's sealed frames", 30_000, async () => {
      const n = await sealedFramesOf(ctx, MIRROR_ID.island, card.id);
      return n >= 3 ? n : undefined;
    }, async () => `the copy island's documents: ${(await layerDocs(cdp, MIRROR_ID.island)).map((d) => d.url.slice(0, 60)).join(" ")}; log: ${ctx.appLog().split("\n").filter((l) => /sealed|card:/.test(l)).slice(-4).join(" | ")}`);
    said.push(`the copy island drew the plugin OK card's ${frames} sealed frames, a card of no bot`);
    const surfaceLines = (ref: string) => ctx.appLog().split("\n").filter((l) => l.includes(`surface: ${ref} `));
    const coverRef = `${COVER_ID}#cover`;
    const islandRef = `${MIRROR_ID.island}#island`;
    await until("the cover hidden while the card waits", 20_000, async () => (/hidden while a card is pending/.test(surfaceLines(coverRef).at(-1) ?? "") ? true : undefined), async () => surfaceLines(coverRef).slice(-2).join(" | ") || "no line for the cover");
    if (/hidden while a card is pending/.test(surfaceLines(islandRef).at(-1) ?? "")) fail(`the copy island, the card's drawer, is still hidden: ${surfaceLines(islandRef).slice(-2).join(" | ")}`);
    said.push("R12: the cover (a third-party part holding no card) stood down while the copy island, the card's drawer, stayed");

    // 4. One place at a time, as the bundled island does: the window in front, the copy lets go; the window back, it draws again.
    const times = (re: RegExp) => ctx.appLog().split("\n").filter((l) => re.test(l) && l.includes(card.id)).length;
    const seen = (re: RegExp) => times(re) > 0;
    // The window's own program must have heard of the card and placed it on the island before the window comes to the front: on a
    // runner it heard 1.2 s late (run 44819946153), so it first met the card with the window already in front and logged "shown in",
    // never "moved to", though the card had been on the island. The move this row proves needs the card to have been there.
    await until("the window's program to place the OK card on the island", 30_000, async () => (seen(/router: \S+ placed island/) ? true : undefined), async () => `the window's log of the card: ${ctx.appLog().split("\n").filter((l) => l.includes(card.id)).slice(-3).join(" | ") || "nothing"}`);
    setFront(true);
    await until("the OK card moved to the window's own card", 20_000, async () => (seen(/moved to the window's own card \(window foreground\)/) ? true : undefined));
    await until("the copy island to let go of the frames", 20_000, async () => ((await sealedFramesOf(ctx, MIRROR_ID.island, card.id)) === 0 ? true : undefined));
    // The card's first move back to the island came with the window's first move to the front (the log has that line already): the
    // move this wait is for is the NEXT one, after the window goes back.
    const toIsland = /moved to the island \(window not foreground\)/;
    const movesBefore = times(toIsland);
    setFront(false);
    await until("the OK card moved back to the island", 20_000, async () => (times(toIsland) > movesBefore ? true : undefined));
    await until("the copy island to draw the frames again", 30_000, async () => ((await sealedFramesOf(ctx, MIRROR_ID.island, card.id)) >= 3 ? true : undefined));
    if (!(await islandDrawsOkCard(cdp))) fail("no document draws the OK card's Review after the copy island took it back");
    said.push("one place at a time: the copy island let go of the frames with the window in front and drew them again with it back");

    // 5. The press on the copy's own sealed buttons answers the card.
    if (!/hidden while a card is pending/.test(surfaceLines(coverRef).at(-1) ?? "")) fail(`the cover was not hidden when the copy island's card was pressed: ${surfaceLines(coverRef).slice(-2).join(" | ")}`);
    await ctx.pressCard("the plugin OK card, pressed on the copy island", (c) => c.id === card.id);
    await until(`${FIXTURE_ID} running`, 60_000, async () => ((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id: FIXTURE_ID }).catch(() => undefined))?.plugin.state === "running" ? true : undefined));
    fixtureCard = undefined;
    said.push("a real press on the copy's sealed Approve answered the card");

    // 6. The copy pill sends the user's words as the user, on a real press of its Send circle.
    const tag = `ACCEPTANCE-MIRROR-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
    const BOX = "textarea.clp-input";
    const SEND = "button.clp-circle[data-role=send]";
    const box = await until("the copy pill's text box", 30_000, async () => {
      for (const d of await layerDocs(cdp, MIRROR_ID.pill)) if ((await cdp.evaluate(d.session, `!!document.querySelector('${BOX}')`).catch(() => false)) === true) return d;
      return undefined;
    });
    const s = box.session;
    await cdp.evaluate(s, `(() => { const t = document.querySelector('${BOX}'); t.focus(); return true; })()`);
    await cdp.send("Input.insertText", { text: `${tag} say hello from the copy pill` }, s);
    await sleep(500);
    const typed = String(await cdp.evaluate(s, `document.querySelector('${BOX}').value`));
    if (!typed.includes(tag)) fail(`the copy pill's text box shows "${typed.slice(0, 60)}" after typing`);
    // A headless window gets no animation frames, so the pill stays at its resting size: the page is given room (as the pill row does).
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 160, deviceScaleFactor: 1, mobile: false }, s).catch(async () => {
      const top = (await cdp.documents()).find((d) => d.url.includes("surface=pill"));
      if (top === undefined) fail("the copy pill's window has no page of its own to give room");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 160, deviceScaleFactor: 1, mobile: false }, top!.session);
    });
    await sleep(600);
    // First the page's own click: no person's press behind it, so nothing is sent.
    await cdp.evaluate(s, `document.querySelector('${SEND}')?.click()`).catch(() => undefined);
    await sleep(1_500);
    const before = JSON.stringify(await ctx.history(session));
    if (before.includes(tag)) fail("the copy pill sent the user's words on a click the page made itself");
    let btn = await until("the copy pill's Send circle", 15_000, async () => cdp.centerOf(s, SEND).catch(() => undefined));
    for (let i = 0; i < 10; i++) {
      await sleep(250);
      const now = await cdp.centerOf(s, SEND).catch(() => undefined);
      if (now !== undefined) btn = now;
    }
    await cdp.click(s, btn.x, btn.y);
    await until("the user's words in the bot's conversation, sent by the copy pill", 40_000, async () => (JSON.stringify(await ctx.history(session)).includes(tag) ? true : undefined),
      async () => `the app's log: ${ctx.appLog().split("\n").filter((l) => /send:/.test(l)).slice(-3).join(" | ")}`);
    said.push("the copy pill sent the user's words as the user on a real press, and sent nothing on a click the page made itself");

    // 7. user.send after a hold: a real press held for 6 s and released, the page sends 3 s later (no click of its own, no activation).
    const hr = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: HOLD } }, 60_000);
    if (hr.id !== HOLD_ID) fail(`${HOLD_ID} installed as ${hr.id}`);
    installed.push(hr.id);
    const hcard = await until(`${HOLD_ID}'s OK card`, 30_000, okCardOf(ctx, HOLD_ID));
    await ctx.pressCard(`${HOLD_ID}'s OK card`, (c) => c.id === hcard.id);
    const hdoc = await until("the hold fixture's surface document", 60_000, async () => {
      for (const d of await layerDocs(cdp, HOLD_ID)) if ((await cdp.evaluate(d.session, `typeof globalThis.__holdSend === "function" && !!document.querySelector('[data-hold=button]')`).catch(() => false)) === true) return d;
      return undefined;
    });
    const hs = hdoc.session;
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 720, height: 160, deviceScaleFactor: 1, mobile: false }, hs).catch(() => undefined);
    await sleep(600);
    const HB = "[data-hold=button]";
    const hbtn = await until("the hold button's place", 15_000, async () => cdp.centerOf(hs, HB).catch(() => undefined));
    const mouse = (type: "mousePressed" | "mouseReleased") => cdp.send("Input.dispatchMouseEvent", { type, x: hbtn.x, y: hbtn.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 }, hs);
    const sendLater = async (text: string) => String(await cdp.evaluate(hs, `globalThis.__holdSend(${JSON.stringify({ session })}, ${JSON.stringify(text)})`).catch((e: unknown) => `evaluate failed: ${String(e)}`));
    const seenCount = async (t: string) => (JSON.stringify(await ctx.history(session)).split(t).length - 1);
    // (a) A press with no release behind it: 3 s later the one-second rule has run out, so the send is refused and nothing arrives.
    const noRelease = `ACCEPTANCE-NOREL-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
    await mouse("mousePressed");
    await sleep(3_000);
    const refusedNoRelease = await sendLater(noRelease);
    if (!refusedNoRelease.startsWith("refused")) fail(`a send 3 s after a press with no release was not refused: ${refusedNoRelease}`);
    // (b) A new press, held 6 s, released, then 3 s later: the words arrive once.
    await mouse("mouseReleased");
    const held = `ACCEPTANCE-HOLD-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
    await mouse("mousePressed");
    await sleep(6_000);
    await mouse("mouseReleased");
    await sleep(3_000);
    const sent = await sendLater(held);
    if (sent !== "sent") fail(`the send 3 s after a held press's release said "${sent}": ${ctx.appLog().split("\n").filter((l) => /send:/.test(l)).slice(-3).join(" | ")}`);
    await until("the held words in the bot's conversation", 40_000, async () => ((await seenCount(held)) >= 1 ? true : undefined));
    // (c) One release covers one send.
    const second = await sendLater(`${held}-AGAIN`);
    if (!second.startsWith("refused")) fail(`a second send on one release was not refused: ${second}`);
    await sleep(1_500);
    if ((await seenCount(held)) !== 1 || (await seenCount(noRelease)) !== 0 || JSON.stringify(await ctx.history(session)).includes("-AGAIN")) fail("the bot's conversation doesn't hold the held words exactly once and nothing else");
    said.push("a press held 6 s and released let the page send once 3 s later (the words arrived once); a second send on that release, and a send after a press with no release, were refused");
    return said.join("; ");
  } finally {
    if (fixtureCard !== undefined) await ctx.denyCard(fixtureCard).catch(() => undefined);
    for (const id of switchedOff) await rpc.request("plugin.setEnabled", { id, enabled: true }, 30_000).catch(() => undefined);
    for (const id of installed.reverse()) {
      const rm = await rpc.request<{ card?: string }>("plugin.remove", { id }).catch(() => undefined);
      if (rm?.card !== undefined) await ctx.approveCard(rm.card).catch(() => undefined);
    }
    setFront(false);
    rmSync(join(ctx.root, MIRROR_ID.island), { recursive: true, force: true });
    rmSync(join(ctx.root, MIRROR_ID.pill), { recursive: true, force: true });
  }
}
