// FakeApprovalBroker: the broker's rules on an injected clock, levels and fence, with cards answered by tests. Its
// default reviewer is unavailable, so "ask for risky actions" asks, as the real broker does when no model can run.
import { createHash, randomBytes } from "node:crypto";
import {
  type Card, type CardAnswerProof, type CardMeta, type CardOption, type CardOutcome, type Level,
  DEFAULT_LEVEL, UNATTENDED_CARD_TIMEOUT_MS, cardHashInput, isUserTurn,
} from "@waifucave/clover-protocol";
import {
  cardMetaOf, isBridgeCall, levelDecision, strictestLevel,
  type AnswerResult, type ApprovalBroker, type ApprovalDecision, type ApprovalEvent, type ApprovalRequest,
  type CardRecord, type ProofVerifier, type Reviewer, type SavedRule,
} from "../approval-broker";
import type { Clock, TimerHandle } from "../clock";
import { Listeners, type Unsubscribe } from "../common";
import type { Fence } from "../fence";

export interface FakeApprovalBrokerOptions {
  clock: Clock;
  /** Each computer's level (§9.1); default "ask for risky actions". */
  levels?: (computer: string) => Level;
  /** Each computer's fence, for rule 3; the fake checks every computer the request names. */
  fence?: (computer: string) => Pick<Fence, "touches"> | undefined;
  reviewer?: Reviewer;
  verify?: ProofVerifier;
}

interface Pending {
  card: Card;
  req: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
  timer?: TimerHandle;
  done: boolean;
}

const DEFAULT_OPTIONS: CardOption[] = [
  { id: "approve", kind: "approve", label: "Approve" },
  { id: "deny", kind: "deny", label: "Deny" },
];

export class FakeApprovalBroker implements ApprovalBroker {
  readonly #clock: Clock;
  readonly #levels: (computer: string) => Level;
  readonly #fence: FakeApprovalBrokerOptions["fence"];
  readonly #reviewer: Reviewer;
  readonly #verify: ProofVerifier;
  readonly #pending = new Map<string, Pending>();
  readonly #resolved = new Map<string, CardRecord>();
  readonly #rules: SavedRule[] = [];
  readonly #listeners = new Listeners<ApprovalEvent>();

  constructor(opts: FakeApprovalBrokerOptions) {
    this.#clock = opts.clock;
    this.#levels = opts.levels ?? (() => DEFAULT_LEVEL);
    this.#fence = opts.fence;
    this.#reviewer = opts.reviewer ?? (async () => "unavailable");
    this.#verify = opts.verify ?? (() => true);
  }

  async request(req: ApprovalRequest, opts: { signal?: AbortSignal } = {}): Promise<ApprovalDecision> {
    if (opts.signal?.aborted) return { allowed: false, by: "cancelled" };
    const auto = await this.#decide(req);
    if (auto) return auto;
    return this.#showCard(req, opts.signal);
  }

  cards(): Card[] {
    return [...this.#pending.values()].map((p) => structuredClone(p.card));
  }

  get(cardId: string): CardRecord | undefined {
    const p = this.#pending.get(cardId);
    if (p) return { card: structuredClone(p.card) };
    const r = this.#resolved.get(cardId);
    return r === undefined ? undefined : structuredClone(r);
  }

  pending(computer?: string): CardMeta[] {
    return [...this.#pending.values()]
      .filter((p) => computer === undefined || p.card.computer === computer)
      .map((p) => cardMetaOf(p.card));
  }

  async answer(cardId: string, a: { optionId: string; hash: string; proof: CardAnswerProof }): Promise<AnswerResult> {
    const p = this.#pending.get(cardId);
    if (!p) return this.#resolved.has(cardId) ? "already-answered" : "unknown-card";
    if (a.hash !== p.card.hash) return "hash-mismatch";
    const option = p.card.options.find((o) => o.id === a.optionId);
    if (!option) return "bad-option";
    if (!(await this.#verify(p.card, a.optionId, a.proof))) return "bad-proof";
    if (p.done) return "already-answered"; // another answer won while this one was being checked
    const allowed = option.kind === "approve";
    const remembered = allowed && option.remember === "always" && p.req.ruleKey !== undefined;
    if (remembered) this.#rules.push({ ruleKey: p.req.ruleKey!, computers: [...p.req.computers], cardId, savedAt: this.#clock.now() });
    const device = a.proof.via === "device" ? a.proof.device : undefined;
    this.#settle(p, allowed ? "approved" : "denied", { allowed, by: "card", cardId, optionId: option.id, ...(remembered ? { remembered } : {}) }, option.id, device);
    return "accepted";
  }

  withdrawSession(sessionId: string): number {
    return this.#endSession(sessionId, "withdrawn");
  }

  cancelSession(sessionId: string): number {
    return this.#endSession(sessionId, "cancelled");
  }

  rules(): SavedRule[] {
    return this.#rules.map((r) => ({ ...r, computers: [...r.computers] }));
  }

  watch(fn: (e: ApprovalEvent) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  async #decide(req: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    // Rule 1.
    if (req.kind === "change" || req.kind === "confirm" || req.kind === "plugin-ok" || req.kind === "elicitation") return undefined;
    // Rule 2.
    if (req.kind === "agent-permission" && isBridgeCall(req.agent)) return { allowed: true, by: "bridge" };
    // Rule 3.
    if (req.paths?.length && this.#fence) {
      for (const computer of req.computers) if (this.#fence(computer)?.touches(req.paths)) return undefined;
    }
    // Rule 4.
    if (req.ruleKey !== undefined) {
      const rule = this.#rules.find((r) => r.ruleKey === req.ruleKey && req.computers.every((c) => r.computers.includes(c)));
      if (rule) return { allowed: true, by: "rule" };
    }
    // Rule 5.
    const level = req.level ?? strictestLevel(req.computers.map((c) => this.#levels(c))) ?? DEFAULT_LEVEL;
    const verdict = levelDecision(level, req.effect, req.ownTarget);
    if (verdict === "allow") return { allowed: true, by: "level", level };
    if (verdict === "deny") return { allowed: false, by: "level", level };
    if (verdict === "review" && (await this.#reviewer(req)) === "safe") return { allowed: true, by: "level", level };
    return undefined;
  }

  #showCard(req: ApprovalRequest, signal: AbortSignal | undefined): Promise<ApprovalDecision> {
    const issuedAt = this.#clock.now();
    const expires = req.kind === "confirm" || !isUserTurn(req.origin);
    const options = req.options ?? (req.ruleKey === undefined ? DEFAULT_OPTIONS : [
      DEFAULT_OPTIONS[0]!, { id: "always", kind: "approve", label: "Always allow", remember: "always" }, DEFAULT_OPTIONS[1]!,
    ]);
    const unhashed: Omit<Card, "hash"> = {
      id: `card_${randomBytes(12).toString("hex")}`,
      kind: req.kind,
      computer: req.computers[0] ?? null,
      ...(req.session === undefined ? {} : { session: req.session }),
      ...(req.bot === undefined ? {} : { bot: req.bot }),
      ...(req.pluginId === undefined ? {} : { pluginId: req.pluginId }),
      origin: req.origin,
      issuedAt,
      expiresAt: expires ? issuedAt + UNATTENDED_CARD_TIMEOUT_MS : null,
      ...(req.change === undefined ? {} : { change: req.change }),
      fields: structuredClone(req.fields),
      options: structuredClone(options),
      ...(req.children === undefined ? {} : { children: structuredClone(req.children) }),
    };
    const card: Card = { ...unhashed, hash: createHash("sha256").update(cardHashInput(unhashed)).digest("hex") };
    return new Promise<ApprovalDecision>((resolve) => {
      const p: Pending = { card, req, resolve, done: false };
      this.#pending.set(card.id, p);
      if (card.expiresAt !== null) {
        p.timer = this.#clock.setTimeout(() => this.#settle(p, "expired", { allowed: false, by: "expired", cardId: card.id }), UNATTENDED_CARD_TIMEOUT_MS);
      }
      signal?.addEventListener("abort", () => this.#settle(p, "cancelled", { allowed: false, by: "cancelled", cardId: card.id }), { once: true });
      this.#listeners.emit({ type: "requested", card: structuredClone(card) });
    });
  }

  #endSession(sessionId: string, how: "withdrawn" | "cancelled"): number {
    let n = 0;
    for (const p of [...this.#pending.values()]) {
      if (p.card.session !== sessionId) continue;
      this.#settle(p, how, { allowed: false, by: how, cardId: p.card.id });
      n++;
    }
    return n;
  }

  #settle(p: Pending, outcome: CardOutcome, decision: ApprovalDecision, optionId?: string, device?: string): void {
    if (p.done) return;
    p.done = true;
    if (p.timer) this.#clock.clearTimeout(p.timer);
    this.#pending.delete(p.card.id);
    const how = { ...(optionId === undefined ? {} : { optionId }), ...(device === undefined ? {} : { device }) };
    this.#resolved.set(p.card.id, { card: p.card, outcome, ...how, resolvedAt: this.#clock.now() });
    this.#listeners.emit({ type: "resolved", cardId: p.card.id, outcome, ...how });
    p.resolve(decision);
  }
}
