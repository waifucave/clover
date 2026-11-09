// What the user allowed for one session only (the controller's R10: driving the person's own logged-in browser
// partition takes an explicit card for each session, and is never the default). Owner: lane D; lane L asks before
// its browser tool drives the `user` partition from a bot's or a coding session.
//
// * **Once per session:** the first ask shows the card (the approval broker, lane C); a yes holds for the rest of that
//   session and no other, and a no is asked again next time. Asks that arrive together share one card.
// * **It lasts the session's life,** restarts included: a yes is recorded in the session's own log
//   (`session_grant`, never sent to clients), and a stopped session's grants end with it.
// * **It is the session's own, never another's:** the grant is looked up by the session the call came from, which the
//   core binds from the tool call (R7), never from what a plugin says.
// * **Only the user's own yes on a card grants it.** The request is a `confirm` card, or a `change` card for a sensitive
//   change (a bot's plugin-chosen provider, `bots/provider-consent.ts`); no level or saved rule answers either (the
//   broker's rule 1), and only a decision `by: "card"` counts: a broker that says yes by level, by rule or any other way
//   grants nothing (review B1).
// * **A no the asker holds is kept too** (`hold`, `lift`: `bots/provider-consent.ts` holds a provider's no until the
//   user's next message of their own): `session_grant_declined` and `session_grant_lifted` in the same log, core-only
//   like the grant, so a held no survives a restart. A no on its own grants nothing and holds nothing: holding is the
//   asker's choice.
// * The card's effect and sealed fields (from the built-in tables) are the asker's to build; the grant adds the kind,
//   the session, its bot and its turn's origin, so the user's own turn waits for the answer and any other expires.
import type { ApprovalBroker, ApprovalDecision, ApprovalRequest } from "../contracts/approval-broker";
import { ContractError } from "../contracts/common";
import type { SessionRecord } from "../contracts/session-host";
import type { DurableSessionHost } from "./durable-host";

/** The grant for driving the person's own browser partition (R10). */
export const USER_BROWSER_PARTITION_GRANT = "browser.partition.user";

/** How far back in a session's log a grant is looked for. */
const GRANT_SCAN = 50_000;

export type GrantDecision = ApprovalDecision | { allowed: true; by: "grant"; cardId?: string };

/** What a grant's card is built from: everything but its session, bot and origin. Its kind is `confirm` unless it says
 *  `change` (both always cards, never an "always"). */
export type GrantCard = Omit<ApprovalRequest, "kind" | "session" | "bot" | "origin" | "ruleKey" | "options"> & { kind?: "confirm" | "change" };

export interface SessionGrantsOptions {
  host: Pick<DurableSessionHost, "get" | "callerOf" | "turnOrigin" | "recordCore" | "history" | "length">;
  approvals: Pick<ApprovalBroker, "request">;
}

export class SessionGrants {
  readonly #o: SessionGrantsOptions;
  /** By session, the grants it holds and the noes held, read from its log the first time. */
  readonly #held = new Map<string, { grants: Map<string, string | undefined>; declined: Set<string> }>();
  readonly #asking = new Map<string, Promise<GrantDecision>>();

  constructor(opts: SessionGrantsOptions) {
    this.#o = opts;
  }

  /** Whether the session holds the grant already. */
  has(session: string, key: string): boolean {
    return this.#state(session).grants.has(key);
  }

  /** Whether a no on this grant is held in the session (`hold`), until `lift`. */
  held(session: string, key: string): boolean {
    return this.#state(session).declined.has(key);
  }

  /** Holds the user's no on this grant, in the session's log too (it survives a restart). */
  hold(session: string, key: string): void {
    const state = this.#state(session);
    if (state.declined.has(key)) return;
    this.#o.host.recordCore(session, { type: "session_grant_declined", key });
    state.declined.add(key);
  }

  /** Lets a held no go: the next `ensure` asks again. */
  lift(session: string, key: string): void {
    const state = this.#state(session);
    if (!state.declined.has(key)) return;
    this.#o.host.recordCore(session, { type: "session_grant_lifted", key });
    state.declined.delete(key);
  }

  /** The grant, asking the user with `card` the first time in this session. `asker`: the session whose turn asks, when
   *  another than the one the grant is kept in (a bot's side thread asking for its bot's grant): the card is that
   *  session's, with its turn's origin, so its interrupt withdraws it and its own turn decides whether it waits. */
  async ensure(session: string, key: string, card: GrantCard, opts: { signal?: AbortSignal; asker?: string } = {}): Promise<GrantDecision> {
    const view = this.#o.host.get(session);
    if (view === undefined) throw new ContractError("not_found", `no session ${session}`);
    if (view.status === "stopped" || view.status === "failed") throw new ContractError("closed", `session ${session} has ended`);
    const grants = this.#state(session).grants;
    if (grants.has(key)) {
      const cardId = grants.get(key);
      return { allowed: true, by: "grant", ...(cardId === undefined ? {} : { cardId }) };
    }
    const asking = `${session}\u0000${key}`;
    const already = this.#asking.get(asking);
    if (already) return already;
    const asker = opts.asker !== undefined && this.#o.host.get(opts.asker) !== undefined ? opts.asker : session;
    const caller = this.#o.host.callerOf(asker);
    const { ruleKey: _ruleKey, options: _options, kind, ...rest } = card as GrantCard & Partial<Pick<ApprovalRequest, "ruleKey" | "options">>;
    const request: ApprovalRequest = {
      ...rest,
      kind: kind === "change" ? "change" : "confirm",
      session: asker,
      ...(caller.bot === undefined ? {} : { bot: caller.bot }),
      origin: this.#o.host.turnOrigin(asker) ?? "bot",
    };
    const pending = this.#o.approvals.request(request, opts).then((decision): GrantDecision => {
      // Only the user's yes on the card itself grants (review B1).
      if (!decision.allowed || decision.by !== "card") return { ...decision, allowed: false };
      this.#o.host.recordCore(session, { type: "session_grant", key, ...(decision.cardId === undefined ? {} : { cardId: decision.cardId }) });
      grants.set(key, decision.cardId);
      return decision;
    }).finally(() => this.#asking.delete(asking));
    this.#asking.set(asking, pending);
    return pending;
  }

  #state(session: string): { grants: Map<string, string | undefined>; declined: Set<string> } {
    let state = this.#held.get(session);
    if (state !== undefined) return state;
    state = { grants: new Map(), declined: new Set() };
    const length = this.#o.host.length(session);
    for (const r of this.#o.host.history(session, { afterSeq: Math.max(-1, length - GRANT_SCAN - 1) })) {
      const grant = grantOf(r);
      if (grant !== undefined) state.grants.set(grant.key, grant.cardId);
      const hold = holdOf(r);
      if (hold?.held === true) state.declined.add(hold.key);
      else if (hold?.held === false) state.declined.delete(hold.key);
    }
    this.#held.set(session, state);
    return state;
  }
}

function holdOf(r: SessionRecord): { key: string; held: boolean } | undefined {
  if (r.type !== "driver" || (r.event.type !== "session_grant_declined" && r.event.type !== "session_grant_lifted")) return undefined;
  const key = r.event["key"];
  return typeof key === "string" ? { key, held: r.event.type === "session_grant_declined" } : undefined;
}

function grantOf(r: SessionRecord): { key: string; cardId?: string } | undefined {
  if (r.type !== "driver" || r.event.type !== "session_grant") return undefined;
  const key = r.event["key"];
  const cardId = r.event["cardId"];
  if (typeof key !== "string") return undefined;
  return { key, ...(typeof cardId === "string" ? { cardId } : {}) };
}
