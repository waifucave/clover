// The SDK's two full examples (packages/plugin-sdk/examples), each a third-party plugin installed from its folder the
// user's way, in the window the UI steps drive. Together they prove what a third-party plugin gets, and what the rule
// between them costs:
//
// * example-notes stays inside (no network, no capability). Installed on the Plugins page (main's picker, which the run
//   points at its folder), its OK card names its cardless tools and nothing of a network; pressed, it runs with its
//   child bot (Notes keeper). On that bot: `add_note` (contained) and `list_notes` (readOnly) run with no card, and
//   `delete_note` cards; each tool row carries its title, and a result its display; the own-bot hook counts the bot's
//   turns only; the skill loads through Glossary; the agent definition starts on Clover's own agent with no card. The
//   composer's slash menu runs /note as the user. Its page (the sidebar's Notes entry, a TSX client) reads through its
//   host half and follows its own setting when the page's switch changes it, and when its control on the Plugins page
//   does (neither asks: the setting feeds nothing the plugin runs or reaches); the bot's tab skins the window. Turned off
//   on the Plugins page, its frames and its layer's connection go; removed on its sealed card, its folder and its synced
//   store go.
// * example-weather reaches outside (its own host, notifications). The run copies it and points its host at a local
//   site of its own (the run never reaches the real network). Its OK card names the host and the notifications, and
//   says its readOnly and contained tools still ask; its key goes in through the app's own key dialog; each tool call
//   cards; its forecast reaches the site through its proxy with that key; /rain-alert sends a notification (a headless
//   run shows none, and the app says so); muted on the Plugins page, the next alert is refused.
//
// Nothing here opens a window or reaches the network: the app runs headless, and the weather site listens on 127.0.0.1.
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Cdp } from "./cdp";
import type { CloverClient } from "./client";

export const EXAMPLE_NOTES_STEP = "example-notes (stays inside), from its folder on the Plugins page: its OK card names its cardless tools and no network; contained and readOnly tools run with no card, the other cards; hook, skill, agent definition, /note, its TSX page (host.call, its own setting changed with no card from the page and from the Plugins page), the bot's window skin, locales; turned off, then removed";
export const EXAMPLE_WEATHER_STEP = "example-weather (reaches outside), from its folder on the Plugins page: its OK card names its host and notifications and says its tools still ask; its key through the key dialog; each call cards; its forecast reaches its host through its proxy with that key; /rain-alert notifies, and is refused once muted on the Plugins page";

export const EXAMPLES = resolve(import.meta.dir, "..", "..", "packages", "plugin-sdk", "examples");

type Ev = Record<string, unknown> & { type?: string; seq?: number };
interface Card { id: string; kind: string; change?: string; session?: string; pluginId?: string }

export interface ExampleCtx {
  cdp: Cdp;
  rpc: CloverClient;
  /** The daemon's home (the plugin stores, the plugins' folders). */
  home: string;
  /** The run's temp folder (the weather copy goes here). */
  root: string;
  /** The user's home, where an agent's folder may be. */
  userHome: string;
  appLog(): string;
  requests(): { lastUserText: string; toolUse?: string; toolResult?: { text: string; isError: boolean; images?: number }; tools: string[] }[];
  /** The user's own `clover-core app <words>` (the target's CLI), where the run has it. */
  appCli?(words: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Points main's picker (the test build's) at a folder for the next pick. */
  pick(folder: string): void;
  /** Waits for a pending card `match` picks and presses its Approve in the window; its id. */
  pressCard(what: string, match: (card: Card) => boolean): Promise<string>;
  /** Approves a pending card over RPC, as the app's sealed frame does (the clean-up after a step, which no press may
   *  hang on: a card left from a failed turn can hold the island). */
  approveCard(id: string): Promise<void>;
  /** A turn whose cards are answered with "Always allow" over RPC (the browser row's kept answer); only the runs that need it give one. */
  alwaysTurn?: (session: string, text: string, ms?: number) => ReturnType<ExampleCtx["turn"]>;
  /** A turn that runs `inspect` while its card is pending (the island open), then presses the card as `turn` does; only the browser row's run gives one. */
  inspectTurn?: (session: string, text: string, ms: number, inspect: () => Promise<void>) => Promise<{ events: Ev[]; cards: string[]; changes: string[] }>;
  /** Answers a pending card no over RPC, as the app's sealed frame does (a step's clean-up of a card it left waiting). */
  denyCard(id: string): Promise<void>;
  /** Sends a message in a session and waits for the turn; its events and the cards it raised (answered yes over RPC). */
  turn(session: string, text: string, ms?: number): Promise<{ events: Ev[]; cards: string[]; changes: string[] }>;
  history(session: string): Promise<Ev[]>;
  /** The report the scripted model's child agent gives (fake-anthropic.ts CHILD_REPORT). */
  childReport: string;
}

class Failed extends Error {}
export const fail = (m: string): never => { throw new Failed(m); };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined> | T | undefined, dump?: () => Promise<string>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) fail(`${what}: not within ${Math.round(ms / 1000)} s${dump === undefined ? "" : ` (${await dump().catch(() => "?")})`}`);
    await sleep(400);
  }
}

/** The clover tree's documents (the shell, the sidebar, the Plugins page). */
// Alpha's own frames too: while her tab shows, her sidebar (not the stock one) is what the user presses.
export const treeDocs = async (cdp: Cdp) => (await cdp.documents()).filter((d) => d.url.startsWith("clover-plugin://clover/") || d.url.startsWith("clover-plugin://alpha"));
export const SIDEBAR_ITEMS = ".cl-sidebar button, .cl-sidebar a, .cl-sidebar [role=link], .as__row";
const layerDocs = async (cdp: Cdp, id: string) => (await cdp.documents()).filter((d) => d.url.startsWith(`clover-plugin://${id}/`));
const frames = async (cdp: Cdp) => (await cdp.documents()).map((d) => `${d.url.slice(0, 50)}: ${d.text.replace(/\s+/g, " ").slice(0, 80)}`).join(" || ");

async function clickIn(cdp: Cdp, what: string, docs: () => Promise<{ session: string }[]>, selector: string, text?: string, ms = 20_000): Promise<void> {
  const at = await until(what, ms, async () => {
    for (const d of await docs()) {
      const c = await cdp.centerOf(d.session, selector, text).catch(() => undefined);
      if (c !== undefined) return { session: d.session, c };
    }
    return undefined;
  }, () => frames(cdp));
  await cdp.click(at.session, at.c.x, at.c.y);
}
export const clickTree = (cdp: Cdp, what: string, selector: string, text?: string, ms?: number) => clickIn(cdp, what, () => treeDocs(cdp), selector, text, ms);

/** Clicks the element one of whose lines, or whose accessible name, is exactly `text` (the sidebar's Notes entry, beside
 *  Notes keeper; a bot's row, its initial on a line of its own). */
async function clickExact(cdp: Cdp, what: string, selector: string, text: string, ms = 20_000): Promise<void> {
  const at = await until(what, ms, async () => {
    for (const d of await treeDocs(cdp)) {
      const c = await cdp.evaluate(d.session, `(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => (e.innerText || '').split('\\n').some((l) => l.trim() === ${JSON.stringify(text)}) || e.getAttribute('aria-label') === ${JSON.stringify(text)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`).catch(() => null) as { x: number; y: number } | null;
      if (c !== null && c !== undefined) return { session: d.session, c };
    }
    return undefined;
  }, () => frames(cdp));
  await cdp.click(at.session, at.c.x, at.c.y);
}

async function escape(cdp: Cdp): Promise<void> {
  for (const d of await treeDocs(cdp)) for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, d.session).catch(() => undefined);
  await sleep(300);
}

/** The Plugins page from the sidebar, on a tab. */
async function pluginsPage(cdp: Cdp, tab: "Add" | "Installed"): Promise<void> {
  await escape(cdp);
  await clickTree(cdp, "the sidebar's Plugins entry", SIDEBAR_ITEMS, "Plugins");
  await until("the Plugins page's tabs", 15_000, async () => {
    for (const d of await treeDocs(cdp)) if ((await cdp.evaluate(d.session, "!!document.querySelector('.cl-plugin-index__tabs')").catch(() => false)) === true) return true;
    return undefined;
  });
  await clickTree(cdp, `the ${tab} tab`, "[role=tab]", tab);
}

/** Installs a folder through the Plugins page (Add, Choose a folder…, Install) and returns its OK card's id and text,
 *  read before it is pressed; then presses it in the window. */
export async function installFromPage(ctx: ExampleCtx, folder: string, id: string): Promise<{ card: string; text: string }> {
  const { cdp, rpc } = ctx;
  ctx.pick(folder);
  await pluginsPage(cdp, "Add");
  await clickTree(cdp, "Choose a folder…", "button", "Choose a folder");
  const name = folder.split("/").pop()!;
  await until(`the chosen folder's name (${name})`, 15_000, async () => {
    for (const d of await treeDocs(cdp)) if (String(await cdp.evaluate(d.session, "document.body.innerText").catch(() => "")).includes(`Chosen: ${name}`)) return true;
    return undefined;
  });
  await clickTree(cdp, `Install ${name}`, "button", `Install ${name}`);
  const card = await until(`${id}'s OK card`, 60_000, async () => (await rpc.request<{ cards: Card[] }>("card.list")).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === id));
  const text = JSON.stringify((await rpc.request<{ card: unknown }>("card.get", { id: card.id })).card);
  await ctx.pressCard(`${id}'s OK card`, (c) => c.id === card.id);
  await until(`${id} running after its OK`, 60_000, async () => ((await stateOf(rpc, id)) === "running" ? true : undefined));
  return { card: card.id, text };
}

const stateOf = async (rpc: CloverClient, id: string) => (await rpc.request<{ plugin: { state: string } }>("plugin.get", { id }).catch(() => undefined))?.plugin.state;

/** Opens a plugin's detail on the Plugins page (Installed → its row's Open). */
async function openDetail(cdp: Cdp, name: string): Promise<void> {
  await pluginsPage(cdp, "Installed");
  await clickTree(cdp, `Open ${name}`, `button[aria-label=${JSON.stringify(`Open ${name}`)}]`);
}

/** Turns a plugin off on its detail, and removes it on its sealed card. */
async function turnOffAndRemove(ctx: ExampleCtx, id: string, name: string): Promise<string> {
  const { cdp, rpc } = ctx;
  await openDetail(cdp, name);
  await clickTree(cdp, "Turn off", "button", "Turn off");
  await until(`${id} off`, 20_000, async () => ((await stateOf(rpc, id)) === "off" ? true : undefined));
  await clickTree(cdp, "Remove…", "button", "Remove");
  const removal = await ctx.pressCard(`${id}'s removal card`, (c) => c.kind === "change" && c.change === "plugin-remove");
  await until(`${id} removed`, 30_000, async () => ((await rpc.request("plugin.get", { id }).then(() => false, () => true)) ? true : undefined));
  return removal;
}

/** One turn on a session: its one tool call (the fake's ACCEPTANCE-CALL) and its result, and the cards it raised. */
export async function callTurn(ctx: ExampleCtx, session: string, tool: string, input: Record<string, unknown>, opts: { always?: boolean } = {}): Promise<{ called: string; result: { text: string; isError: boolean }; cards: string[]; changes: string[]; events: Ev[] }> {
  const seen = ctx.requests().length;
  // A directive inside the input (an agent's brief, `ACCEPTANCE-CHILD …`) is written as JSON's escape, so the fake reads
  // the line's newest directive as this call, and the tool still gets the words (JSON.parse undoes it).
  const text = `ACCEPTANCE-CALL ${tool} ${JSON.stringify(input).replace(/ACCEPTANCE-/g, "ACCEPTANCE\\u002D")}`;
  const t = opts.always === true ? await (ctx.alwaysTurn ?? fail("this run has no turn that answers a card with Always allow"))(session, text, 150_000) : await ctx.turn(session, text, 150_000);
  const mine = ctx.requests().slice(seen);
  const called = mine.map((r) => r.toolUse).filter((x): x is string => x !== undefined).find((x) => x === tool || x.endsWith(`__${tool}`));
  const result = mine.map((r) => r.toolResult).filter((x): x is { text: string; isError: boolean } => x !== undefined).at(-1);
  const said = () => `events: ${[...new Set(t.events.map((e) => String(e.type)))].join(", ") || "none"}; errors: ${t.events.filter((e) => /error/.test(String(e.type)) || e.stopReason === "error").map((e) => String(e.message ?? e.error ?? e.text ?? JSON.stringify(e)).slice(0, 200)).join(" | ") || "none"}; ${mine.length} request(s) reached the model`;
  if (called === undefined) fail(`no ${tool} was called (offered: ${(mine.find((r) => r.tools.length > 0)?.tools ?? []).filter((x) => x.endsWith(`__${tool}`) || x === tool).join(", ") || "not it"}; ${said()})`);
  if (result === undefined) fail(`${called} gave no result (cards: ${t.cards.join("; ") || "none"})`);
  return { called: called!, result: result!, cards: t.cards, changes: t.changes, events: t.events };
}

const storeOf = (home: string, id: string): Record<string, unknown> => {
  try { return JSON.parse(readFileSync(join(home, "settings", "plugin-stores", `${id}.json`), "utf8")) as Record<string, unknown>; } catch { return {}; }
};

/** The notes step. */
export async function exampleNotesStep(ctx: ExampleCtx, otherSession: string): Promise<string> {
  try {
    return await notesSteps(ctx, otherSession);
  } finally {
    await leave(ctx, "example-notes");
  }
}

/** Takes a plugin out after its step, whatever happened (its removal card answered over RPC), so no step after it runs
 *  with it installed. */
export async function leave(ctx: ExampleCtx, id: string): Promise<void> {
  const { rpc } = ctx;
  if ((await stateOf(rpc, id)) === undefined) return;
  const r = await rpc.request<{ card?: string }>("plugin.remove", { id }).catch(() => undefined);
  if (r?.card !== undefined) await ctx.approveCard(r.card).catch(() => undefined);
  await until(`${id} removed`, 30_000, async () => ((await stateOf(rpc, id)) === undefined ? true : undefined)).catch(() => undefined);
}

async function notesSteps(ctx: ExampleCtx, otherSession: string): Promise<string> {
  const { cdp, rpc, home } = ctx;
  const id = "example-notes";
  const folder = join(EXAMPLES, id);
  if (existsSync(join(folder, "node_modules"))) fail("the example ships a node_modules; it must lean on the layer's import map");
  const done: string[] = [];
  // Installed exactly as its author wrote it: the folder as it ships, its client TSX (the registry builds it after the
  // user's OK, and the app serves the built module from the plugin's own layer, loading its frames again once built).

  // 1. Installed the user's way; its OK card read before it is pressed.
  const ok = await installFromPage(ctx, folder, id);
  const wantLines = [
    "this tool only reads, so at the default approval level it runs without asking: list_notes",
    "this tool only changes its own display, so at the default level it runs without asking: add_note",
    "Its code reaches no host.",
    "Its hooks run when its own bot's turns start, end or are compacted, and see no other bot",
    "It styles the window while its tab shows.",
  ];
  const missing = wantLines.filter((l) => !ok.text.includes(l));
  if (missing.length > 0) fail(`its OK card lacks: ${missing.join(" | ")} (card: ${ok.text.slice(0, 600)})`);
  const extra = /network|still asks|notifications|any host/i.exec(ok.text);
  if (extra !== null) fail(`its OK card says "${ok.text.slice(Math.max(0, extra.index - 60), extra.index + 60)}", but the plugin stays inside`);
  done.push(`installed from its folder on the Plugins page; its OK card ${ok.card} named its cardless tools and no network, pressed`);

  // 2. Its child bot is up.
  const bot = await until("Notes keeper in bot.list", 60_000, async () => (await rpc.request<{ bots: { id: string; name?: string; mainSession?: string }[] }>("bot.list", {})).bots.find((b) => (b.id === `${id}/bot` || b.name === "Notes keeper") && b.mainSession !== undefined));
  const session = bot.mainSession!;
  const turnsBefore = Number(storeOf(home, id).turns ?? 0);
  let notesTurns = 0;

  // 3. Its tools, on its bot: contained and readOnly with no card, the third with a card; the tool rows' titles and a
  //    result's display (the core's display seam). Notes keeper's first turn asks once before it spends the provider
  //    its plugin chose (`bot-provider`, a third party's model choice: provider-consent.ts); that is the only card.
  const added = await callTurn(ctx, session, "add_note", { text: "Buy oat milk" }); notesTurns++;
  if (added.changes.join() !== "bot-provider") fail(`Notes keeper's first turn raised ${added.changes.join(", ") || "no change card"}, not one bot-provider card (its plugin chose its model)`);
  if (added.cards.length !== 1) fail(`add_note (contained) raised ${added.cards.join("; ")} at the default level, besides the provider's card`);
  if (added.result.isError || !added.result.text.includes("Noted: Buy oat milk")) fail(`add_note answered "${added.result.text.slice(0, 120)}"`);
  const second = await callTurn(ctx, session, "add_note", { text: "Water the plants" }); notesTurns++;
  if (second.cards.length > 0) fail(`the second add_note raised ${second.cards.join("; ")}`);
  const listed = await callTurn(ctx, session, "list_notes", {}); notesTurns++;
  if (listed.cards.length > 0) fail(`list_notes (readOnly) raised ${listed.cards.join("; ")} at the default level`);
  if (!listed.result.text.includes("Buy oat milk") || !listed.result.text.includes("Water the plants")) fail(`list_notes answered "${listed.result.text.slice(0, 200)}"`);
  const deleted = await callTurn(ctx, session, "delete_note", { handle: "n2" }); notesTurns++;
  if (deleted.cards.length === 0) fail("delete_note (on neither list) ran with no card");
  if (deleted.result.isError || !deleted.result.text.includes("Deleted: Water the plants")) fail(`delete_note, after its card's yes, answered "${deleted.result.text.slice(0, 120)}"`);
  const notesNow = (storeOf(home, id).notes ?? []) as { text: string }[];
  if (notesNow.map((n) => n.text).join("|") !== "Buy oat milk") fail(`its store holds ${JSON.stringify(notesNow).slice(0, 200)}, not the one note left`);
  const evs = await ctx.history(session);
  const call = evs.find((e) => e.type === "tool_call" && String(e.name).endsWith("__add_note"));
  const res = evs.find((e) => e.type === "tool_result" && e.callId === call?.callId);
  if (call?.displayTitle !== "Add a note") fail(`add_note's tool_call carries displayTitle ${JSON.stringify(call?.displayTitle)}, not "Add a note"`);
  if (JSON.stringify(res?.display) !== JSON.stringify({ kind: "note", label: "Noted", value: "Buy oat milk" })) fail(`add_note's tool_result carries display ${JSON.stringify(res?.display)}`);
  done.push(`add_note and list_notes ran with no card, delete_note on its card (${deleted.cards[0]}); the store holds the one note left; the row's title "Add a note" and its display {note, Noted, Buy oat milk}`);

  // 4. Its skill, through Glossary; its agent definition, on Clover's own agent with no card, its report back.
  const skill = await callTurn(ctx, session, "Glossary", { load: `${id}:tidy-up` }); notesTurns++;
  if (!skill.result.text.includes(`<skill name="${id}:tidy-up">`)) fail(`Glossary didn't load the skill: ${skill.result.text.slice(0, 200)}`);
  const computer = (await rpc.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
  if (computer === undefined) fail("computer.list lists no computer");
  mkdirSync(join(ctx.userHome, "notes-tidy"), { recursive: true });
  writeFileSync(join(ctx.userHome, "notes-tidy", "notes.md"), "Buy oat milk\nbuy oat milk\nWater the plants\n");
  const agent = await callTurn(ctx, session, "Agent", { agent: `${id}:tidier`, backend: "clover-code", root: `home/${computer}/notes-tidy`, description: "Tidy notes", prompt: "ACCEPTANCE-CHILD: tidy the notes and say you're done." }); notesTurns++;
  if (agent.cards.length > 0) fail(`Agent with ${id}:tidier on clover-code raised ${agent.cards.join("; ")}`);
  if (agent.result.isError || !agent.result.text.includes(`with ${id}'s agent definition tidier`)) fail(`Agent didn't start with the definition: ${agent.result.text.slice(0, 200)}`);
  const row = await until("the tidier's session row", 30_000, async () => (await rpc.request<{ sessions: { id: string; backend?: string; definition?: string }[] }>("session.list", { kinds: ["agent"] }).catch(() => ({ sessions: [] }))).sessions.find((s) => s.definition === `${id}:tidier`), undefined);
  await until("the tidier's report in Notes keeper's conversation", 120_000, async () => (JSON.stringify(await ctx.history(session).catch(() => [])).includes(ctx.childReport) ? true : undefined));
  done.push(`the skill loaded through Glossary; Agent started ${id}:tidier on ${row.backend} with no card and its report came back`);

  // 5. The command from the composer's slash menu, as the user: nothing of it reaches a bot.
  const tag = `Call the plumber ${randomBytes(2).toString("hex")}`;
  const ran = await slashCommand(ctx, "note", tag, "Notes", "Notes keeper");
  if (!ran.includes(`Noted: ${tag}`)) fail(`/note answered "${ran.slice(0, 120)}"`);
  if (ctx.requests().some((r) => r.lastUserText.includes(tag))) fail("the /note line reached the model");
  done.push(`/note ran from the slash menu: "${ran.slice(0, 60)}"`);

  // 6. The hook (turn.end, own-bot): at least one count per Notes keeper turn (the agent it started, and the turn its
  //    report wakes, are its own too); a turn of another bot's moves nothing, and one more of its own moves it by one.
  const countNow = () => Number(storeOf(home, id).turns ?? 0);
  const settled = await until("the hook's count to settle", 30_000, async () => {
    const a = countNow();
    await sleep(1_500);
    return a - turnsBefore >= notesTurns && countNow() === a ? a : undefined;
  }).catch(() => fail(`the own-bot hook counted ${countNow() - turnsBefore} turns, fewer than Notes keeper's ${notesTurns}`));
  await ctx.turn(otherSession, `ACCEPTANCE-TAG-${randomBytes(3).toString("hex").toUpperCase()} hello`, 150_000);
  await sleep(2_000);
  if (countNow() !== settled) fail(`another bot's turn moved the own-bot hook's count (${settled} -> ${countNow()})`);
  await ctx.turn(session, `ACCEPTANCE-TAG-${randomBytes(3).toString("hex").toUpperCase()} hello`, 150_000);
  const turns = await until("one more count for one more turn of its own", 20_000, () => (countNow() === settled + 1 ? countNow() : undefined))
    .catch(() => fail(`one more Notes keeper turn moved the count from ${settled} to ${countNow()}`));
  done.push(`its own-bot hook counted Notes keeper's turns (${settled - turnsBefore} for its ${notesTurns} and its agent's), none for another bot's, then one more for one more`);

  // 7. Its page: the sidebar's Notes entry; the notes read through its host half, in its locale's words, newest first;
  //    the page's switch writes its setting, and the page follows only once the core says the setting changed.
  await escape(cdp);
  await clickExact(cdp, "the sidebar's Notes entry", SIDEBAR_ITEMS, "Notes");
  const page = await until("its page in a frame of its own layer, its notes read", 30_000, async () => {
    for (const d of await layerDocs(cdp, id)) {
      const v = await cdp.evaluate(d.session, "(() => { const p = document.querySelector('[data-notes=page]'); return p && p.getAttribute('data-loaded') === 'true' ? JSON.stringify({ order: p.getAttribute('data-order'), turns: p.getAttribute('data-turns'), notes: [...p.querySelectorAll('[data-note]')].map((e) => e.getAttribute('data-note')), title: (p.querySelector('h1') || {}).textContent, text: p.innerText }) : null; })()").catch(() => null);
      if (typeof v === "string") return { session: d.session, ...(JSON.parse(v) as { order: string; turns: string; notes: string[]; title: string; text: string }) };
    }
    return undefined;
  }, () => frames(cdp));
  if (page.notes[0] !== tag || page.notes[1] !== "Buy oat milk" || page.notes.length !== 2) fail(`the page lists ${JSON.stringify(page.notes)}, not the newest first`);
  if (page.title !== "Notes" || !page.text.includes("2 notes") || /example-notes\./.test(page.text)) fail(`the page's words aren't its locale's: "${page.text.slice(0, 160)}"`);
  if (Number(page.turns) !== turns) fail(`the page shows ${page.turns} turns, the store ${turns}`);
  if (!ctx.appLog().includes(`layers: ${id}'s layer connected to the core`)) fail("its layer has no connection of its own");
  const order = await cdp.centerOf(page.session, "[data-notes=order]");
  if (order === undefined) fail("the page has no order switch");
  await cdp.click(page.session, order!.x, order!.y);
  const flipped = await until("the page to follow its setting", 20_000, async () => {
    const v = JSON.parse(String(await cdp.evaluate(page.session, "JSON.stringify({ o: document.querySelector('[data-notes=page]').getAttribute('data-order'), n: [...document.querySelectorAll('[data-note]')].map((e) => e.getAttribute('data-note')) })"))) as { o: string; n: string[] };
    return v.o === "oldest" ? v : undefined;
  });
  if (flipped.n[0] !== "Buy oat milk") fail(`after the switch the page lists ${JSON.stringify(flipped.n)}, not the oldest first`);
  const stored = (await rpc.request<{ settings: { key: string; value?: unknown }[] }>("plugin.settings.get", { id })).settings.find((s) => s.key === "order")?.value;
  if (stored !== "oldest") fail(`the switch didn't reach its setting (it is ${JSON.stringify(stored)})`);
  done.push(`its page (TSX, its own layer) listed the notes newest first in its locale's words with the hook's count; its switch set the order with no card and the page followed`);

  // 7b. The same setting from the Plugins page: its detail's control (a choice, in the manifest's words), changed by the
  //     user with no card (it feeds nothing the plugin runs or reaches); the Notes page, opened again, follows.
  const cardsBefore = new Set((await rpc.request<{ cards: Card[] }>("card.list")).cards.map((c) => c.id));
  await openDetail(cdp, "Notes");
  const control = await until("the order setting's control on its detail", 15_000, async () => {
    for (const d of await treeDocs(cdp)) {
      const v = await cdp.evaluate(d.session, "(() => { const li = document.querySelector('[data-setting=order]'); const s = li && li.querySelector('select'); return s ? JSON.stringify({ value: s.value, label: s.getAttribute('aria-label'), options: [...s.options].map((o) => o.textContent), text: li.innerText }) : null; })()").catch(() => null);
      if (typeof v === "string") return { session: d.session, ...(JSON.parse(v) as { value: string; label: string; options: string[]; text: string }) };
    }
    return undefined;
  }, () => frames(cdp));
  if (control.value !== "oldest" || control.label !== "Order on the page" || control.options.join("|") !== "Newest first|Oldest first") fail(`the detail's control reads ${JSON.stringify(control)}`);
  if (/asks you first/.test(control.text)) fail("the detail says changing the order asks first, though it feeds nothing the plugin runs");
  // The user's key press on the control (main's gesture record), then the choice.
  await cdp.evaluate(control.session, "(() => { document.querySelector('[data-setting=order] select').focus(); return true; })()");
  for (const type of ["rawKeyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 }, control.session);
  await cdp.evaluate(control.session, "(() => { const s = document.querySelector('[data-setting=order] select'); s.value = 'newest'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  const orderNow = async () => (await rpc.request<{ settings: { key: string; value?: unknown }[] }>("plugin.settings.get", { id })).settings.find((s) => s.key === "order")?.value;
  await until("the Plugins page's choice in its setting", 15_000, async () => ((await orderNow()) === "newest" ? true : undefined), async () => `it is ${JSON.stringify(await orderNow())}; the page says ${String(await cdp.evaluate(control.session, "(document.querySelector('.cl-plugin-index__status') || {}).innerText || 'nothing'").catch(() => "?"))}`);
  const carded = (await rpc.request<{ cards: Card[] }>("card.list")).cards.filter((c) => !cardsBefore.has(c.id));
  if (carded.length > 0) fail(`changing the order on the Plugins page raised ${carded.map((c) => `${c.kind}${c.change ? ` (${c.change})` : ""}`).join(", ")}`);
  await escape(cdp);
  await clickExact(cdp, "the sidebar's Notes entry", SIDEBAR_ITEMS, "Notes");
  const again = await until("its page again, newest first", 30_000, async () => {
    for (const d of await layerDocs(cdp, id)) {
      const v = await cdp.evaluate(d.session, "(() => { const p = document.querySelector('[data-notes=page]'); return p && p.getAttribute('data-loaded') === 'true' && p.getAttribute('data-order') === 'newest' ? JSON.stringify([...p.querySelectorAll('[data-note]')].map((e) => e.getAttribute('data-note'))) : null; })()").catch(() => null);
      if (typeof v === "string") return JSON.parse(v) as string[];
    }
    return undefined;
  }, () => frames(cdp));
  if (again[0] !== tag) fail(`after the Plugins page's change the page lists ${JSON.stringify(again)}, not the newest first`);
  done.push("the order changed again from its control on the Plugins page (Newest first), with no card, and its page followed");

  // 8. The window's skin while Notes keeper's tab shows, and not on another tab.
  await escape(cdp);
  await clickTree(cdp, "Notes keeper in the sidebar", SIDEBAR_ITEMS, "Notes keeper");
  const skin = await until("the window's skin for Notes keeper's tab", 20_000, async () => {
    for (const d of await treeDocs(cdp)) {
      const v = await cdp.evaluate(d.session, "(() => { const w = document.querySelector('.cl-window'); return w ? JSON.stringify({ skin: w.getAttribute('data-skin') || '', bar: w.style.getPropertyValue('--cl-skin-bar-text').trim() }) : null; })()").catch(() => null);
      if (typeof v === "string") {
        const o = JSON.parse(v) as { skin: string; bar: string };
        if (o.skin.includes("sidebar") && ["#2B2618", "#F3EDDD"].includes(o.bar.toUpperCase())) return o;
      }
    }
    return undefined;
  }, async () => String((await Promise.all((await treeDocs(cdp)).map((d) => cdp.evaluate(d.session, "(() => { const w = document.querySelector('.cl-window'); return w ? (w.getAttribute('data-skin') || 'none') + ' ' + w.style.getPropertyValue('--cl-skin-bar-text') : ''; })()").catch(() => "")))).join(" ")));
  done.push(`Notes keeper's tab skinned the window (${skin.skin}; bar text ${skin.bar})`);

  // 9. Turned off on the Plugins page: its frames and its layer's connection go, and its bot. Removed on its sealed
  //    card: its folder and its synced store go.
  const closedBefore = (ctx.appLog().match(new RegExp(`layers: ${id}'s layer connection closed`, "g")) ?? []).length;
  await openDetail(cdp, "Notes");
  await clickTree(cdp, "Turn off", "button", "Turn off");
  await until(`${id} off`, 20_000, async () => ((await stateOf(rpc, id)) === "off" ? true : undefined));
  await until("its frames out of the window", 20_000, async () => ((await layerDocs(cdp, id)).length === 0 ? true : undefined), () => frames(cdp));
  await until("its layer's connection closed", 15_000, async () => ((ctx.appLog().match(new RegExp(`layers: ${id}'s layer connection closed`, "g")) ?? []).length > closedBefore ? true : undefined));
  const botsOff = (await rpc.request<{ bots: { id: string }[] }>("bot.list", {})).bots.map((b) => b.id);
  if (botsOff.includes(`${id}/bot`)) fail("Notes keeper is still a bot while its plugin is off");
  await clickTree(cdp, "Remove…", "button", "Remove");
  const removal = await ctx.pressCard(`${id}'s removal card`, (c) => c.kind === "change" && c.change === "plugin-remove");
  await until(`${id} removed`, 30_000, async () => ((await rpc.request("plugin.get", { id }).then(() => false, () => true)) ? true : undefined));
  if (existsSync(join(home, "plugins", id))) fail(`its folder is still there after removal (${join(home, "plugins", id)})`);
  // Its store goes with it, as its removal card says, so a later plugin under the same id inherits nothing
  // (leftovers.ts `forgetRemovedPlugin`; a data folder would be set aside, and Notes keeps none).
  if (existsSync(join(home, "settings", "plugin-stores", `${id}.json`))) fail("its synced store is still there after removal (a later plugin under its id would inherit it)");
  done.push(`turned off: its frames and its layer's connection closed, Notes keeper gone; removed on its sealed card ${removal}: its folder and its synced store gone`);
  return done.join("; ");
}

/** Runs `/<name> <arg>` from the composer's slash menu (a click on its row, the user's gesture) in `bot`'s conversation
 *  (opened from the sidebar first: the composer is a conversation's); the result row's text. */
async function slashCommand(ctx: ExampleCtx, name: string, arg: string, pluginName: string, bot: string): Promise<string> {
  const { cdp } = ctx;
  await escape(cdp);
  await clickExact(cdp, `${bot} in the sidebar`, SIDEBAR_ITEMS, bot);
  // The composer of that bot's conversation (its box is labelled "Message to <bot>"), once the switch has settled: a
  // box the old view still shows would lose what is typed into it.
  const label = `Message to ${bot}`;
  const box = await until(`${bot}'s composer`, 20_000, async () => {
    for (const d of await treeDocs(cdp)) if ((await cdp.evaluate(d.session, `(document.querySelector('.cl-composer textarea') || {}).getAttribute?.('aria-label') === ${JSON.stringify(label)}`).catch(() => false)) === true) return d.session;
    return undefined;
  }, () => frames(cdp));
  await sleep(500);
  // A click in the box first, as the user would: after the app's own key dialog the window's focus is still in the app's
  // page, and text typed then never reaches the composer.
  const at = await cdp.centerOf(box, ".cl-composer textarea");
  if (at === undefined) fail("the composer's text box has no place on the page");
  await cdp.click(box, at!.x, at!.y);
  await cdp.evaluate(box, "(() => { const t = document.querySelector('.cl-composer textarea'); t.focus(); t.select(); return true; })()");
  await cdp.send("Input.insertText", { text: "/" }, box);
  const listShown = async () => String(await cdp.evaluate(box, "(document.querySelector('.cl-composer__slash') || {}).innerText || 'no list'").catch(() => "gone")).replace(/\s+/g, " ").slice(0, 300);
  await until(`the slash menu's /${name}`, 15_000, async () => {
    const rows = JSON.parse(String(await cdp.evaluate(box, "JSON.stringify([...document.querySelectorAll('.cl-composer__slash [role=option]')].map((e) => (e.innerText || '').replace(/\\s+/g, ' ').trim()))"))) as string[];
    return rows.some((t) => t.startsWith(`/${name}`) && t.includes(pluginName)) ? true : undefined;
  }, listShown);
  await cdp.send("Input.insertText", { text: `${name} ${arg}` }, box);
  await sleep(300);
  const typed = String(await cdp.evaluate(box, "document.querySelector('.cl-composer textarea').value").catch(() => "?"));
  if (typed !== `/${name} ${arg}`) fail(`the composer holds "${typed.slice(0, 80)}", not the line typed (/${name} ${arg})`);
  const item = await cdp.centerOf(box, ".cl-composer__slash-item", `/${name}`);
  if (item === undefined) fail(`the menu has no /${name} row after typing (${await listShown()})`);
  await cdp.click(box, item!.x, item!.y);
  const result = await until(`/${name}'s result by the composer`, 20_000, async () => {
    const r = (await cdp.evaluate(box, "(() => { const e = document.querySelector('.cl-composer__slash-result'); return e ? { t: (e.innerText || '').replace(/\\s+/g, ' ').trim(), refused: e.hasAttribute('data-refused') } : null; })()")) as { t: string; refused: boolean } | null;
    return r !== null && r !== undefined && r.t !== "" ? r : undefined;
  }, listShown);
  if (result.refused) fail(`/${name} was refused: ${result.t}`);
  // The result row stays until the next line: clear it for the next run.
  await escape(cdp);
  return result.t;
}

/** A local site standing in for the weather service: answers a forecast only with the run's key. */
export function weatherSite(key: string): { port: number; hits: { place: string; keyed: boolean }[]; stop(): void } {
  const hits: { place: string; keyed: boolean }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname !== "/v1/forecast") return new Response("not here", { status: 404 });
      const keyed = req.headers.get("x-api-key") === key;
      hits.push({ place: u.searchParams.get("place") ?? "", keyed });
      if (!keyed) return new Response("no", { status: 401 });
      return Response.json({ summary: "Light rain", tempC: 14 });
    },
  });
  return { port: server.port!, hits, stop: () => server.stop(true) };
}

/** The weather step. */
export async function exampleWeatherStep(ctx: ExampleCtx, session: string): Promise<string> {
  const { cdp, rpc, root } = ctx;
  const id = "example-weather";
  const key = `weather-key-${randomBytes(8).toString("hex")}`;
  const site = weatherSite(key);
  const done: string[] = [];
  try {
    // Its copy, pointed at the run's site instead of api.example.com (the run never reaches the real network).
    const folder = join(root, "examples", id);
    cpSync(join(EXAMPLES, id), folder, { recursive: true });
    const manifest = readFileSync(join(folder, "clover.json"), "utf8");
    writeFileSync(join(folder, "clover.json"), manifest.replace("https://api.example.com/v1", `http://localhost:${site.port}/v1`).replace("network:api.example.com", `network:localhost:${site.port}`));

    // 1. Installed the user's way; its card names the host and the notifications, and says its two lists still ask.
    const ok = await installFromPage(ctx, folder, id);
    const wantLines = [
      `localhost:${site.port}`,
      "It sends you notifications",
      "Its server forecast says one tool only reads, but it can reach the network, so it still asks before running",
      "Its server forecast says one tool only changes its own display, but it can reach the network or do more than read Clover's state, so it still asks before running",
    ];
    const missing = wantLines.filter((l) => !ok.text.includes(l));
    if (missing.length > 0) fail(`its OK card lacks: ${missing.join(" | ")} (card: ${ok.text.slice(0, 600)})`);
    if (ok.text.includes("runs without asking")) fail("its OK card says a tool runs without asking, though the plugin reaches the network");
    done.push(`installed from its folder on the Plugins page; its OK card ${ok.card} named localhost:${site.port}, its notifications and that its readOnly and contained tools still ask, pressed`);

    // 2. Its key, through the app's own key dialog (Plugins page → Weather → Enter key…), never a field of a page.
    await openDetail(cdp, "Weather");
    await clickTree(cdp, "its key's Enter key…", "button", "Enter key");
    const appRoot = await until("the app's key dialog", 15_000, async () => {
      for (const d of await cdp.documents()) if (d.url === "clover-core://app/" && (await cdp.evaluate(d.session, "!!document.querySelector('[data-clover-key-field]')").catch(() => false)) === true) return d;
      return undefined;
    });
    await cdp.evaluate(appRoot.session, "(() => { const f = document.querySelector('[data-clover-key-field]'); f.focus(); return true; })()");
    await cdp.send("Input.insertText", { text: key }, appRoot.session);
    await sleep(700); // the dialog takes a press only once it has been seen a moment
    const save = await cdp.centerOf(appRoot.session, "[data-clover-key-save]");
    if (save === undefined) fail("the key dialog has no Save");
    await cdp.click(appRoot.session, save!.x, save!.y);
    await until("the key dialog to say the key is set", 15_000, async () => ((await cdp.evaluate(appRoot.session, "(document.querySelector('[data-clover-key-state]') || {}).getAttribute?.('data-clover-key-state')").catch(() => "")) === "set" ? true : undefined));
    const close = await cdp.centerOf(appRoot.session, ".clover-page__close");
    if (close !== undefined) await cdp.click(appRoot.session, close.x, close.y);
    await sleep(600);
    const keySet = (await rpc.request<{ settings: { key: string; set?: boolean; value?: unknown }[] }>("plugin.settings.get", { id })).settings.find((s) => s.key === "WEATHER_KEY");
    if (keySet?.set !== true) fail(`the key dialog's Save didn't set WEATHER_KEY (${JSON.stringify(keySet)})`);
    if (JSON.stringify(keySet).includes(key)) fail("plugin.settings.get handed the key back");
    done.push("its key went in through the app's key dialog");

    // 3. Each call cards (readOnly and contained don't hold for a plugin that reaches the network); the forecast reaches
    //    its host through its proxy, with the key, which never shows in an answer.
    const saved = await callTurn(ctx, session, "save_place", { place: "Lisbon" });
    if (saved.cards.length === 0) fail("save_place (contained, on a networked plugin) ran with no card");
    if (saved.result.isError || !saved.result.text.includes("Saved your place: Lisbon")) fail(`save_place answered "${saved.result.text.slice(0, 120)}"`);
    const fc = await callTurn(ctx, session, "forecast", {});
    if (fc.cards.length === 0) fail("forecast (readOnly, on a networked plugin) ran with no card");
    if (fc.result.isError || !fc.result.text.includes("Forecast for Lisbon: Light rain, 14°C")) fail(`forecast answered "${fc.result.text.slice(0, 160)}" (the site saw ${JSON.stringify(site.hits)})`);
    if (!site.hits.some((h) => h.place === "Lisbon" && h.keyed)) fail(`the site saw no keyed forecast for Lisbon (${JSON.stringify(site.hits)})`);
    if (ctx.requests().some((r) => (r.toolResult?.text ?? "").includes(key))) fail("the key reached the model in a tool's answer");
    done.push(`save_place and forecast each raised a card (${saved.cards[0]}; ${fc.cards[0]}); the forecast reached localhost:${site.port} through its proxy with the key (${site.hits.length} hit(s)), and the key reached no answer`);

    // 4. /rain-alert from the slash menu: a notification, which a headless run doesn't show (the app says so).
    const shownLine = /notify: a headless run shows no notification \(([^)]*)\)/g;
    const before = [...ctx.appLog().matchAll(shownLine)].length;
    const sent = await slashCommand(ctx, "rain-alert", "Lisbon", "Weather", "Alpha");
    if (!sent.includes("Rain alert sent for Lisbon")) fail(`/rain-alert answered "${sent.slice(0, 160)}"`);
    // On a miss, what the desktop notifier said of it (its own log: never the notification's words).
    const notifierLog = async () => `the desktop notifier's log: ${((await rpc.request<{ lines: string[] }>("plugin.logs", { id: "clover/notifications", lines: 12 }).catch(() => ({ lines: ["(unreadable)"] }))).lines.join(" | ") || "empty")}`;
    await until("the app to be asked to show the alert", 15_000, async () => ([...ctx.appLog().matchAll(shownLine)].length > before ? true : undefined), notifierLog);
    done.push(`/rain-alert sent a notification (the headless app showed none and said so)`);

    // 5. Muted on its detail, the next alert is refused and nothing reaches the app.
    await openDetail(cdp, "Weather");
    await clickTree(cdp, "its notifications switch", `button[role=switch][aria-label=${JSON.stringify("Weather's notifications")}]`);
    await until(`${id} muted`, 15_000, async () => ((await rpc.request<{ muted: string[] }>("notify.mutes", {}).catch(() => ({ muted: [] as string[] }))).muted.includes(id) ? true : undefined));
    const mutedAt = [...ctx.appLog().matchAll(shownLine)].length;
    const refused = await slashCommand(ctx, "rain-alert", "Lisbon", "Weather", "Alpha");
    if (!/muted/.test(refused)) fail(`/rain-alert while muted answered "${refused.slice(0, 160)}"`);
    await sleep(1_500);
    if ([...ctx.appLog().matchAll(shownLine)].length > mutedAt) fail("a muted plugin's notification still reached the app");
    done.push(`muted on the Plugins page, the next alert was refused ("${refused.slice(0, 80)}")`);

    // 6. Removed (its card), for the steps after.
    const removal = await turnOffAndRemove(ctx, id, "Weather");
    done.push(`turned off and removed on its sealed card ${removal}`);
    return done.join("; ");
  } finally {
    site.stop();
    await rpc.request("notify.setMuted", { pluginId: id, muted: false }).catch(() => undefined);
    await leave(ctx, id);
  }
}

export { Failed as ExampleFailed };
