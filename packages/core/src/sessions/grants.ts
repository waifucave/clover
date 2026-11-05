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
// * The card itself (its kind, effect and sealed fields from the built-in tables) is the asker's to build; the grant
//   adds the session, its bot and its turn's origin, so the user's own turn waits for the answer and any other expires.
import type { ApprovalBroker, ApprovalDecision, ApprovalRequest } from "../contracts/approval-broker";
import { ContractError } from "../contracts/common";
import type { SessionRecord } from "../contracts/session-host";
import type { DurableSessionHost } from "./durable-host";

/** The grant for driving the person's own browser partition (R10). */
export const USER_BROWSER_PARTITION_GRANT = "browser.partition.user";

/** How far back in a session's log a grant is looked for. */
const GRANT_SCAN = 50_000;

export type GrantDecision = ApprovalDecision | { allowed: true; by: "grant"; cardId?: string };

export interface SessionGrantsOptions {
  host: Pick<DurableSessionHost, "get" | "callerOf" | "turnOrigin" | "recordCore" | "history" | "length">;
  approvals: Pick<ApprovalBroker, "request">;
}

export class SessionGrants {
  readonly #o: SessionGrantsOptions;
  /** By session, the grants it holds, read from its log the first time. */
  readonly #held = new Map<string, Map<string, string | undefined>>();
  readonly #asking = new Map<string, Promise<GrantDecision>>();

  constructor(opts: SessionGrantsOptions) {
    this.#o = opts;
  }

  /** Whether the session holds the grant already. */
  has(session: string, key: string): boolean {
    return this.#grants(session).has(key);
  }

  /** The grant, asking the user with `card` the first time in this session. */
  async ensure(session: string, key: string, card: Omit<ApprovalRequest, "session" | "bot" | "origin">, opts: { signal?: AbortSignal } = {}): Promise<GrantDecision> {
    const view = this.#o.host.get(session);
    if (view === undefined) throw new ContractError("not_found", `no session ${session}`);
    if (view.status === "stopped" || view.status === "failed") throw new ContractError("closed", `session ${session} has ended`);
    const grants = this.#grants(session);
    if (grants.has(key)) {
      const cardId = grants.get(key);
      return { allowed: true, by: "grant", ...(cardId === undefined ? {} : { cardId }) };
    }
    const asking = `${session}\u0000${key}`;
    const already = this.#asking.get(asking);
    if (already) return already;
    const caller = this.#o.host.callerOf(session);
    const request: ApprovalRequest = {
      ...card,
      session,
      ...(caller.bot === undefined ? {} : { bot: caller.bot }),
      origin: this.#o.host.turnOrigin(session) ?? "bot",
    };
    const pending = this.#o.approvals.request(request, opts).then((decision): GrantDecision => {
      if (decision.allowed && decision.by === "card") {
        this.#o.host.recordCore(session, { type: "session_grant", key, ...(decision.cardId === undefined ? {} : { cardId: decision.cardId }) });
        grants.set(key, decision.cardId);
      }
      return decision;
    }).finally(() => this.#asking.delete(asking));
    this.#asking.set(asking, pending);
    return pending;
  }

  #grants(session: string): Map<string, string | undefined> {
    let grants = this.#held.get(session);
    if (grants !== undefined) return grants;
    grants = new Map();
    const length = this.#o.host.length(session);
    for (const r of this.#o.host.history(session, { afterSeq: Math.max(-1, length - GRANT_SCAN - 1) })) {
      const grant = grantOf(r);
      if (grant !== undefined) grants.set(grant.key, grant.cardId);
    }
    this.#held.set(session, grants);
    return grants;
  }
}

function grantOf(r: SessionRecord): { key: string; cardId?: string } | undefined {
  if (r.type !== "driver" || r.event.type !== "session_grant") return undefined;
  const key = r.event["key"];
  const cardId = r.event["cardId"];
  if (typeof key !== "string") return undefined;
  return { key, ...(typeof cardId === "string" ? { cardId } : {}) };
}
