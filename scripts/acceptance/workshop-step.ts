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
// 5. An edit that adds a capability stops at a card; while it waits (the row never answers it), a further code edit
//    doesn't apply either: the tool still answers the old text, and the capability isn't granted.
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

export const WORKSHOP_STEP = "the workshop: Alpha builds a plugin in her own conversation at the default level: PluginNew, Write into her scratch and PluginValidate with no card; PluginInstall lands it found behind its OK card (\"Built by Alpha…\"), pressed, and its tool answers; PluginStatus says running; an Edit in place applies about 2 s later with no card; an edit that adds a capability waits on a card and changes nothing meanwhile; another bot can't read its status or edit it";

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
export const GREETING = { first: "Hello, ${who}!", second: "Hi again, ${who}!", third: "Changed while waiting, ${who}!" } as const;
/** What the tool answers for `Acceptance` under each greeting. */
export const answerFor = (greeting: string) => greeting.replace("${who}", "Acceptance");
/** The manifest edit that adds a capability: `notify`, a line of its own on the OK card. */
export const ADD_CAPABILITY = { old: '"engines": {', new: '"capabilities": ["notify"],\n  "engines": {' } as const;

/** The user message that has the fake model call `tool` with `input` once (fake-anthropic.ts `ACCEPTANCE-CALL`). A
 *  directive inside the input is written as JSON's escape (example-steps.ts `callTurn`), so the fake acts on this call. */
export function callText(tool: string, input: Record<string, unknown>): string {
  return `ACCEPTANCE-CALL ${tool} ${JSON.stringify(input).replace(/ACCEPTANCE-/g, "ACCEPTANCE\\u002D")}`;
}

/** What is wrong with a plugin while an edit that adds `notify` waits on the user: no card for it, the plugin no
 *  longer running its OK'd tree, or the capability already granted. Empty when it waits as it should. */
export function waitingProblems(o: { card: boolean; state?: string; reason?: string; granted: readonly string[] }): string[] {
  const out: string[] = [];
  if (!o.card) out.push("no card was raised for the added capability (the user is never asked)");
  if (o.state !== "running") out.push(`the plugin stopped while it waits (${o.state ?? "gone"}${o.reason !== undefined ? `: ${o.reason}` : ""}), so its old behaviour no longer answers`);
  if (o.granted.includes("notify")) out.push("`notify` was granted with no answer to a card");
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

  // 4. An edit in place applies about two seconds later, with no card.
  await stepOf("4. an Edit in place applies about 2 s later with no new card", async () => {
    const hostFile = join(installed, "host", "index.ts");
    await ok(ctx, session, "Read", { file_path: hostFile });
    const t0 = Date.now();
    const e = await ok(ctx, session, "Edit", { file_path: hostFile, old_string: GREETING.first, new_string: GREETING.second });
    if (e.raised.some((c) => c.pluginId === WORKSHOP_ID)) fail(`the edit raised a card for the plugin (${e.raised.map((c) => c.kind).join(", ")})`);
    if (!readFileSync(hostFile, "utf8").includes(GREETING.second)) fail("the edit didn't land in the installed file");
    const applied = await until("the edit to apply (its tree hash to change, running)", 20_000, async () => {
      if ((await cardsOf(ctx)).some((c) => c.pluginId === WORKSHOP_ID)) fail("a card for the plugin appeared after the edit");
      const p = await pluginOf(ctx, WORKSHOP_ID);
      return p?.state === "running" && p.treeHash !== undefined && p.treeHash !== hashAtOk ? Date.now() : undefined;
    });
    let answer = "";
    for (let i = 0; i < 3; i++) {
      answer = (await greet(ctx, session)).result.text;
      if (answer.includes(answerFor(GREETING.second))) break;
      await sleep(2_000);
    }
    if (!answer.includes(answerFor(GREETING.second))) fail(`after the edit its tool still answers "${answer.slice(0, 200)}"`);
    if ((await cardsOf(ctx)).some((c) => c.pluginId === WORKSHOP_ID)) fail("a card for the plugin is waiting after the edit applied");
    done.push(`4. the Edit in plugins/${WORKSHOP_ID} ran with no card, applied ${((applied - t0) / 1000).toFixed(1)} s after the turn began with no new OK card, and the tool answered "${answerFor(GREETING.second)}"`);
  });

  // 5 and 6 don't hang on each other: each runs, and the row fails with every one that failed.
  const failed: string[] = [];
  const own = async (fn: () => Promise<void>) => { try { await fn(); } catch (err) { failed.push(err instanceof Error ? err.message : String(err)); } };

  // 5. An edit that adds a capability waits on a card, and nothing applies meanwhile.
  await own(() => stepOf("5. an edit that adds a capability waits on a card and changes nothing meanwhile", async () => {
    const manifest = join(installed, "clover.json");
    await ok(ctx, session, "Read", { file_path: manifest });
    await ok(ctx, session, "Edit", { file_path: manifest, old_string: ADD_CAPABILITY.old, new_string: ADD_CAPABILITY.new });
    // Both halves of "waits on a card" are read before either fails, so a red row says everything that went wrong: the
    // card the user should see, and the plugin keeping its old behaviour meanwhile.
    const t0 = Date.now();
    const seen = await until("a card for the added capability, or the plugin's state to settle", 20_000, async () => {
      const card = (await cardsOf(ctx)).find((c) => c.pluginId === WORKSHOP_ID);
      const p = await pluginOf(ctx, WORKSHOP_ID);
      if (card !== undefined) return { card, p };
      return Date.now() - t0 > 8_000 ? { card: undefined, p } : undefined;
    });
    const p = await pluginOf(ctx, WORKSHOP_ID) ?? seen.p;
    const wrong = waitingProblems({ card: seen.card !== undefined, state: p?.state, reason: (p as { reason?: string } | undefined)?.reason, granted: p?.capabilities ?? [] });
    if (wrong.length > 0) fail(wrong.join("; "));
    // A code edit while it waits doesn't apply either: the tree as a whole waits on the user.
    await ok(ctx, session, "Edit", { file_path: join(installed, "host", "index.ts"), old_string: GREETING.second, new_string: GREETING.third });
    await sleep(4_000);
    const g = await greet(ctx, session);
    if (!g.result.text.includes(answerFor(GREETING.second))) fail(`while the card waits the tool answers "${g.result.text.slice(0, 200)}", not the old "${answerFor(GREETING.second)}"`);
    const card = seen.card!;
    done.push(`5. adding \`notify\` raised a ${card.kind}${card.change !== undefined ? ` (${card.change})` : ""} card, left unanswered; a code edit after it didn't apply: the tool still answered "${answerFor(GREETING.second)}", and \`notify\` wasn't granted`);
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
    const edit = await callOnce(ctx, other, "Edit", { file_path: hostFile, old_string: before.includes(GREETING.third) ? GREETING.third : GREETING.second, new_string: "Taken over, ${who}!" });
    if (!edit.result!.isError) fail(`the other bot's Edit answered "${edit.result!.text.slice(0, 200)}"`);
    if (/not found|no match|did not find|must read/i.test(edit.result!.text)) fail(`the other bot's Edit failed for another reason than the fence: "${edit.result!.text.slice(0, 200)}"`);
    if (readFileSync(hostFile, "utf8") !== before) fail("the other bot's Edit changed the plugin's file");
    done.push(`6. the other bot (${PEER_ID}, installed for this) was refused PluginStatus ("${status.result!.text.slice(0, 80)}") and its Edit with no card ("${edit.result!.text.slice(0, 80)}"); the file is unchanged`);
  }));

  if (failed.length > 0) fail(`${failed.join(" | ")} (passed: ${done.join("; ")})`);
  return done.join("; ");
}
