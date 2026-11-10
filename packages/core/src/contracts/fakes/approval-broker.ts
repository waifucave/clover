// FakeApprovalBroker: the broker's rules on an injected clock, levels and fence, with cards answered by tests. Its
// default reviewer is unavailable, so "ask for risky actions" asks, as the real broker does when no model can run, and
// its default verifier refuses every device answer: a test that answers by device passes `deviceProofVerifier`.
import { createHash, randomBytes } from "node:crypto";
import {
  type Card, type CardMeta, type CardOption, type CardOutcome, type Level,
  type TreeTransferParams, DEFAULT_LEVEL, TREE_TRANSFER, UNATTENDED_CARD_TIMEOUT_MS, answerTimeOk, callBindingInput, cardHashInput,
} from "@waifucave/clover-protocol";
import {
  ALWAYS_CARD_KINDS, bindsOutsideRequest, CALL_CARD_METHODS, callBindingOf, cardExpires, cardMetaOf, isBridgeCall, levelDecision, strictestLevel, writesRunLater,
  type AnswerLedger, type CallCardRenderer, type AnswerOrigin, type AnswerResult, type ApprovalBroker, type ApprovalDecision, type ApprovalEvent,
  type ApprovalRequest, type CardAnswer, type CardRecord, type ProofVerifier, type Reviewer, type SavedRule,
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
  /** The channel minted for its sealed frame, once the app asked. */
  channel?: string;
}

/** The card ids a computer has taken signed answers for, in memory. */
export class MemoryAnswerLedger implements AnswerLedger {
  readonly #used = new Set<string>();
  claim(cardId: string): boolean {
    if (this.#used.has(cardId)) return false;
    this.#used.add(cardId);
    return true;
  }
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
    this.#verify = opts.verify ?? (() => false);
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
      // A device's signature holds end to end, so any computer may relay it (review N4).
      if (!answerTimeOk(p.card, a.proof.at, this.#clock.now())) return "bad-time";
      if (!(await this.#verify(p.card, a, from))) return "bad-proof";
    }
    if (p.done) return "already-answered"; // another answer won while this one was being checked
    const allowed = option.kind === "approve";
    const remembered = allowed && option.remember === "always" && p.req.ruleKey !== undefined && p.card.binds === undefined;
    if (remembered) this.#rules.push({ ruleKey: p.req.ruleKey!, computers: [...p.req.computers], cardId, savedAt: this.#clock.now() });
    const device = a.proof.via === "device" ? a.proof.device : undefined;
    // Rule 9: an approve carries the card's binding back.
    const binds = allowed && p.card.binds !== undefined ? { binds: structuredClone(p.card.binds) } : {};
    // ...and, answered by a device's signature, that proof, for the binding's computer (a `SignedCardAnswer`).
    const signed = allowed && p.card.binds !== undefined && a.proof.via === "device"
      ? { signed: { device: a.proof.device, at: a.proof.at, signature: a.proof.signature, ...(children.length > 0 ? { children: [...children] } : {}) } }
      : {};
    this.#settle(p, allowed ? "approved" : "denied", { allowed, by: "card", cardId, optionId: option.id, ...(remembered ? { remembered } : {}), ...binds, ...signed }, option.id, device, children);
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
    // Rule 9's first refusal, then rule 1.
    if (bindsOutsideRequest(req)) return { allowed: false, by: "unbound" };
    if (ALWAYS_CARD_KINDS.includes(req.kind)) return undefined;
    const bound = req.binds !== undefined || req.boundCard !== undefined;
    // Rule 2.
    if (!bound && req.kind === "agent-permission" && isBridgeCall(req.agent)) return { allowed: true, by: "bridge" };
    // read-only is absolute: only reads run, and no fenced-path card, saved rule or reviewer changes that (S1).
    const level = req.level ?? strictestLevel(req.computers.map((c) => this.#levels(c))) ?? DEFAULT_LEVEL;
    if (level === "read-only" && levelDecision(level, req.effect) !== "allow") return { allowed: false, by: "level", level };
    if (level === "read-only" && !bound) return { allowed: true, by: "level", level };
    // Rule 3: a write where a file runs later is refused; any other fenced path is a card.
    if (writesRunLater(req, this.#fence)) return { allowed: false, by: "fence" };
    // Rule 9: a bound call is a card, whatever a rule, the level or the reviewer would say.
    if (bound) return undefined;
    if (req.paths?.length && this.#fence) {
      for (const computer of req.computers) if (this.#fence(computer)?.touches(req.paths)) return undefined;
    }
    // Rule 4.
    if (req.ruleKey !== undefined) {
      const rule = this.#rules.find((r) => r.ruleKey === req.ruleKey && req.computers.every((c) => r.computers.includes(c)));
      if (rule) return { allowed: true, by: "rule" };
    }
    // Rule 5.
    const verdict = levelDecision(level, req.effect, req.ownTarget);
    if (verdict === "allow") return { allowed: true, by: "level", level };
    if (verdict === "deny") return { allowed: false, by: "level", level };
    if (verdict === "review" && (await this.#reviewer(req)) === "safe") return { allowed: true, by: "level", level };
    return undefined;
  }

  #showCard(req: ApprovalRequest, signal: AbortSignal | undefined): Promise<ApprovalDecision> {
    const issuedAt = this.#clock.now();
    const expires = cardExpires(req.kind, req.origin);
    // Rules 1 and 9: an always-card kind, or a bound call, is answered on its own, so it never offers "always".
    const once = ALWAYS_CARD_KINDS.includes(req.kind) || req.binds !== undefined || req.boundCard !== undefined;
    const options = once
      ? (req.options ?? DEFAULT_OPTIONS).filter((o) => o.remember === undefined)
      : req.options ?? (req.ruleKey === undefined ? DEFAULT_OPTIONS : [
        DEFAULT_OPTIONS[0]!, { id: "always", kind: "approve", label: "Always allow", remember: "always" }, DEFAULT_OPTIONS[1]!,
      ]);
    const unhashed: Omit<Card, "hash"> = {
      id: `card_${randomBytes(12).toString("hex")}`,
      kind: req.kind,
      computer: req.binds?.computer ?? req.computers[0] ?? null,
      ...(req.session === undefined ? {} : { session: req.session }),
      ...(req.bot === undefined ? {} : { bot: req.bot }),
      ...(req.pluginId === undefined ? {} : { pluginId: req.pluginId }),
      origin: req.origin,
      issuedAt,
      expiresAt: expires ? issuedAt + UNATTENDED_CARD_TIMEOUT_MS : null,
      ...(req.change === undefined ? {} : { change: req.change }),
      ...(req.binds === undefined ? {} : { binds: callBindingOf(req.binds, (t) => createHash("sha256").update(t).digest("hex")) }),
      fields: structuredClone(req.fields),
      options: structuredClone(options),
      ...(req.children === undefined ? {} : { children: structuredClone(req.children) }),
    };
    // Rule 9, a holder's own card: shown exactly as it came, its binding as sealed.
    const bc = req.boundCard;
    if (bc !== undefined) {
      delete unhashed.change; delete unhashed.children;
      Object.assign(unhashed, {
        kind: bc.kind, computer: bc.binds.computer, binds: structuredClone(bc.binds), fields: structuredClone(bc.fields), options: structuredClone(bc.options),
        ...(bc.change === undefined ? {} : { change: bc.change }), ...(bc.children === undefined ? {} : { children: structuredClone(bc.children) }),
      });
    }
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
    this.#listeners.emit({ type: "resolved", cardId: p.card.id, outcome, ...how });
    p.resolve(decision);
  }
}

/** A card table for the calls `CALL_CARD_METHODS` names, binding each exactly (the shape lane C's tables give, C-M3);
 *  any other call shows no card. Takes the SHA-256 the receiver uses. */
export function fakeCallCardRenderer(sha256: (text: string) => string): CallCardRenderer {
  const known = new Set(CALL_CARD_METHODS.map((m) => m.method));
  return (call) => {
    if (!known.has(call.method)) return undefined;
    const binds = call.method === TREE_TRANSFER
      ? transferBindingOf(call.params as TreeTransferParams, sha256)
      : { computer: call.computer, method: call.method, params: sha256(callBindingInput(call.method, call.params)) };
    return {
      kind: "tool",
      fields: { title: { type: "text", text: `${call.method}` } },
      options: [{ id: "approve", kind: "approve", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" }],
      binds,
    };
  };
}

function transferBindingOf(p: TreeTransferParams, sha256: (text: string) => string) {
  return { computer: p.destination, source: p.source, method: TREE_TRANSFER, params: sha256(callBindingInput(TREE_TRANSFER, p)) };
}
