// The door for parts' own clause (F2, the owner's ruling of 2026-11-15: no door checks a plugin's id). A copy of the
// bundled conversation, folder-installed under another id behind its OK card, holds the same capabilities as the bundled
// one (its manifest's, which the copy carries) and takes its place in Alpha's tab; the conversation's rows must hold on it:
//   * its OK card says what it holds, in the catalog's plain lines (reads your conversations, sends as you), and it runs after
//     the press on its card;
//   * with the bundled conversation switched off, the copy draws Alpha's conversation in a document of its own plugin: the
//     user's words and the bot's reply of a turn show there;
//   * a turn that fails shows Try again on its error row in the copy; a click the page makes itself sends nothing (the
//     user's press is kept for every holder); one real click sends the user's own message again through the app's door
//     (`session.resend`, allowed by the copy's `user.send`, never by its id), and the turn completes with its own reply;
//   * the app logged no refusal of the copy's calls at the door, and the bundled conversation comes back when switched on.
// Nothing here names the bundled plugin's id but to switch it off and on: the copy is the conversation's own source, built
// into a client module and given another id and name.
import { partElsewhere } from "./elsewhere-parts";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { CLIENT_BARE_IMPORTS, capabilityOkText } from "../../packages/plugin-sdk/src/index";
import { fail, layerDocs, sleep, toSessionTab, until, type ExampleCtx } from "./example-steps";

export const CONVERSATION_COPY_STEP = "a folder-installed copy of the conversation, under another id and behind its OK card (reads your conversations, sends as you), takes the bundled one's place in Alpha's tab: it draws her turn, shows Try again on a failed turn, a click the page makes itself sends nothing, and one real click sends the user's message again through the app's door by its user.send, never its id";

const PLUGINS = resolve(import.meta.dir, "..", "..", "plugins", "moss", "plugins");
export const COPY_ID = "mirror-conversation";
const COPY_NAME = "Mirror conversation";
/** The bundled plugin the copy stands in for (switched off while the copy runs, on again after). */
const BUNDLED = "moss/conversation";

/** The OK card's plain lines for what the copy holds: the catalog's own `ok` words for its `conversation.read` and its
 *  `user.send` (read from the catalog, so a reworded line is still the one checked). */
export const COPY_OK_LINES: readonly string[] = ["conversation.read", "user.send"].map((c) => capabilityOkText(c) ?? c);

/** The copy's manifest: the bundled one's, with an id and a name of its own and its client built to one module. Its
 *  capabilities and its spot's `declares` are the bundled plugin's own, so what it may do is what its OK card says. */
export function copyManifest(): Record<string, unknown> {
  const src = JSON.parse(readFileSync(join(PLUGINS, "conversation", "moss.json"), "utf8")) as Record<string, unknown> & { contributes: Record<string, unknown>; client: Record<string, unknown> };
  const { locales: _locales, ...contributes } = src.contributes;
  return { ...src, id: COPY_ID, name: COPY_NAME, client: { ...src.client, entry: "client/index.js" }, contributes };
}

/** Writes the copy's folder under `root` and returns its path: the bundled conversation's own source, unchanged (F2b: it
 *  imports the public UI SDK and nothing outside its folder, so nothing is substituted), built to one module as the
 *  registry builds a client entry (everything bundled in but the layers' bare imports), and its stylesheets. */
export async function buildCopy(root: string): Promise<string> {
  const dir = join(root, COPY_ID);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "client"), { recursive: true });
  const manifest = copyManifest() as { client: { css?: string[] } };
  writeFileSync(join(dir, "moss.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const css of manifest.client.css ?? []) copyFileSync(join(PLUGINS, "conversation", css), join(dir, css));
  const from = join(PLUGINS, "conversation", "client");
  const result = await Bun.build({
    entrypoints: [join(from, "index.tsx")], outdir: join(dir, "client"), target: "browser", format: "esm", splitting: false, minify: false,
    naming: { entry: "index.[ext]" }, external: [...CLIENT_BARE_IMPORTS], define: { "process.env.NODE_ENV": JSON.stringify("production") }, throw: false,
    ...{ macros: false },
  });
  if (!result.success || !existsSync(join(dir, "client", "index.js"))) throw new Error(`the conversation copy's client wasn't built: ${result.logs.map((l) => String(l)).join("; ").slice(0, 400)}`);
  return dir;
}

const RETRY = ".cl-conv-note[data-tone=error] button.cl-conv-note__retry";

/** The copy's document text, all of its documents. */
async function copyText(ctx: ExampleCtx): Promise<string> {
  let out = "";
  for (const d of await layerDocs(ctx.cdp, COPY_ID)) out += String(await ctx.cdp.evaluate(d.session, "document.body ? document.body.innerText : ''").catch(() => ""));
  return out;
}

export async function conversationCopyStep(ctx: ExampleCtx, _session: string): Promise<string> {
  const { rpc, cdp } = ctx;
  if (ctx.healFake === undefined) return fail("this run has no way to let the fake provider's failing turn succeed");
  const said: string[] = [];
  let installed = false;
  let switchedOff = false;
  const refusals = () => ctx.appLog().split("\n").filter((l) => l.includes(`tree: ${COPY_ID}:`) && l.includes("refused"));
  try {
    // The code session its turns run in (the newest), and the window put on THAT one: the sidebar's first row can be another session's
    // (a long home has many), and the copy draws the session the window shows.
    const coding = (await rpc.request<{ sessions: { id: string; title?: string; kind?: string; startedAt?: number }[] }>("session.list", { kinds: ["coding"] })).sessions
      .filter((x) => x.kind === "coding").sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0));
    // The newest that has been answered: a coding session started with no prompt on a model the run holds no key for (the diff
    // panel's `diff-work`, the newest of a long run) answers its first message with the provider's refusal, not a reply; with none
    // answered, the run's own session is the one.
    let chosen: (typeof coding)[number] | undefined;
    for (const c of coding) {
      const events = (await rpc.request<{ events: Record<string, unknown>[] }>("session.history", { id: c.id, limit: 200 }).catch(() => ({ events: [] as Record<string, unknown>[] }))).events;
      if (events.some((e) => e.type === "assistant_message")) { chosen = c; break; }
    }
    const session = chosen?.id ?? _session;
    await toSessionTab(ctx, chosen?.title ?? session);
    const log = async () => (await rpc.request<{ events: Record<string, unknown>[] }>("session.history", { id: session, limit: 500 })).events;

    // 1. The copy installs behind its OK card, which says what it holds, and runs once pressed.
    const folder = await buildCopy(ctx.root);
    const r = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
    if (r.id !== COPY_ID) fail(`the conversation copy installed as ${r.id}`);
    installed = true;
    const card = await until("the conversation copy's OK card", 30_000, async () => (await rpc.request<{ cards: { id: string; kind: string; pluginId?: string }[] }>("card.list", {})).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === COPY_ID));
    const text = JSON.stringify((await rpc.request<{ card: unknown }>("card.get", { id: card.id })).card);
    for (const line of COPY_OK_LINES) if (!text.includes(line)) fail(`the copy's OK card doesn't say "${line}": ${text.slice(0, 300)}`);
    await ctx.pressCard("the conversation copy's OK card", (c) => c.id === card.id);
    await until("the conversation copy running", 60_000, async () => ((await rpc.request<{ plugin: { state: string } }>("plugin.get", { id: COPY_ID }).catch(() => undefined))?.plugin.state === "running" ? true : undefined),
      async () => JSON.stringify(await rpc.request("plugin.get", { id: COPY_ID }).catch(() => null)).slice(0, 300));
    said.push("the copy installed behind an OK card that says it reads your conversations and sends as you, and runs after the press");

    // 2. It takes the bundled one's place in the code session's tab (the bundled one switched off, as a user would in the Plugins page).
    await rpc.request("plugin.setEnabled", { id: BUNDLED, enabled: false }, 30_000);
    switchedOff = true;
    await toSessionTab(ctx, chosen?.title ?? session);
    const doc = await until("the conversation copy's document in the code session's tab", 60_000, async () => (await layerDocs(cdp, COPY_ID))[0],
      async () => (await cdp.documents()).map((d) => d.url.slice(0, 70)).join(" || "));

    // 3. Its rows: a turn's words and reply show in the copy.
    const hello = `ACCEPTANCE-MIRROR-CONV-${randomBytes(3).toString("hex").toUpperCase()}`;
    const sent = await rpc.request<{ seq: number }>("session.send", { id: session, message: { text: `${hello} say hello`, clientMessageId: crypto.randomUUID() } }, 30_000);
    await until("the turn's end", 120_000, async () => ((await log()).some((e) => e.type === "turn_completed" && typeof e.seq === "number" && e.seq > sent.seq) ? true : undefined));
    await until("the user's words and the reply in the copy", 60_000, async () => {
      const t = await copyText(ctx);
      return t.includes(hello) && t.includes("ACCEPTANCE-REPLY-OK") ? true : undefined;
    }, async () => {
      const units: string[] = [];
      for (const d of await layerDocs(cdp, COPY_ID)) units.push(String(await cdp.evaluate(d.session, `[...document.querySelectorAll('[data-unit]')].map((e) => e.getAttribute('data-unit') + ':' + (e.textContent || '').slice(0, 40)).join(' | ') + ' vis=' + document.visibilityState`).catch(() => "?")));
      const ev = (await log()).slice(-8).map((e) => e.type === "turn_completed" || e.type === "error" || e.type === "agent_error" ? JSON.stringify(e).slice(0, 300) : `${String(e.type)}${typeof e.text === "string" ? `:${e.text.slice(0, 30)}` : ""}`).join(" ") + ` || session: ${JSON.stringify((await rpc.request<{ session: Record<string, unknown> }>("session.get", { id: session }).catch(() => ({ session: {} }))).session).slice(0, 400)}`;
      return `${(await copyText(ctx)).replace(/\s+/g, " ").slice(-200)} || units: ${units.join(" // ")} || log: ${ev} || refused: ${refusals().slice(-2).join(" | ")}`;
    });
    said.push(`the copy drew the code session's turn (${hello} and its reply) in its own document (${doc.url.slice(0, 40)}…)`);

    // 4. Try again, and the door's press rule on it: a bots' feature this round (a failed turn in a code session shows its error
    //    row with no Try again), so the MOSS unit's; what still holds here is that the door refused the copy nothing it holds.
    const away = partElsewhere("plugin-app", "4");
    if (away !== undefined) {
      const refused = refusals();
      if (refused.length > 0) fail(`the door refused the copy's calls: ${refused.slice(-3).join(" | ")}`);
      said.push(`the door refused the copy nothing; 4 and the press rule on its Try again run elsewhere (${away.owner === "MOSS" ? "lane MA's moss unit" : away.owner}): ${away.why}`);
      return said.join("; ");
    }
    // 4. Try again: a failed turn's error row in the copy; a page-made click sends nothing; one real click sends it again.
    const tag = `ACCEPTANCE-FAIL-${randomBytes(4).toString("hex").toUpperCase()}`;
    const words = `${tag} say hello again from the copy`;
    const mine = (events: Record<string, unknown>[]) => events.filter((e) => e.type === "user_message" && typeof e.text === "string" && e.text.includes(tag));
    await rpc.request("session.send", { id: session, message: { text: words, clientMessageId: crypto.randomUUID() } }, 30_000);
    const button = await until("Try again on the copy's error row", 120_000, async () => {
      for (const d of await layerDocs(cdp, COPY_ID)) {
        const c = await cdp.centerOf(d.session, RETRY, "Try again").catch(() => undefined);
        if (c !== undefined) return { session: d.session, c };
      }
      return undefined;
    }, async () => `${(await log()).slice(-5).map((e) => `${String(e.type)}${e.stopReason ? `:${String(e.stopReason)}` : ""}`).join(" ")} || ${(await copyText(ctx)).replace(/\s+/g, " ").slice(-200)}`);
    if (mine(await log()).length !== 1) fail(`the log holds ${mine(await log()).length} of the user's message before Try again, not 1`);
    ctx.healFake(tag.replace("ACCEPTANCE-FAIL-", ""));
    // The page's own click: no person's press behind it, so the door sends nothing.
    await cdp.evaluate(button.session, `(() => { const b = [...document.querySelectorAll('${RETRY}')].at(-1); b?.click(); return !!b; })()`).catch(() => undefined);
    await sleep(2_000);
    if (mine(await log()).length !== 1) fail("the copy sent the user's message again on a click the page made itself");
    // A press in another frame is not the copy's (F2, read 52): a real click in the copy gives its page the user's activation,
    // then a real click on the window's own root (another frame, or none) is the latest press; the copy's call right after it is
    // refused, though its page still holds the activation, and the app logs that the press was not in the copy's frame.
    const rootDoc = (await cdp.documents()).find((d) => d.url.startsWith("moss-core://app/") && !d.url.includes("?"));
    if (rootDoc === undefined) fail("no main window root to press on");
    const pressLines = () => ctx.appLog().split("\n").filter((l) => l.includes("press: a call from frame")).length;
    const linesBefore = pressLines();
    await cdp.click(button.session, 4, 4);
    await sleep(300);
    await cdp.click(rootDoc!.session, 2, 2);
    await cdp.evaluate(button.session, `(() => { const b = [...document.querySelectorAll('${RETRY}')].at(-1); b?.click(); return !!b; })()`).catch(() => undefined);
    await sleep(2_000);
    if (mine(await log()).length !== 1) fail("the copy sent the user's message again on a press that landed outside its frame");
    if (pressLines() <= linesBefore) fail("the app logged no refusal for the copy's call after a press in another frame");
    said.push("a real click in the copy and then one on the window's own root: the copy's call right after was refused (the latest press was not in its frame), and nothing was sent");
    await cdp.evaluate(button.session, `(() => { const b = [...document.querySelectorAll('${RETRY}')].at(-1); if (b) b.scrollIntoView({ block: "center" }); return !!b; })()`);
    await sleep(400);
    const there = await until("Try again still on the copy's screen", 10_000, async () => cdp.centerOf(button.session, RETRY, "Try again").catch(() => undefined));
    await cdp.click(button.session, there.x, there.y);
    await until("the turn's own reply in the copy", 150_000, async () => ((await copyText(ctx)).includes(`ACCEPTANCE-REPLY-OK ${tag}`) ? true : undefined),
      async () => `log: ${(await log()).slice(-6).map((e) => `${String(e.type)}${e.stopReason ? `:${String(e.stopReason)}` : ""}`).join(" ")}; door: ${ctx.appLog().split("\n").filter((l) => l.includes("session.resend")).slice(-3).join(" | ")}`);
    const again = mine(await log());
    if (again.length !== 2) fail(`the log holds ${again.length} of the user's message after Try again, not 2`);
    if (again[1]!.text !== again[0]!.text) fail("the message sent again is not the first, byte for byte");
    said.push("a failed turn showed Try again in the copy; a click the page made itself sent nothing; one real click sent the user's message again (session.resend through the door, by the copy's user.send) and the turn completed with its own reply");

    // The door's only refusal of the copy is the page's own click (no press of the user's behind it): never a capability or an id.
    const pressRule = refusals().filter((l) => l.includes("session.resend refused (no key press or click"));
    const refused = refusals().filter((l) => !pressRule.includes(l));
    if (pressRule.length === 0) fail("the door logged no refusal for the click the page made itself");
    if (refused.length > 0) fail(`the door refused the copy's calls: ${refused.slice(-3).join(" | ")}`);
    said.push("the door refused the copy only the page's own click (no press of the user's), and nothing for want of a capability");
    return said.join("; ");
  } finally {
    if (switchedOff) await rpc.request("plugin.setEnabled", { id: BUNDLED, enabled: true }, 30_000).catch(() => undefined);
    if (installed) {
      const rm = await rpc.request<{ card?: string }>("plugin.remove", { id: COPY_ID }).catch(() => undefined);
      if (rm?.card !== undefined) await ctx.approveCard(rm.card).catch(() => undefined);
      for (let i = 0; i < 30 && (await layerDocs(cdp, COPY_ID)).length > 0; i++) await sleep(300);
    }
    rmSync(join(ctx.root, COPY_ID), { recursive: true, force: true });
  }
}
