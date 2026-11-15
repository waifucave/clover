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
// * **Who may start what, by the turn's origin:** an outside backend only in a turn the user's own message started (any
//   other origin is refused at once, no card: no one asked for it, and a bot can bring those turns about itself);
//   Clover's own from the user's turn, an agent's report (`task-notification`) or a routine's run, never from a
//   plugin's, a peer's, another bot's or an agent's message.
// * **Budgets the bot can't reset itself** (the adversarial review): at most `AGENT_STARTS_PER_TURN` in one turn, and
//   at most `AGENT_STARTS_PER_USER_MESSAGE` between two of the user's messages across the bot's conversation and every
//   turn its agents' reports start (one budget per root conversation, reset only by a turn the user's message starts,
//   as `SeenUrls`); a routine's run has `AGENT_STARTS_PER_ROUTINE_RUN` for the whole run. And at most
//   `AGENTS_RUNNING_PER_BOT` of a bot's agents running at once, all backends together.
// * **Refused before any card, besides:** an unknown backend or definition, and a task too long for a card to show
//   whole.
// * **One level:** an agent's own tools have no `Agent` (the in-process and clover-code tool lists, the bridge's tools),
//   and only a bot's session is offered it.
import type { TurnOrigin } from "@waifucave/clover-protocol";
import type { AgentStartClass } from "../approvals/bot-check";
import type { BotSessionContext } from "../bots/service";
import { agentTaskText, type AgentDefinitionView } from "./tools";

/** How many agents a bot's session may start in one turn. */
export const AGENT_STARTS_PER_TURN = 3;
/** How many between two of the user's messages, across the conversation and the turns its agents' reports start. */
export const AGENT_STARTS_PER_USER_MESSAGE = 8;
/** How many in one routine's run, all its turns together. */
export const AGENT_STARTS_PER_ROUTINE_RUN = 3;
/** How many of one bot's agents may run at once, all backends together. */
export const AGENTS_RUNNING_PER_BOT = 3;
/** The longest task a start card shows whole (a card's code field holds 64,000 characters). */
export const AGENT_TASK_CARD_MAX = 60_000;

/** The starts' budgets: each session's this turn, and each root conversation's since the user last spoke (or, for a
 *  routine's run, in the whole run). */
export class AgentStarts {
  readonly #turn = new Map<string, number>();
  readonly #root = new Map<string, number>();
  readonly #rootOf: (sessionId: string) => string | undefined;

  /** `rootOf`: the conversation a session's starts are charged to (`budgetRootOf`, as `SeenUrls`); undefined when it
   *  can't be known, and then nothing starts. */
  constructor(o: { rootOf?: (sessionId: string) => string | undefined } = {}) {
    this.#rootOf = o.rootOf ?? ((id) => id);
  }

  /** A new turn of `session`, started from `origin`: its turn count starts again; only the user's own message starts
   *  its root's count again, or a routine's turn its own run's (a run begins). A root this daemon hasn't seen either
   *  of since it started counts as spent (`take`): after a restart, an agent's report arriving with nobody there
   *  starts nothing until the person writes. */
  turnStarted(session: string, origin: TurnOrigin | undefined, sideThread = false): void {
    this.#turn.delete(session);
    if (origin !== "user" && origin !== "routine") return;
    const root = this.#rootOfSafe(session);
    if (root === undefined) return;
    // A routine's turn begins its own run only (a side thread, its own root): it never refreshes a bot's conversation.
    if (origin === "routine" && (!sideThread || root !== session)) return;
    this.#root.set(root, 0);
  }

  #rootOfSafe(session: string): string | undefined {
    try { return this.#rootOf(session); } catch { return undefined; }
  }

  /** One more start for `session`, or why not. `routine`: the session is a routine's run (its own budget). */
  take(session: string, routine: boolean): { ok: true } | { ok: false; why: string } {
    const root = this.#rootOfSafe(session);
    if (root === undefined) return { ok: false, why: "its conversation can't be told apart, so nothing is started from it" };
    const inTurn = this.#turn.get(session) ?? 0;
    if (inTurn >= AGENT_STARTS_PER_TURN) return { ok: false, why: `at most ${AGENT_STARTS_PER_TURN} agents start in one turn` };
    const limit = routine ? AGENT_STARTS_PER_ROUTINE_RUN : AGENT_STARTS_PER_USER_MESSAGE;
    const sinceUser = this.#root.get(root);
    if (sinceUser === undefined) {
      return { ok: false, why: routine ? "this routine's run began before Clover last started, so it starts no more agents" : "Clover started again since the person last wrote here, so no agent starts until they do" };
    }
    if (sinceUser >= limit) {
      return { ok: false, why: routine ? `at most ${AGENT_STARTS_PER_ROUTINE_RUN} agents start in one routine's run` : `at most ${AGENT_STARTS_PER_USER_MESSAGE} agents start between two of the person's messages; ask them before starting more` };
    }
    this.#turn.set(session, inTurn + 1);
    this.#root.set(root, sinceUser + 1);
    return { ok: true };
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
  /** How many of `bot`'s agents run now (not finished, stopped or failed), all backends together. */
  running(bot: string): number;
}

/** The turns a contained start may come from: the user's, an agent's report, a routine's run. */
const CONTAINED_ORIGINS: ReadonlySet<TurnOrigin> = new Set(["user", "task-notification", "routine"]);

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
    const contained = await o.contained(backend);
    if (contained && !CONTAINED_ORIGINS.has(origin)) return refused(`Agent was refused: an agent starts only from the person's message, an agent's report or a routine's run, not from a ${origin} message`);
    if (!contained && (origin !== "user" || ctx.kind !== "bot")) {
      return refused(`Agent was refused: ${backend} runs outside Clover's sandbox, so it starts only when the person's own message asks for it and they answer its card; only Clover's own agents (clover, clover-code) start from here`);
    }
    const text = def === undefined ? brief : agentTaskText(def, brief);
    if (!contained && text.length > AGENT_TASK_CARD_MAX) return refused(`Agent was refused: the task is ${text.length} characters, more than its card can show whole (${AGENT_TASK_CARD_MAX}); shorten it`);
    if (o.running(ctx.botId) >= AGENTS_RUNNING_PER_BOT) return refused(`Agent was refused: ${AGENTS_RUNNING_PER_BOT} of your agents are running; wait for one to finish (its report comes to you) or stop one with TaskStop`);
    const took = o.starts.take(ctx.sessionId, ctx.kind === "side-thread");
    if (!took.ok) return refused(`Agent was refused: ${took.why}`);
    return contained ? { kind: "contained" } : { kind: "card", backend, text };
  };
}
