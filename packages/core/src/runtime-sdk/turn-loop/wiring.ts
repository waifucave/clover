// The core tools a bot's session gets (spec §6.7), put together for the bot driver: lane D's `SendMessage` and
// `ListAgents` (`BotSide.tools`, one `ListAgents` with lane K's agent rows) and lane K's `Agent` and `TaskStop`
// (`agentToolDefs`, the calling bot's session bound as the caller, with the turn's origin read at each call).
// `Glossary` is the driver's own. Owner: lane A.
//
// The daemon (lanes C and D) builds the driver factory with these and lane J's node:
//   botDriverFactory({ home, spawn: embeddedHost.spawn, canUseTool, registry, hooks: pluginHooks({ registry, host }),
//     coreTools: botCoreTools({ side, agents: { manager } }),
//     mcp: { servers, runner: node.mcp }, holds: node.holds, terminals: node.terminals,
//     computers, epoch: () => main.epoch(), provider })
import type { Level } from "@waifucave/clover-protocol";
import { agentToolDefs } from "../../agents/tools";
import type { AgentManager } from "../../agents/manager";
import type { BotSessionContext } from "../../bots/service";
import type { BotDriverDeps } from "./driver";
import type { CoreToolDef } from "./servers";

export interface BotCoreToolsOptions {
  /** Lane D's bot side: `SendMessage` and `ListAgents` for one session. */
  side: { tools(sessionId: string): readonly CoreToolDef[] };
  /** Lane K's agents: `Agent` and `TaskStop`. */
  agents?: {
    manager: AgentManager;
    backends?: () => string[];
    /** A side thread's raised level, from its routine (§7). */
    levelOf?: (ctx: BotSessionContext) => Level | undefined;
  };
}

export function botCoreTools(o: BotCoreToolsOptions): NonNullable<BotDriverDeps["coreTools"]> {
  return (ctx, origin) => {
    const tools: CoreToolDef[] = [...o.side.tools(ctx.sessionId)];
    if (o.agents !== undefined) {
      const level = o.agents.levelOf?.(ctx);
      tools.push(...agentToolDefs(o.agents.manager, {
        bot: ctx.botId, session: ctx.sessionId, origin: origin() ?? "bot", ...(level === undefined ? {} : { level }),
      }, o.agents.backends === undefined ? {} : { backends: o.agents.backends }));
    }
    return tools;
  };
}
