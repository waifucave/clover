// How a bot's `Agent` call is judged before anything starts (the controller's ruling of 2026-11-11), for bot-check's
// `agentStart`:
//
// * **Clover's own sandboxed coding agents** (`clover`, `clover-code`; `AgentManager.isContainedBackend`: the reserved id
//   resolves to that backend, installed, its own, tested and sandboxed) start with no card, at every level. The start
//   itself does nothing: the child's every act asks at its bot's level (a routine's raised level included), its
//   commands ask on a card while the bot's do, its commands write temp alone, and the Clover home and the user's secret
//   places are out of its reach (the manager). At read-only it runs read-only.
// * **Any other backend** (a coding agent outside Clover's sandbox, a plugin's backend, one not admitted here) asks on a
//   card at each start, naming the backend and showing the whole task as the agent gets it, at every level a card can
//   answer (read-only refuses it), with no "always". A definition's words count in the task: an edited definition takes
//   its plugin out of action until the user OKs it again, so the text the card showed is the text that runs.
// * **Refused before any card:** a side thread's or a routine's start of anything that would ask (no one is there to
//   answer), more than `AGENT_STARTS_PER_TURN` starts in a turn, an unknown backend or definition, and a task too long
//   for a card to show whole.
// * **One level:** an agent's own tools have no `Agent` (the in-process and clover-code tool lists, the bridge's tools),
//   and only a bot's session is offered it.
import type { TurnOrigin } from "@waifucave/clover-protocol";
import type { AgentStartClass } from "../approvals/bot-check";
import type { BotSessionContext } from "../bots/service";
import { agentTaskText, type AgentDefinitionView } from "./tools";

/** How many agents a bot's session may start in one turn. */
export const AGENT_STARTS_PER_TURN = 3;
/** The longest task a start card shows whole (a card's code field holds 64,000 characters). */
export const AGENT_TASK_CARD_MAX = 60_000;

/** Each session's starts this turn. */
export class AgentStarts {
  readonly #used = new Map<string, number>();

  /** A turn of `session` begins: its count starts again. */
  turnStarted(session: string): void {
    this.#used.delete(session);
  }

  /** One more start for `session` this turn, or false past the cap. */
  take(session: string): boolean {
    const n = this.#used.get(session) ?? 0;
    if (n >= AGENT_STARTS_PER_TURN) return false;
    this.#used.set(session, n + 1);
    return true;
  }
}

export interface AgentStartPolicyOptions {
  /** Whether `backend` is one of Clover's own sandboxed agents here (`AgentManager.isContainedBackend`). */
  contained(backend: string): Promise<boolean>;
  /** The backends offered on this computer, by id. */
  backends(): readonly string[];
  /** A plugin's agent definition by Glossary's name, for the session. */
  definition?: (ctx: BotSessionContext, name: string) => AgentDefinitionView | undefined;
  starts: AgentStarts;
}

const AUTOMATED: ReadonlySet<TurnOrigin> = new Set(["routine"]);

export function agentStartPolicy(o: AgentStartPolicyOptions): (ctx: BotSessionContext, input: Record<string, unknown>, origin: TurnOrigin) => Promise<AgentStartClass> {
  return async (ctx, input, origin) => {
    const refused = (message: string): AgentStartClass => ({ kind: "refused", message });
    if (ctx.kind !== "bot" && ctx.kind !== "side-thread") return refused("Agent was refused: only a bot's own conversation starts agents, never an agent");
    const backend = typeof input.backend === "string" ? input.backend : "";
    const brief = typeof input.prompt === "string" ? input.prompt : "";
    if (backend === "" || !o.backends().includes(backend)) return refused(`Agent was refused: no agent backend ${backend.slice(0, 64) || "was named"} here (${o.backends().join(", ") || "none"})`);
    const named = typeof input.agent === "string" ? input.agent : undefined;
    const def = named === undefined ? undefined : o.definition?.(ctx, named);
    if (named !== undefined && def === undefined) return refused(`Agent was refused: no agent definition ${named.slice(0, 120)} (Glossary lists them as <plugin>:<id>)`);
    if (!o.starts.take(ctx.sessionId)) return refused(`Agent was refused: at most ${AGENT_STARTS_PER_TURN} agents start in one turn`);
    if (await o.contained(backend)) return { kind: "contained" };
    if (ctx.kind === "side-thread" || AUTOMATED.has(origin)) {
      return refused(`Agent was refused: ${backend} runs outside Clover's sandbox and asks the person first, and no one is here to answer in a routine's run; only Clover's own agents (clover, clover-code) start from one`);
    }
    const text = def === undefined ? brief : agentTaskText(def, brief);
    if (text.length > AGENT_TASK_CARD_MAX) return refused(`Agent was refused: the task is ${text.length} characters, more than its card can show whole (${AGENT_TASK_CARD_MAX}); shorten it`);
    return { kind: "card", backend, text };
  };
}
