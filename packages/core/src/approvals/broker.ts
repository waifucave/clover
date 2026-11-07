// The real ApprovalBroker (lane C, C-M3; B's contract `contracts/approval-broker.ts`, rules 1-8). It keeps the
// contract's rules exactly as the reference fake does, and adds what a computer needs to live with it:
//   * saved rules (a card's "always") persist in `<home>/rules/saved-rules.json`, inside the fenced set, owner-only,
//     and are read back at start, so an "always" outlives a restart;
//   * resolved cards are kept for `card.get` for a day, at most 2,000 of them, then dropped oldest first;
//   * its levels, its fence, the safety reviewer and the device-answer verifier are the daemon's (injected).
// It runs B's conformance suite (`test/approvals/broker.test.ts`).
import { createHash, randomBytes } from "node:crypto";
import {
  type Card, type CardMeta, type CardOption, type CardOutcome, type Level,
  DEFAULT_LEVEL, UNATTENDED_CARD_TIMEOUT_MS, answerTimeOk, cardHashInput,
} from "@waifucave/clover-protocol";
import {
  ALWAYS_CARD_KINDS, cardExpires, cardMetaOf, isBridgeCall, levelDecision, strictestLevel,
  type AnswerOrigin, type AnswerResult, type ApprovalBroker, type ApprovalDecision, type ApprovalEvent,
  type ApprovalRequest, type CardAnswer, type CardRecord, type ProofVerifier, type Reviewer, type SavedRule,
} from "../contracts/approval-broker";
import type { Clock, TimerHandle } from "../contracts/clock";
import { Listeners, type Unsubscribe } from "../contracts/common";
import type { Fence } from "../contracts/fence";

/** Where saved rules live between runs. */
export interface RuleStore {
  load(): SavedRule[];
  save(rules: readonly SavedRule[]): void;
}

export interface CloverApprovalBrokerOptions {
  clock: Clock;
  /** Each computer's level (§9.1); default "ask for risky actions". */
  levels?: (computer: string) => Level;
  /** Each computer's fence, for rule 3: every computer the request names is asked. */
  fence?: (computer: string) => Pick<Fence, "touches"> | undefined;
  /** The safety reviewer; without one, "ask for risky actions" asks (no model can run). */
  reviewer?: Reviewer;
  /** Checks a paired device's signature (`deviceProofVerifier(registry)`); without one, no device answer counts. */
  verify?: ProofVerifier;
  /** Saved rules' store (`fileRuleStore(home)`); without one they last as long as the broker. */
  rules?: RuleStore;
  log?: (line: string) => void;
}

interface Pending {
  card: Card;
  req: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
  timer?: TimerHandle;
  done: boolean;
  channel?: string;
}

const DEFAULT_OPTIONS: CardOption[] = [
  { id: "approve", kind: "approve", label: "Approve" },
  { id: "deny", kind: "deny", label: "Deny" },
];

/** How long a resolved card stays readable (`card.get`), and how many are kept at most. */
export const RESOLVED_KEEP_MS = 24 * 60 * 60 * 1000;
export const RESOLVED_KEEP_MAX = 2_000;

export class CloverApprovalBroker implements ApprovalBroker {
  readonly #clock: Clock;
  readonly #levels: (computer: string) => Level;
  readonly #fence: CloverApprovalBrokerOptions["fence"];
  readonly #reviewer: Reviewer;
  readonly #verify: ProofVerifier;
  readonly #store: RuleStore | undefined;
  readonly #log: (line: string) => void;
  readonly #pending = new Map<string, Pending>();
  readonly #resolved = new Map<string, CardRecord>();
  readonly #rules: SavedRule[];
  readonly #listeners = new Listeners<ApprovalEvent>();

  constructor(opts: CloverApprovalBrokerOptions) {
    this.#clock = opts.clock;
    this.#levels = opts.levels ?? (() => DEFAULT_LEVEL);
    this.#fence = opts.fence;
    this.#reviewer = opts.reviewer ?? (async () => "unavailable");
    this.#verify = opts.verify ?? (() => false);
    this.#store = opts.rules;
    this.#log = opts.log ?? (() => {});
    let loaded: SavedRule[] = [];
    try { loaded = this.#store?.load() ?? []; } catch (err) { this.#log(`[approvals] saved rules unreadable, starting with none: ${String(err)}`); }
    this.#rules = loaded;
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

  frameChannel(cardId: string): string | undefined {
    const p = this.#pending.get(cardId);
    if (!p) return undefined;
    p.channel ??= `frame_${randomBytes(12).toString("hex")}`;
    return p.channel;
  }

  async answer(cardId: string, a: CardAnswer, from: AnswerOrigin): Promise<AnswerResult> {
    const p = this.#pending.get(cardId);
    if (!p) return this.#resolved.has(cardId) ? "already-answered" : "unknown-card";
    if (a.hash !== p.card.hash) return "hash-mismatch";
    const option = p.card.options.find((o) => o.id === a.optionId);
    if (!option) return "bad-option";
    const children = [...(a.children ?? [])];
    if (children.some((id) => !p.card.children?.some((c) => c.id === id))) return "bad-option";
    if (a.proof.via === "sealed-frame") {
      if (from.role !== "app" || p.channel === undefined || a.proof.frame !== p.channel) return "bad-origin";
    } else {
      if (!answerTimeOk(p.card, a.proof.at, this.#clock.now())) return "bad-time";
      if (!(await this.#verify(p.card, a, from))) return "bad-proof";
    }
    if (p.done) return "already-answered";
    const allowed = option.kind === "approve";
    const remembered = allowed && option.remember === "always" && p.req.ruleKey !== undefined;
    if (remembered) this.#saveRule({ ruleKey: p.req.ruleKey!, computers: [...p.req.computers], cardId, savedAt: this.#clock.now() });
    const device = a.proof.via === "device" ? a.proof.device : undefined;
    this.#settle(p, allowed ? "approved" : "denied", { allowed, by: "card", cardId, optionId: option.id, ...(remembered ? { remembered } : {}) }, option.id, device, children);
    return "accepted";
  }

  withdrawSession(sessionId: string): number { return this.#endSession(sessionId, "withdrawn"); }

  cancelSession(sessionId: string): number { return this.#endSession(sessionId, "cancelled"); }

  rules(): SavedRule[] {
    return this.#rules.map((r) => ({ ...r, computers: [...r.computers] }));
  }

  watch(fn: (e: ApprovalEvent) => void): Unsubscribe { return this.#listeners.add(fn); }

  #saveRule(rule: SavedRule): void {
    this.#rules.push(rule);
    try { this.#store?.save(this.#rules); } catch (err) { this.#log(`[approvals] saving a rule failed; it holds until restart: ${String(err)}`); }
  }

  async #decide(req: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    if (ALWAYS_CARD_KINDS.includes(req.kind)) return undefined; // rule 1
    if (req.kind === "agent-permission" && isBridgeCall(req.agent)) return { allowed: true, by: "bridge" }; // rule 2
    const level = req.level ?? strictestLevel(req.computers.map((c) => this.#levels(c))) ?? DEFAULT_LEVEL;
    // read-only is absolute: only reads run, and no fenced-path card, saved rule or reviewer changes that.
    if (level === "read-only") return levelDecision(level, req.effect) === "allow" ? { allowed: true, by: "level", level } : { allowed: false, by: "level", level };
    if (req.paths?.length && this.#fence) { // rule 3
      for (const computer of req.computers) if (this.#fence(computer)?.touches(req.paths)) return undefined;
    }
    if (req.ruleKey !== undefined) { // rule 4
      const rule = this.#rules.find((r) => r.ruleKey === req.ruleKey && req.computers.every((c) => r.computers.includes(c)));
      if (rule) return { allowed: true, by: "rule" };
    }
    const verdict = levelDecision(level, req.effect, req.ownTarget); // rule 5
    if (verdict === "allow") return { allowed: true, by: "level", level };
    if (verdict === "deny") return { allowed: false, by: "level", level };
    if (verdict === "review" && (await this.#reviewer(req)) === "safe") return { allowed: true, by: "level", level };
    return undefined;
  }

  #showCard(req: ApprovalRequest, signal: AbortSignal | undefined): Promise<ApprovalDecision> {
    const issuedAt = this.#clock.now();
    const expires = cardExpires(req.kind, req.origin); // rule 6
    const once = ALWAYS_CARD_KINDS.includes(req.kind);
    const options = once
      ? (req.options ?? DEFAULT_OPTIONS).filter((o) => o.remember === undefined)
      : req.options ?? (req.ruleKey === undefined ? DEFAULT_OPTIONS : [
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

  #endSession(sessionId: string, how: "withdrawn" | "cancelled"): number { // rule 7
    let n = 0;
    for (const p of [...this.#pending.values()]) {
      if (p.card.session !== sessionId) continue;
      this.#settle(p, how, { allowed: false, by: how, cardId: p.card.id });
      n++;
    }
    return n;
  }

  #settle(p: Pending, outcome: CardOutcome, decision: ApprovalDecision, optionId?: string, device?: string, children?: string[]): void {
    if (p.done) return;
    p.done = true;
    if (p.timer) this.#clock.clearTimeout(p.timer);
    this.#pending.delete(p.card.id);
    const how = {
      ...(optionId === undefined ? {} : { optionId }), ...(device === undefined ? {} : { device }),
      ...(children === undefined || children.length === 0 ? {} : { children }),
    };
    this.#resolved.set(p.card.id, { card: p.card, outcome, ...how, resolvedAt: this.#clock.now() });
    this.#pruneResolved();
    this.#listeners.emit({ type: "resolved", cardId: p.card.id, outcome, ...how });
    p.resolve(decision);
  }

  /** Resolved cards older than a day go, and past `RESOLVED_KEEP_MAX` the oldest (the map keeps resolve order). */
  #pruneResolved(): void {
    const cutoff = this.#clock.now() - RESOLVED_KEEP_MS;
    for (const [id, r] of this.#resolved) {
      if (this.#resolved.size > RESOLVED_KEEP_MAX || (r.resolvedAt ?? 0) < cutoff) this.#resolved.delete(id);
      else break;
    }
  }
}
