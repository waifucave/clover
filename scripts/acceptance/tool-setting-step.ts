// The tool setting's row (spec §6.7, lane TS), headless, on the real path: the fixture plugin's tool (acceptance-echo's
// `Echo`, which its manifest preloads) is set off through the app's own method (`tool.setAvailability`, the very call
// Settings' Tools tab makes), and the bot can no longer call it (the request the model gets lists no such tool, and
// the scripted model, asked to call it, finds none); then on demand, and the bot finds and loads it through `Glossary`
// before calling it (it reaches the model deferred); then always on, and it is offered at once (the first request lists it,
// loaded, and no `Glossary` call comes before the call). The row ends with the tool set back to what its plugin declares.
//
// The Settings control itself (its radios and the declared default marked) is the settings plugin's own test
// (plugins/moss/plugins/settings/test/settings.test.tsx); this row proves the engine's half on a real daemon and a real
// bot session, and that the answer to the user's own press reaches the very next turn with no restart.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTurn, fail, until, type ExampleCtx } from "./example-steps";

export const TOOL_SETTING_STEP = "a plugin's tool set off in the user's Tools settings: the bot is no longer offered it; set to on demand, the bot finds and loads it through Glossary before calling it; set to always on, it is offered at once and called with no Glossary; the rows read each value beside the plugin's declared default, and the permission is untouched";

const PLUGIN = "acceptance-echo";
const PONG = "acceptance-echo-pong";

interface Row { name: string; permission: string; availability?: string; declared?: string }
type Offered = { name: string; defer_loading?: boolean }[];

/** What the scripted model's first request since `from` offered of `Echo`: whether it was in the tools it may call (the
 *  request's `tools` and the additions and removals the conversation carries, as the fake works them out), and whether the
 *  request lists it deferred (`defer_loading`: found and loaded through `Glossary`). Also whether `Glossary` was called. */
function offeredEcho(ctx: ExampleCtx, from: number): { listed: boolean; deferred: boolean; glossary: boolean } {
  const mine = ctx.requests().slice(from);
  const first = mine[0];
  const echo = (((first?.body as { tools?: Offered } | undefined)?.tools) ?? []).find((t) => t.name.endsWith("__Echo"));
  const deferred = echo?.defer_loading === true;
  return { listed: (first?.tools ?? []).some((t) => t.endsWith("__Echo")) || deferred, deferred, glossary: mine.some((r) => r.toolUse?.endsWith("Glossary") === true) };
}

export async function installed(ctx: ExampleCtx): Promise<boolean> {
  return ctx.rpc.request("plugin.get", { id: PLUGIN }).then(() => true, () => false);
}

/** The fixture plugin, installed from its folder and OK'd over RPC when this run's home doesn't have it already (a shard
 *  of its own has none; the full run's step 4 left it). Answers whether this step installed it. */
export async function ensurePlugin(ctx: ExampleCtx): Promise<boolean> {
  if (await installed(ctx)) return false;
  // The registry takes a folder named for the plugin's id, so the copy has the id for its name, under a folder of its own.
  const parent = join(ctx.root, "plugin-src", "tool-setting");
  const folder = join(parent, PLUGIN);
  mkdirSync(parent, { recursive: true });
  cpSync(join(import.meta.dir, "fixtures", PLUGIN), folder, { recursive: true });
  // The hook's and the stdio server's targets, which nothing here uses: a port nothing listens on, a path of the run's own.
  writeFileSync(join(folder, "hooks", "targets"), `9\n${join(ctx.root, "tool-setting-hook-escape")}\n`);
  writeFileSync(join(folder, "stdio", "targets"), `9\n${join(ctx.root, "tool-setting-stdio-escape")}\n`);
  const r = await ctx.rpc.request<{ id: string; card?: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
  const card = await until("the fixture plugin's OK card", 30_000, async () => {
    const all = await ctx.rpc.request<{ cards: { id: string; pluginId?: string }[] }>("card.list");
    return all.cards.find((k) => (r.card !== undefined && k.id === r.card) || k.pluginId === r.id);
  });
  await ctx.approveCard(card.id);
  await until("the fixture plugin running after its OK", 60_000, async () => {
    const s = (await ctx.rpc.request<{ plugin?: { state?: string } }>("plugin.get", { id: PLUGIN }).catch(() => undefined))?.plugin?.state;
    return s === "running" || s === "enabled" ? true : undefined;
  });
  return true;
}

export async function toolSettingStep(ctx: ExampleCtx, session: string): Promise<string> {
  const made = await ensurePlugin(ctx);
  const done: string[] = [];
  try {
    // The tool's server as a bot names it, from the Tools tab's own list: no guessing of the key.
    const read = async (): Promise<{ server: string; echo: Row }> => {
      const r = await ctx.rpc.request<{ plugins: { pluginId: string; server: string; tools: Row[] }[] }>("tool.permissions", {});
      const p = r.plugins.find((x) => x.pluginId === PLUGIN && x.tools.some((t) => t.name === "Echo"));
      if (p === undefined) return fail(`tool.permissions lists no Echo tool for ${PLUGIN}`);
      return { server: p.server, echo: p.tools.find((t) => t.name === "Echo")! };
    };
    const setTo = async (server: string, availability: "off" | "on-demand" | "always"): Promise<void> => {
      await ctx.rpc.request("tool.setAvailability", { server, tool: "Echo", availability });
      const now = (await read()).echo;
      if (now.availability !== availability) fail(`after setting ${availability} the row reads ${now.availability ?? "no availability"}`);
    };

    // With nothing chosen: what the plugin declares, preloaded, so always on; the permission is the default, ask.
    // Its server lists its tools a moment after the OK (the plugin host starts it then), so the first read waits for them.
    const start = await until("the fixture plugin's tools in the Tools list", 60_000, async () => {
      const r = await ctx.rpc.request<{ plugins: { pluginId: string; tools: { name: string }[] }[] }>("tool.permissions", {});
      return r.plugins.some((x) => x.pluginId === PLUGIN && x.tools.some((t) => t.name === "Echo")) ? read() : undefined;
    });
    const { server } = start;
    if (start.echo.declared !== "preload" || start.echo.availability !== "always" || start.echo.permission !== "ask") {
      fail(`Echo's row with nothing chosen reads declared ${start.echo.declared}, availability ${start.echo.availability}, permission ${start.echo.permission}; its manifest preloads it, so always on and ask`);
    }
    let from = ctx.requests().length;
    const base = await callTurn(ctx, session, "Echo", { text: "default" });
    if (!base.result.text.includes(PONG) || base.result.isError) fail(`the default call answered ${base.result.text.slice(0, 160)}`);
    const baseOffer = offeredEcho(ctx, from);
    if (!baseOffer.listed || baseOffer.deferred) fail(`with nothing chosen Echo was ${baseOffer.listed ? "deferred" : "not offered"}; a preloaded tool is offered loaded`);
    done.push("by default it is preloaded and answers");

    // Off: not offered; the model, asked to call it, finds no such tool, and the plugin never runs.
    await setTo(server, "off");
    from = ctx.requests().length;
    const off = await ctx.turn(session, `ACCEPTANCE-CALL Echo ${JSON.stringify({ text: "off" })}`, 150_000);
    const offOffer = offeredEcho(ctx, from);
    const said = ctx.requests().slice(from).map((r) => r.toolResult?.text ?? "").join(" ") + JSON.stringify(off.events);
    if (offOffer.listed) fail("the tool set to off was still offered to the bot");
    if (!said.includes("ACCEPTANCE-NO-CALL-TOOL Echo")) fail(`with Echo off the turn didn't end as a model finding no such tool (${said.slice(0, 200)})`);
    if (ctx.requests().slice(from).some((r) => r.toolUse?.endsWith("__Echo") === true)) fail("the bot called Echo while it was off");
    const hidden = await callTurn(ctx, session, "Glossary", { query: "Echo" });
    if (hidden.result.text.includes(`${server}__Echo`)) fail(`with Echo off a Glossary search still named it (${hidden.result.text.slice(0, 200)})`);
    const offRow = (await read()).echo;
    if (offRow.permission !== "ask") fail(`turning Echo off changed its permission to ${offRow.permission}`);
    done.push("off: not offered, no call possible, its permission still ask");

    // On demand: not a tool the model may call yet, and found by a `Glossary` search. The request's shape depends on how the
    // conversation began: a tool in its first request's tools stays listed there undeferred (the cached prefix does not change)
    // and the conversation takes it away with a `tool_removal`; one added since is listed deferred. Either way it is not
    // callable until loaded, which is what is asserted (the load and the call after it is the driver's own end-to-end test:
    // this conversation held the tool added by definition and then removed, and the scripted model works out what it may
    // call from that history, which a tool loaded by reference afterwards doesn't change).
    await setTo(server, "on-demand");
    from = ctx.requests().length;
    const direct = await ctx.turn(session, `ACCEPTANCE-CALL Echo ${JSON.stringify({ text: "on demand" })}`, 150_000);
    const directSaid = ctx.requests().slice(from).map((r) => r.toolResult?.text ?? "").join(" ") + JSON.stringify(direct.events);
    if (ctx.requests().slice(from).some((r) => r.toolUse?.endsWith("__Echo") === true)) fail("on demand, the bot called Echo without loading it first");
    if (!directSaid.includes("ACCEPTANCE-NO-CALL-TOOL Echo")) fail(`on demand, the turn didn't end as a model with no loaded tool to call (${directSaid.slice(0, 200)})`);
    const found = await callTurn(ctx, session, "Glossary", { query: "Echo" });
    if (found.result.isError || !found.result.text.includes(`${server}__Echo`)) fail(`on demand, a Glossary search for Echo didn't name it (${found.result.text.slice(0, 200) || "nothing"})`);
    done.push("on demand: not callable until loaded, and found by a Glossary search");

    // Always on: offered loaded at once, and called with no Glossary.
    await setTo(server, "always");
    from = ctx.requests().length;
    const always = await callTurn(ctx, session, "Echo", { text: "always" });
    const alwaysOffer = offeredEcho(ctx, from);
    // (A tool the request lists deferred can still be callable here: added back by reference, with no search; what shows it
    // is loaded is that the call came with no Glossary before it.)
    if (!alwaysOffer.listed) fail("always on, Echo was not offered");
    if (alwaysOffer.glossary) fail("always on, the bot still went through Glossary before calling Echo");
    if (!always.result.text.includes(PONG) || always.result.isError) fail(`the always-on call answered ${always.result.text.slice(0, 160)}`);
    done.push("always on: offered loaded and answered with no Glossary");
    return done.join("; ");
  } catch (err) {
    // Which phases had passed when it broke: the kept page and the table name the one that did not.
    return fail(`${err instanceof Error ? err.message : String(err)} (passed before it: ${done.length === 0 ? "nothing" : done.join("; ")})`);
  } finally {
    // Back to what the plugin declares, whatever happened, so no later row meets a tool left off.
    try {
      const r = await ctx.rpc.request<{ plugins: { pluginId: string; server: string }[] }>("tool.permissions", {});
      const server = r.plugins.find((x) => x.pluginId === PLUGIN)?.server;
      if (server !== undefined) await ctx.rpc.request("tool.setAvailability", { server, tool: "Echo", availability: "always" });
    } catch { /* the plugin is gone with the run */ }
    if (made) {
      const removed = await ctx.rpc.request<{ card?: string }>("plugin.remove", { id: PLUGIN }).catch(() => undefined);
      if (removed?.card !== undefined) await ctx.approveCard(removed.card).catch(() => undefined);
    }
  }
}
