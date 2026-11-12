// The workshop row: the path the owner tries first. Alpha builds a plugin end to end in her own conversation, at the
// default level, through the scripted fake model (one `ACCEPTANCE-CALL` per turn, in the order a bot following the
// building-plugins skill takes; the point is the tools, the cards and the reload, not the model's choices):
//
// 1. `PluginNew` (the bundled builder's, on demand) gives a small tool plugin's files, with no card; Alpha writes them
//    into her scratch with `Write`, with no card; `PluginValidate` on the folder, with no card, names the OK card's lines.
// 2. `PluginInstall` on the folder: the plugin lands found, its sealed OK card carries the source line "Built by Alpha.
//    Alpha can change its code later without asking, within what this card lists."; the row presses it in the window,
//    and the plugin runs: its tool answers a call.
// 3. `PluginStatus` reports it running.
// 4. Alpha edits a file of the installed plugin in place, under `<home>/plugins/<id>/`, with `Edit` and no card; about
//    two seconds later the change is live with no new OK card: the tool answers with the new text.
// 5. An edit that adds a capability pauses the plugin behind its sealed OK card at once (the coordinator's ruling: the
//    folder is already the new code, so nothing of it runs before the answer): the card names the new line, the
//    capability isn't granted, the plugin isn't running; the row presses OK, and it runs with the grant and
//    `PluginStatus` says running.
// 5b. A second request answered No: the plugin stays off; Alpha edits the request back out, and it runs again with no
//    card.
// 6. Another bot (a plain bot the row installs: `acceptance-workshop-peer`, the home has no other bot at this point)
//    is refused `PluginStatus` on the plugin, and its `Edit` of the plugin's file is refused with no card (the fence:
//    only the bot that built a plugin writes in it); the file is unchanged.
//
// Each step's failure starts with its number and clause, so a red row names the step.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { templateFiles } from "../../packages/plugin-sdk/src/templates/index";
import { fail, installFromPage, leave, sleep, until, type ExampleCtx } from "./example-steps";

export const WORKSHOP_STEP = "the workshop: Alpha builds a plugin in her own conversation at the default level: PluginNew, Write into her scratch and PluginValidate with no card; PluginInstall lands it found behind its OK card (\"Built by Alpha…\"), pressed, and its tool answers; PluginStatus says running; an Edit in place applies about 2 s later with no card; an edit that adds a capability pauses it behind its OK card, and OK'd it runs with the grant; a request answered No keeps it off until edited back out; another bot can't read its status or edit it";

/** The plugin Alpha builds: the SDK's tool template, its tool renamed so no other server's tool ends the same way. */
export const WORKSHOP_ID = "ws-greeter";
export const WORKSHOP_NAME = "Workshop greeter";
export const WORKSHOP_TOOL = "ws_hello";
export const PEER_ID = "acceptance-workshop-peer";
const FIXTURES = resolve(import.meta.dir, "fixtures");

/** The source line of a bot-built plugin's OK card (registry/folders.ts `builtByText`), for Alpha. */
export const BUILT_BY_ALPHA = "Built by Alpha. Alpha can change its code later without asking, within what this card lists.";

/** The files Alpha writes: the tool template's (what `PluginNew` gives), with its tool `hello` renamed. */
export function workshopFiles(): Record<string, string> {
  const made = templateFiles("tool", { id: WORKSHOP_ID, name: WORKSHOP_NAME });
  if ("error" in made) throw new Error(made.error);
  const out: Record<string, string> = {};
  for (const [path, body] of Object.entries(made.files)) out[path] = body.replaceAll('"hello"', `"${WORKSHOP_TOOL}"`);
  return out;
}

/** The greeting the tool answers with, as its code says it (the template's), and the two edits of it. */
export const GREETING = { first: "Hello, ${who}!", second: "Hi again, ${who}!" } as const;
/** What the tool answers for `Acceptance` under each greeting. */
export const answerFor = (greeting: string) => greeting.replace("${who}", "Acceptance");
/** The manifest edit that adds a capability: `notify`, a line of its own on the OK card. */
export const ADD_CAPABILITY = { old: '"engines": {', new: '"capabilities": ["notify"],\n  "engines": {' } as const;
/** The second request (5b), on the manifest as step 5 left it: `devices.read` beside `notify`. */
export const SECOND_REQUEST = { old: '"capabilities": ["notify"],', new: '"capabilities": ["notify", "devices.read"],' } as const;
/** The OK card's lines for the two (the capability catalog's `ok`). */
export const NOTIFY_LINE = "sends you notifications";
export const DEVICES_LINE = "sees your devices";

/** Why an edit didn't reload in time: how long the row waited, and what the tree hash and the state did. */
export function reloadMiss(waitedMs: number, hashAtOk: string, last: { state?: string; treeHash?: string } | undefined): string {
  const hash = last?.treeHash === undefined ? "no tree hash" : last.treeHash === hashAtOk ? "its tree hash never changed (the edit wasn't seen)" : "its tree hash changed";
  return `waited ${(waitedMs / 1000).toFixed(1)} s; ${hash}; its state is ${last?.state ?? "unknown"}`;
}

/** The user message that has the fake model call `tool` with `input` once (fake-anthropic.ts `ACCEPTANCE-CALL`). A
 *  directive inside the input is written as JSON's escape (example-steps.ts `callTurn`), so the fake acts on this call. */
export function callText(tool: string, input: Record<string, unknown>): string {
  return `ACCEPTANCE-CALL ${tool} ${JSON.stringify(input).replace(/ACCEPTANCE-/g, "ACCEPTANCE\\u002D")}`;
}

/** What is wrong while an edit that asks for `cap` waits on its OK card (the ruling: the plugin pauses until the card is
 *  answered): the card not naming the new line, the plugin still running the new code, or `cap` already granted.
 *  Empty when it waits as it should. */
export function waitingProblems(o: { cardLine: boolean; state?: string; granted: readonly string[]; cap: string }): string[] {
  const out: string[] = [];
  if (!o.cardLine) out.push(`its OK card doesn't name what ${o.cap} lets it do`);
  if (o.state === "running") out.push("it kept running while the card waits (the new code ran with no answer)");
  if (o.granted.includes(o.cap)) out.push(`\`${o.cap}\` was granted with no answer to the card`);
  return out;
}

type Ev = Record<string, unknown> & { type?: string; seq?: number };
interface Card { id: string; kind: string; change?: string; session?: string; pluginId?: string }
interface TurnResult { called?: string; result?: { text: string; isError: boolean }; pressed: Card[]; raised: Card[] }

/** Runs `fn` as one numbered step: its failure reads "<n>. <clause>: <why>". */
export async function stepOf<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (why.startsWith(label)) throw err;
    if (err instanceof Error) {
      err.message = `${label}: ${why}`;
      throw err;
    }
    return fail(`${label}: ${why}`);
  }
}

export async function workshopStep(ctx: ExampleCtx, session: string): Promise<string> {
  try {
    return await run(ctx, session);
  } finally {
    // Whatever happened: the card step 5 leaves waiting is answered no, and both plugins go, so no step after this one
    // runs with them.
    for (const c of await cardsOf(ctx).catch(() => [] as Card[])) if (c.pluginId === WORKSHOP_ID || c.pluginId === PEER_ID) await ctx.denyCard(c.id).catch(() => undefined);
    await leave(ctx, WORKSHOP_ID);
    await leave(ctx, PEER_ID);
  }
}

const cardsOf = async (ctx: ExampleCtx) => (await ctx.rpc.request<{ cards: Card[] }>("card.list")).cards;
const pluginOf = async (ctx: ExampleCtx, id: string) => (await ctx.rpc.request<{ plugin: { state: string; treeHash?: string; capabilities: string[] } }>("plugin.get", { id }).catch(() => undefined))?.plugin;

/** The OK card an edit that asks for `cap` raises at once (by the plugin's id), with `line` on it; the plugin is paused
 *  meanwhile (not running) and `cap` not granted. Each miss is named in one failure. */
async function askedCard(ctx: ExampleCtx, cap: string, line: string): Promise<Card> {
  const t0 = Date.now();
  const card = await until(`its OK card for ${cap}`, 20_000, async () => (await cardsOf(ctx)).find((c) => c.kind === "plugin-ok" && c.pluginId === WORKSHOP_ID), async () => {
    const p = await pluginOf(ctx, WORKSHOP_ID);
    return `after ${((Date.now() - t0) / 1000).toFixed(1)} s no OK card for ${WORKSHOP_ID}; it is ${p?.state ?? "gone"}${(p as { reason?: string } | undefined)?.reason ? ` (${(p as { reason?: string }).reason})` : ""}`;
  });
  const text = JSON.stringify((await ctx.rpc.request<{ card: unknown }>("card.get", { id: card.id })).card);
  const p = await pluginOf(ctx, WORKSHOP_ID);
  const wrong = waitingProblems({ cardLine: text.includes(line), state: p?.state, granted: p?.capabilities ?? [], cap });
  if (wrong.length > 0) fail(`${wrong.join("; ")} (card: ${text.slice(0, 300)})`);
  return card;
}

/** One turn: the fake model's one call of `tool` with `input`, in `session`. Cards the turn raises in the session are
 *  pressed in the window when `press` takes them; any other one there fails the turn (it is denied first, so nothing
 *  hangs). Cards raised outside the session (a plugin's OK card) are left pending and listed. */
async function callOnce(ctx: ExampleCtx, session: string, tool: string, input: Record<string, unknown>, press?: (c: Card) => boolean): Promise<TurnResult> {
  const known = new Set((await cardsOf(ctx)).map((c) => c.id));
  const seen = ctx.requests().length;
  const text = callText(tool, input);
  const sent = await ctx.rpc.request<{ seq: number }>("session.send", { id: session, message: { text, clientMessageId: randomUUID() } }, 30_000);
  const pressed: Card[] = [];
  const raised: Card[] = [];
  await until(`the ${tool} turn to end`, 150_000, async () => {
    for (const c of await cardsOf(ctx)) {
      if (known.has(c.id)) continue;
      known.add(c.id);
      if (c.session === session && press?.(c) === true) {
        await ctx.pressCard(`the ${tool} turn's ${c.kind} card`, (x) => x.id === c.id);
        pressed.push(c);
      } else if (c.session === session) {
        await ctx.denyCard(c.id).catch(() => undefined);
        fail(`${tool} raised a ${c.kind}${c.change !== undefined ? ` (${c.change})` : ""} card at the default level`);
      } else {
        raised.push(c);
      }
    }
    const after = (await ctx.history(session)).filter((e) => typeof e.seq === "number" && e.seq > sent.seq);
    return after.some((e: Ev) => e.type === "turn_completed") ? true : undefined;
  });
  const mine = ctx.requests().slice(seen);
  const called = mine.map((r) => r.toolUse).filter((x): x is string => x !== undefined).find((x) => x === tool || x.endsWith(`__${tool}`));
  const result = mine.map((r) => r.toolResult).filter((x): x is { text: string; isError: boolean } => x !== undefined).at(-1);
  if (called === undefined) fail(`no ${tool} was called (offered: ${(mine.find((r) => r.tools.length > 0)?.tools ?? []).filter((x) => x === tool || x.endsWith(`__${tool}`)).join(", ") || "not it"})`);
  if (result === undefined) fail(`${called} gave no result`);
  return { called, result, pressed, raised };
}

/** A call that must succeed (no tool error). */
async function ok(ctx: ExampleCtx, session: string, tool: string, input: Record<string, unknown>, press?: (c: Card) => boolean): Promise<TurnResult & { result: { text: string; isError: boolean } }> {
  const t = await callOnce(ctx, session, tool, input, press);
  if (t.result!.isError) fail(`${tool} failed: ${t.result!.text.slice(0, 300)}`);
  return t as TurnResult & { result: { text: string; isError: boolean } };
}

/** The plugin's tool, called once by Alpha; its card (the tool is on neither no-card list) pressed in the window. */
const greet = (ctx: ExampleCtx, session: string) => ok(ctx, session, WORKSHOP_TOOL, { name: "Acceptance" }, () => true);

async function run(ctx: ExampleCtx, session: string): Promise<string> {
  const { home } = ctx;
  const done: string[] = [];
  const scratch = join(home, "scratch", "alpha");
  const folder = join(scratch, WORKSHOP_ID);
  const installed = join(home, "plugins", WORKSHOP_ID);
  const files = workshopFiles();

  // 1. Scaffold, write, check: no card for any of it.
  await stepOf("1. PluginNew, Write into her scratch and PluginValidate with no card", async () => {
    const made = await ok(ctx, session, "PluginNew", { template: "tool", id: WORKSHOP_ID, name: WORKSHOP_NAME });
    if (!made.called!.endsWith("__PluginNew")) fail(`the scaffold call was ${made.called}, not the builder's mcp__builder__PluginNew`);
    if (!made.result.text.startsWith(`Made a tool plugin, ${WORKSHOP_ID}: 3 files.`)) fail(`PluginNew answered "${made.result.text.slice(0, 160)}"`);
    for (const [path, content] of Object.entries(files)) await ok(ctx, session, "Write", { file_path: join(folder, path), content });
    for (const [path, content] of Object.entries(files)) {
      const on = (() => { try { return readFileSync(join(folder, path), "utf8"); } catch { return undefined; } })();
      if (on !== content) fail(`${path} in her scratch ${on === undefined ? "isn't there" : "isn't what she wrote"}`);
    }
    const checked = await ok(ctx, session, "PluginValidate", { folder: WORKSHOP_ID });
    if (!/\bvalid\b/.test(checked.result.text) || /invalid/.test(checked.result.text)) fail(`PluginValidate said "${checked.result.text.slice(0, 300)}"`);
    if (!/OK will say/i.test(checked.result.text)) fail(`PluginValidate's text names no OK card line: "${checked.result.text.slice(0, 300)}"`);
    done.push("1. PluginNew, three Writes into her scratch and PluginValidate (valid, the OK card's lines named) ran with no card");
  });

  // 2. Install: found, the OK card's source line, pressed in the window, and the plugin's tool answers.
  let hashAtOk = "";
  await stepOf("2. PluginInstall lands it found behind its OK card, which is pressed, and its tool answers", async () => {
    const inst = await ok(ctx, session, "PluginInstall", { folder: WORKSHOP_ID });
    const card = inst.raised.find((c) => c.kind === "plugin-ok" && c.pluginId === WORKSHOP_ID)
      ?? await until("its OK card", 30_000, async () => (await cardsOf(ctx)).find((c) => c.kind === "plugin-ok" && c.pluginId === WORKSHOP_ID));
    const state = (await pluginOf(ctx, WORKSHOP_ID))?.state;
    if (state !== "found") fail(`before the OK it is ${state ?? "not installed"}, not found`);
    const text = JSON.stringify((await ctx.rpc.request<{ card: unknown }>("card.get", { id: card.id })).card);
    if (!text.includes(BUILT_BY_ALPHA)) fail(`its OK card doesn't say "${BUILT_BY_ALPHA}" (card: ${text.slice(0, 500)})`);
    await ctx.pressCard("its OK card", (c) => c.id === card.id);
    await until(`${WORKSHOP_ID} running after its OK`, 60_000, async () => ((await pluginOf(ctx, WORKSHOP_ID))?.state === "running" ? true : undefined));
    hashAtOk = (await pluginOf(ctx, WORKSHOP_ID))?.treeHash ?? "";
    const g = await greet(ctx, session);
    if (!g.result.text.includes(answerFor(GREETING.first))) fail(`its tool answered "${g.result.text.slice(0, 200)}", not "${answerFor(GREETING.first)}"`);
    done.push(`2. PluginInstall: found, its OK card said "Built by Alpha…", pressed in the window; running, its tool answered "${answerFor(GREETING.first)}" (its own card pressed)`);
  });

  // 3. Status.
  await stepOf("3. PluginStatus says running", async () => {
    const s = await ok(ctx, session, "PluginStatus", { id: WORKSHOP_ID });
    if (!/: running\b/.test(s.result.text.split("\n")[0] ?? "")) fail(`PluginStatus's first line is "${s.result.text.split("\n")[0]}"`);
    done.push("3. PluginStatus said running, with no card");
  });

  // 4 to 6 don't hang on each other (1 to 3 make the plugin they use): each runs, and the row fails with every one that
  // failed, so one run reads them all.
  const failed: string[] = [];
  const own = async (fn: () => Promise<void>) => { try { await fn(); } catch (err) { failed.push(err instanceof Error ? err.message : String(err)); } };

  // 4. An edit in place applies about two seconds later, with no card.
  await own(() => stepOf("4. an Edit in place applies about 2 s later with no new card", async () => {
    const hostFile = join(installed, "host", "index.ts");
    await ok(ctx, session, "Read", { file_path: hostFile });
    const t0 = Date.now();
    const e = await ok(ctx, session, "Edit", { file_path: hostFile, old_string: GREETING.first, new_string: GREETING.second });
    if (e.raised.some((c) => c.pluginId === WORKSHOP_ID)) fail(`the edit raised a card for the plugin (${e.raised.map((c) => c.kind).join(", ")})`);
    if (!readFileSync(hostFile, "utf8").includes(GREETING.second)) fail("the edit didn't land in the installed file");
    // A live daemon reloads it from its folder watcher (registry/folders.ts SETTLE_MS, 2 s after the last write): a miss
    // says how long the row waited and what the tree hash and the state did, which is the registry's to explain.
    let last: { state?: string; treeHash?: string } | undefined;
    const applied = await until("the edit to apply (its tree hash to change, running)", 20_000, async () => {
      if ((await cardsOf(ctx)).some((c) => c.pluginId === WORKSHOP_ID)) fail("a card for the plugin appeared after the edit");
      const p = await pluginOf(ctx, WORKSHOP_ID);
      last = p;
      return p?.state === "running" && p.treeHash !== undefined && p.treeHash !== hashAtOk ? Date.now() : undefined;
    }, async () => reloadMiss(Date.now() - t0, hashAtOk, last));
    let answer = "";
    for (let i = 0; i < 3; i++) {
      answer = (await greet(ctx, session)).result.text;
      if (answer.includes(answerFor(GREETING.second))) break;
      await sleep(2_000);
    }
    if (!answer.includes(answerFor(GREETING.second))) fail(`after the edit its tool still answers "${answer.slice(0, 200)}"`);
    if ((await cardsOf(ctx)).some((c) => c.pluginId === WORKSHOP_ID)) fail("a card for the plugin is waiting after the edit applied");
    done.push(`4. the Edit in plugins/${WORKSHOP_ID} ran with no card, applied ${((applied - t0) / 1000).toFixed(1)} s after the turn began with no new OK card, and the tool answered "${answerFor(GREETING.second)}"`);
  }));

  // 5. An edit that asks for more pauses the plugin behind its OK card at once; OK'd, it runs again with the grant.
  await own(() => stepOf("5. an edit that adds a capability pauses it behind its OK card; OK'd, it runs with the grant", async () => {
    const manifest = join(installed, "clover.json");
    await ok(ctx, session, "Read", { file_path: manifest });
    await ok(ctx, session, "Edit", { file_path: manifest, old_string: ADD_CAPABILITY.old, new_string: ADD_CAPABILITY.new });
    const card = await askedCard(ctx, "notify", NOTIFY_LINE);
    await ctx.pressCard("its OK card for notify", (c) => c.id === card.id);
    await until(`${WORKSHOP_ID} running after the OK`, 30_000, async () => ((await pluginOf(ctx, WORKSHOP_ID))?.state === "running" ? true : undefined));
    const p = await pluginOf(ctx, WORKSHOP_ID);
    if (p?.capabilities.includes("notify") !== true) fail(`after the OK its grants are ${JSON.stringify(p?.capabilities)}, without notify`);
    const s = await ok(ctx, session, "PluginStatus", { id: WORKSHOP_ID });
    if (!/: running\b/.test(s.result.text.split("\n")[0] ?? "")) fail(`after the OK PluginStatus's first line is "${s.result.text.split("\n")[0]}"`);
    const g = await greet(ctx, session);
    if (!g.result.text.includes(answerFor(GREETING.second))) fail(`after the OK its tool answered "${g.result.text.slice(0, 200)}"`);
    done.push(`5. adding \`notify\` paused it (not running, not granted) behind its OK card ${card.id}, which named the new line; pressed, it ran again with notify granted, PluginStatus said running and the tool answered`);
  }));

  // 5b. A second request answered No: it stays off; the bot takes the request back out and it runs again with no card.
  await own(() => stepOf("5b. a second request answered No keeps it off; edited back out, it runs again with no card", async () => {
    const manifest = join(installed, "clover.json");
    await ok(ctx, session, "Read", { file_path: manifest });
    await ok(ctx, session, "Edit", { file_path: manifest, old_string: SECOND_REQUEST.old, new_string: SECOND_REQUEST.new });
    const card = await askedCard(ctx, "devices.read", DEVICES_LINE);
    await ctx.denyCard(card.id);
    await sleep(3_000);
    const off = await pluginOf(ctx, WORKSHOP_ID);
    if (off?.state === "running") fail("answered No, it runs");
    if (off?.capabilities.includes("devices.read") === true) fail("answered No, devices.read was granted");
    await ok(ctx, session, "Edit", { file_path: manifest, old_string: SECOND_REQUEST.new, new_string: SECOND_REQUEST.old });
    let lastState: string | undefined;
    await until(`${WORKSHOP_ID} running again with the request taken out`, 20_000, async () => {
      if ((await cardsOf(ctx)).some((c) => c.pluginId === WORKSHOP_ID)) fail("taking the request back out raised a card");
      lastState = (await pluginOf(ctx, WORKSHOP_ID))?.state;
      return lastState === "running" ? true : undefined;
    }, async () => `it is ${lastState ?? "gone"}`);
    const g = await greet(ctx, session);
    if (!g.result.text.includes(answerFor(GREETING.second))) fail(`back on, its tool answered "${g.result.text.slice(0, 200)}"`);
    done.push(`5b. asking for devices.read raised card ${card.id}, answered No: it stayed ${off?.state ?? "off"}; the request edited back out, it ran again with no card and the tool answered`);
  }));

  // 6. Another bot: no status, no edit.
  await own(() => stepOf("6. another bot can't read its status or edit it", async () => {
    await installFromPage(ctx, join(FIXTURES, PEER_ID), PEER_ID);
    const peer = await until("the peer bot in bot.list", 60_000, async () => (await ctx.rpc.request<{ bots: { id: string; mainSession?: string }[] }>("bot.list", {})).bots.find((b) => b.id === PEER_ID && b.mainSession !== undefined));
    const other = peer.mainSession!;
    const status = await callOnce(ctx, other, "PluginStatus", { id: WORKSHOP_ID });
    if (!status.result!.isError) fail(`the other bot's PluginStatus answered "${status.result!.text.slice(0, 200)}"`);
    const hostFile = join(installed, "host", "index.ts");
    const before = readFileSync(hostFile, "utf8");
    await callOnce(ctx, other, "Read", { file_path: hostFile });
    const edit = await callOnce(ctx, other, "Edit", { file_path: hostFile, old_string: GREETING.second, new_string: "Taken over, ${who}!" });
    if (!edit.result!.isError) fail(`the other bot's Edit answered "${edit.result!.text.slice(0, 200)}"`);
    if (/not found|no match|did not find|must read/i.test(edit.result!.text)) fail(`the other bot's Edit failed for another reason than the fence: "${edit.result!.text.slice(0, 200)}"`);
    if (readFileSync(hostFile, "utf8") !== before) fail("the other bot's Edit changed the plugin's file");
    done.push(`6. the other bot (${PEER_ID}, installed for this) was refused PluginStatus ("${status.result!.text.slice(0, 80)}") and its Edit with no card ("${edit.result!.text.slice(0, 80)}"); the file is unchanged`);
  }));

  if (failed.length > 0) fail(`${failed.join(" | ")} (passed: ${done.join("; ")})`);
  return done.join("; ");
}
