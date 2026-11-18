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
import { fail, until, type ExampleCtx } from "./example-steps";

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

    // On demand: the tool setting the user can pick instead of always. A coding session's agent has no deferral of its own
    // (the runtime's Tool Search is not on for it), so the tool is offered up front, whatever its availability.
    await ctx.rpc.request("tool.setAvailability", { server, tool: "Echo", availability: "on-demand" });
    const fromD = seen();
    await ctx.turn(session, ASK, 150_000);
    const mineD = ctx.requests().slice(fromD);
    const calledD = mineD.find((r) => r.toolUse !== undefined && BRIDGE_ECHO.test(r.toolUse));
    const answerD = mineD.map((r) => r.toolResult).filter((x): x is { text: string; isError: boolean } => x !== undefined).at(-1);
    if (calledD === undefined || answerD === undefined || answerD.isError || !answerD.text.includes(PONG)) fail(`set on demand, the echo tool was not offered up front and run in the coding session (${calledD?.toolUse ?? "no call"}: ${(answerD?.text ?? "no result").slice(0, 200)})`);
    done.push("set on demand, a coding session is still offered it up front and it runs (no deferral there)");

    // Back on: offered again, and it runs.
    await ctx.rpc.request("tool.setAvailability", { server, tool: "Echo", availability: "always" });
    const from3 = seen();
    await ctx.turn(session, ASK, 150_000);
    const mine3 = ctx.requests().slice(from3);
    const again = mine3.find((r) => r.toolUse !== undefined && BRIDGE_ECHO.test(r.toolUse));
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
