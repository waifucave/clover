// A change to the plugins' tools reaches a RUNNING code session (lane AG), headless, on the real path: the user's coding
// session on MOSS's own agent (`moss-code`, started by the app's own method `agent.start`) is running when the fixture
// plugin (acceptance-echo) comes in; its next turn, in the SAME session with no new one started, is offered the plugin's
// `Echo` through the bridge and calls it. Then the user sets `Echo` off in Settings' Tools (`tool.setAvailability`, the
// call the tab makes): the turn after offers no such tool and the plugin never runs; back on, it is offered and runs again.
//
// What the session was told, and when, is read from the scripted model's own requests (the tools each one carried); the
// refusal of a stale name at the call itself, for every way a tool can go away, is the core's tests (agents/tests/
// plugin-reach.test.ts, tool-changes.test.ts). The plugin is put out of the session's reach before it starts (a plugin
// the run already has is switched off and on again; one it hasn't is installed from its folder behind its OK card).
import { BRIDGE_ECHO } from "./fake-anthropic";
import { ensurePlugin, installed } from "./tool-setting-step";
import { callTurn, fail, until, type ExampleCtx } from "./example-steps";

export const CODE_TOOLS_STEP = "a plugin installed while a coding session on MOSS's own agent is running: its next turn, in the same session, is offered the tool and calls it; set off in the user's Tools settings, the turn after is offered none and the plugin never runs; back on, it is called again";

const PLUGIN = "acceptance-echo";
const PONG = "acceptance-echo-pong: acceptance-child-ping";
const ASK = "ACCEPTANCE-CHILD-ECHO: call the echo tool and say what it answered.";

async function listed(ctx: ExampleCtx): Promise<{ server: string } | undefined> {
  const r = await ctx.rpc.request<{ plugins: { pluginId: string; server: string; tools: { name: string }[] }[] }>("tool.permissions", {});
  return r.plugins.find((x) => x.pluginId === PLUGIN && x.tools.some((t) => t.name === "Echo"));
}

export async function codeToolsStep(ctx: ExampleCtx): Promise<string> {
  const done: string[] = [];
  const already = await installed(ctx);
  let made = false;
  let session: string | undefined;
  try {
    // The plugin is out of the session's reach when it starts.
    if (already) {
      await ctx.rpc.request("plugin.setEnabled", { id: PLUGIN, enabled: false }, 60_000);
      await until("the plugin's tool gone from the Tools list", 30_000, async () => ((await listed(ctx)) === undefined ? true : undefined));
    }
    const computer = (await ctx.rpc.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
    if (computer === undefined) fail("computer.list lists no computer");
    const folder = "code-tools";
    const { mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(ctx.userHome, folder), { recursive: true });
    // The user picks the model a coding session of theirs runs: the one the run's key drives, Alpha's.
    const model = (await ctx.rpc.request<{ bots: { id: string; model?: string }[] }>("bot.list", {})).bots.find((b) => b.id === "alpha")?.model;
    if (model === undefined) fail("Alpha has no model to give the user's coding session");

    const seen = () => ctx.requests().length;
    const from0 = seen();
    session = (await ctx.rpc.request<{ session: string }>("agent.start", { backend: "moss-code", computer, root: `home/${computer}/${folder}`, model, prompt: ASK }, 30_000)).session;
    await until("the first turn's end (no echo tool to call)", 120_000, async () => ctx.requests().slice(from0).find((r) => r.lastUserText.includes("ACCEPTANCE-CHILD-ECHO") && r.toolUse === undefined && r.tools.length > 0));
    const first = ctx.requests().slice(from0).filter((r) => r.lastUserText.includes("ACCEPTANCE-CHILD-ECHO"));
    if (first.some((r) => r.tools.some((t) => BRIDGE_ECHO.test(t)))) fail("the echo tool was offered to the session before its plugin was in");
    done.push("the session starts without the plugin's tool");

    // The plugin comes in while the session runs.
    if (already) {
      await ctx.rpc.request("plugin.setEnabled", { id: PLUGIN, enabled: true }, 60_000);
    } else {
      made = await ensurePlugin(ctx);
    }
    await until("the plugin's tool in the Tools list", 60_000, async () => (await listed(ctx)) ?? undefined);
    const server = (await listed(ctx))!.server;
    const from1 = seen();
    const second = await ctx.turn(session, ASK, 150_000);
    const mine1 = ctx.requests().slice(from1);
    const offered = mine1.find((r) => r.tools.some((t) => BRIDGE_ECHO.test(t)));
    if (offered === undefined) fail(`the running session was not offered the echo tool in its next turn (its requests offered ${[...new Set(mine1.flatMap((r) => r.tools.filter((t) => t.startsWith("mcp__moss_"))))].join(", ") || "no bridge tools"}; cards: ${second.cards.join("; ") || "none"}) [packages/core/src/agents/manager.ts refreshBridgeTools]`);
    const called = mine1.find((r) => r.toolUse !== undefined && BRIDGE_ECHO.test(r.toolUse));
    const result = mine1.map((r) => r.toolResult).filter((x): x is { text: string; isError: boolean } => x !== undefined).at(-1);
    if (called === undefined || result === undefined || result.isError || !result.text.includes(PONG)) return fail(`the echo tool was offered but not run to its answer (${called?.toolUse ?? "no call"}: ${(result?.text ?? "no result").slice(0, 200)})`);
    const rows = (await ctx.rpc.request<{ sessions: { id: string }[] }>("session.list", { kinds: ["coding"] })).sessions;
    if (rows.filter((r) => r.id === session).length !== 1) fail("the coding session is not the one that was running");
    done.push(`installed while it ran, the next turn of the same session was offered ${called.toolUse} and got "${PONG}" back`);

    // Set off in Settings' Tools: the next turn is offered no such tool, and the plugin does not run.
    await ctx.rpc.request("tool.setAvailability", { server, tool: "Echo", availability: "off" });
    const from2 = seen();
    await ctx.turn(session, ASK, 150_000);
    const mine2 = ctx.requests().slice(from2);
    if (mine2.some((r) => r.tools.some((t) => BRIDGE_ECHO.test(t)))) fail("the echo tool set off in Settings' Tools was still offered to the running session");
    if (mine2.some((r) => r.toolUse !== undefined && BRIDGE_ECHO.test(r.toolUse))) fail("the running session called the echo tool while it was set off");
    if (!mine2.some((r) => /ACCEPTANCE-CHILD-NO-ECHO/.test(JSON.stringify(r.body ?? "")) || r.toolResult === undefined)) fail("the turn with the tool off was not a model finding no echo tool");
    done.push("set off, the next turn was offered none and nothing ran");

    // On demand (the owner, 2026-11-18: "Code sessions will also have the glossary"): MOSS's own agent holds the tool back until the
    // session loads it through the bridge's Glossary, which finds it, loads it so the same turn can call it, and the call is
    // judged as an always-on tool's is (the same cards as the call above).
    await ctx.rpc.request("tool.setAvailability", { server, tool: "Echo", availability: "on-demand" });
    const fromD = seen();
    await ctx.turn(session, ASK, 150_000);
    const mineD = ctx.requests().slice(fromD);
    if (mineD.some((r) => r.tools.some((t) => BRIDGE_ECHO.test(t)))) fail("the echo tool set on demand was offered to the coding session before any load");
    if (!mineD.some((r) => r.tools.includes("Glossary"))) fail(`the coding session was not offered Glossary, which loads an on-demand tool (it was offered ${[...new Set(mineD.flatMap((r) => r.tools.filter((t) => /Glossary/.test(t))))].join(", ") || "none of it"})`);
    if (!mineD.some((r) => /ACCEPTANCE-CHILD-NO-ECHO/.test(JSON.stringify(r.body ?? "")) || r.toolResult === undefined)) fail("the first turn with the tool on demand was not a model finding no echo tool");
    done.push("set on demand, the turn is not offered it, and is offered Glossary");
    const ECHO_NAME = "acceptance-echo-echo__Echo";
    const found = await callTurn(ctx, session, "Glossary", { query: "echo" });
    if (!found.result.text.includes(ECHO_NAME)) fail(`Glossary did not find the on-demand echo tool by ${ECHO_NAME}: ${found.result.text.slice(0, 300)}`);
    // Called by its exact name before any load, as a model that guessed it would: the runtime does not run it.
    const fullName = called.toolUse!;
    const fromF = seen();
    await ctx.turn(session, `ACCEPTANCE-FORCE ${fullName} ${JSON.stringify({ text: "acceptance-early" })}`, 150_000);
    const mineF = ctx.requests().slice(fromF);
    const earlyAnswer = mineF.map((r) => r.toolResult).filter((x): x is { text: string; isError: boolean } => x !== undefined).at(-1);
    if (earlyAnswer === undefined || earlyAnswer.text.includes(PONG) || !/not been loaded[\s\S]*Glossary/.test(earlyAnswer.text)) fail(`a call to the on-demand echo tool by name before any load ran, or was not answered "not loaded, use Glossary" (${JSON.stringify(earlyAnswer ?? "no result").slice(0, 300)})`);
    done.push(`called by name before a load it was refused ("${earlyAnswer!.text.slice(0, 80)}")`);
    // The load and the call in ONE turn, as a model does: Glossary loads it, and the model's next step (same turn) calls it by name.
    const fromC = seen();
    const called2 = await ctx.turn(session, `ACCEPTANCE-FORCE-LOADED ${fullName} ${ECHO_NAME} ${JSON.stringify({ text: "acceptance-child-ping" })}`, 150_000);
    const mineC = ctx.requests().slice(fromC);
    const callC = mineC.find((r) => r.toolUse === fullName);
    const answerC = mineC.map((r) => r.toolResult).filter((x): x is { text: string; isError: boolean } => x !== undefined).at(-1);
    if (callC === undefined || answerC === undefined || answerC.isError || !answerC.text.includes(PONG)) fail(`the loaded echo tool was not called to its answer (${callC?.toolUse ?? "no call"}: ${(answerC?.text ?? "no result").slice(0, 200)})`);
    if (JSON.stringify(called2.cards) !== JSON.stringify(second.cards)) fail(`the loaded tool's call raised ${JSON.stringify(called2.cards)}, not what the always-on call did (${JSON.stringify(second.cards)})`);
    done.push(`on demand: Glossary found it; a load and the call in ONE turn ran the plugin with the cards an always-on call has (the request's tool list ${mineC.some((r) => r.tools.includes(fullName)) ? "showed" : "did not show"} it)`);

    // Back on: it runs again. The tool was loaded in this session a moment ago, so the runtime already holds it and does not
    // list it again: the call by its name is the proof (the model's own list is not).
    await ctx.rpc.request("tool.setAvailability", { server, tool: "Echo", availability: "always" });
    const from3 = seen();
    await ctx.turn(session, `ACCEPTANCE-FORCE ${fullName} ${JSON.stringify({ text: "acceptance-child-ping" })}`, 150_000);
    const mine3 = ctx.requests().slice(from3);
    const again = mine3.find((r) => r.toolUse === fullName);
    const answer = mine3.map((r) => r.toolResult).filter((x): x is { text: string; isError: boolean } => x !== undefined).at(-1);
    if (again === undefined || answer === undefined || answer.isError || !answer.text.includes(PONG)) fail(`set back on, the echo tool was not called to its answer (${again?.toolUse ?? "no call"}: ${(answer?.text ?? "no result").slice(0, 200)})`);
    done.push("back on, it ran again");
    return done.join("; ");
  } catch (err) {
    return fail(`${err instanceof Error ? err.message : String(err)} (passed before it: ${done.length === 0 ? "nothing" : done.join("; ")})`);
  } finally {
    try {
      const l = await listed(ctx);
      if (l !== undefined) await ctx.rpc.request("tool.setAvailability", { server: l.server, tool: "Echo", availability: "always" });
    } catch { /* the plugin is gone with the run */ }
    if (session !== undefined) await ctx.rpc.request("session.stop", { id: session }).catch(() => undefined);
    if (already) {
      await ctx.rpc.request("plugin.setEnabled", { id: PLUGIN, enabled: true }, 60_000).catch(() => undefined);
    } else if (made) {
      const removed = await ctx.rpc.request<{ card?: string }>("plugin.remove", { id: PLUGIN }).catch(() => undefined);
      if (removed?.card !== undefined) await ctx.approveCard(removed.card).catch(() => undefined);
    }
  }
}
