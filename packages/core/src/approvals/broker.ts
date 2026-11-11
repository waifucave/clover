// The real ApprovalBroker (lane C, C-M3; B's contract `contracts/approval-broker.ts`, rules 1-8). It keeps the
// contract's rules exactly as the reference fake does, and adds what a computer needs to live with it:
//   * saved rules (a card's "always") persist in `<home>/rules/saved-rules.json`, inside the fenced set, owner-only,
//     and are read back at start, so an "always" outlives a restart. The file holds a hash of each rule's key and a
//     scrubbed display string, never the raw key (a command can carry a secret); a key that looks like it carries a
//     credential is never offered "always" nor saved (#267's ruling 4);
//   * a card past its `expiresAt` is settled as expired whenever the broker next looks at it, whatever its timer did;
//   * paths are resolved on the computer the session runs on (its daemon builds the request). A request whose paths
//     weren't (`pathsUnresolved`, or with paths from a session on another computer than `localComputer`) always raises
//     a card, never matches or saves a rule, and the card says why (the controller's ruling on #267);
//   * resolved cards are kept for `card.get` for a day, at most 2,000 of them, then dropped oldest first;
//   * its levels, its fence, the safety reviewer and the device-answer verifier are the daemon's (injected).
// It runs B's conformance suite (`test/approvals/broker.test.ts`).
import { createHash, randomBytes } from "node:crypto";

/** The test-marked build's label (scripts/test-build.ts): `false` in every real build, a string only in a test one. */
declare const __CLOVER_TEST_BUILD__: string | false | undefined;
/** A test-marked build: whether the harness has answered a card as the app's origin yet (logged once per run). */
let harnessAnswered = false;
import {
  type Card, type CardMeta, type CardOption, type CardOutcome, type Level,
  DEFAULT_LEVEL, UNATTENDED_CARD_TIMEOUT_MS, answerTimeOk, cardHashInput,
} from "@waifucave/clover-protocol";
import {
  ALWAYS_CARD_KINDS, bindsOutsideRequest, callBindingOf, cardExpires, cardMetaOf, isBridgeCall, levelDecision, strictestLevel, writesRunLater,
  type AnswerOrigin, type AnswerResult, type ApprovalBroker, type ApprovalDecision, type ApprovalEvent,
  type ApprovalRequest, type CardAnswer, type CardRecord, type ProofVerifier, type Reviewer, type SavedRule,
} from "../contracts/approval-broker";
import type { Clock, TimerHandle } from "../contracts/clock";
import { Listeners, type Unsubscribe } from "../contracts/common";
import type { Fence } from "../contracts/fence";
import type { PathClass } from "./ordinary-paths";
import { looksCredentialBearing, ruleDisplay, ruleKeyHash } from "./strings";
import { ruleShapeOf } from "./bot-check";

/** A saved rule as it sits on disk: its key's hash (what a request matches on) and a scrubbed display string. */
export interface StoredRule {
  keyHash: string;
  display: string;
  computers: string[];
  cardId: string;
  savedAt: number;
  /** The bot whose card saved it (the owner's ruling: one bot's "always" is that bot's only); absent for the user's
   *  own session's, and for a rule saved before this, which then matches no bot's request. */
  bot?: string;
}

/** Where saved rules live between runs. */
export interface RuleStore {
  load(): StoredRule[];
  save(rules: readonly StoredRule[]): void;
}

/** A request as Clover's own requesters build it: B's request, plus whether its paths are unresolved (made on a
 *  computer other than the session's, so not real paths). */
export interface CloverApprovalRequest extends ApprovalRequest {
  pathsUnresolved?: boolean;
  /** The card waits for the person however its turn started: no 10-minute deny (rule 6). Its requester closes it when
   *  what it asks about is gone (the cloud cards: approvals/cloud-cards.ts, the controller's ruling on #290). */
  waitsForUser?: boolean;
  /** A card every time (after read-only's deny): no level, saved rule or reviewer answers it, and it offers no
   *  "always". A bot's command while its sandbox isn't drawn from the fence yet (INT, #353's S3). */
  cardAlways?: boolean;
  /** With `pathsUnresolved`: an agent's move or delete whose input names files its listing doesn't read
   *  (`namesUnlistedPaths`), so its card says that instead. */
  pathsUnlisted?: boolean;
}

/** The card's reason for a request whose paths are unresolved, from Clover's own table. */
export const UNRESOLVED_PATHS_REASON = "These paths weren't checked on the computer that runs this session, so this asks every time.";
/** The card's reason for an agent's request that names files its listing doesn't show. */
export const UNLISTED_PATHS_REASON = "The agent's request names files Clover couldn't list, so this asks every time. Check its input.";

/** A saved rule in memory: the raw key only for a rule saved in this run, which `rules()` lists; one read back from
 *  disk lists its display string. */
interface HeldRule extends StoredRule { ruleKey?: string }

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
  /** This computer's name: a request with paths that names another computer has paths this one didn't resolve. */
  localComputer?: string;
  /** The class of a bot's edit's paths on this computer (`ordinary-paths.ts`, the controller's ruling R1): `ordinary`
   *  runs without asking at ask for risky actions; `review` goes to the reviewer, then a card; `card` (a `.git`, a
   *  folder on the user's PATH) is a card at ask for risky actions and at accept edits, with no reviewer. Without it,
   *  every edit is judged as before. */
  pathClass?: (paths: readonly string[]) => PathClass;
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
  readonly #localComputer: string | undefined;
  readonly #pathClass: CloverApprovalBrokerOptions["pathClass"];
  readonly #pending = new Map<string, Pending>();
  readonly #resolved = new Map<string, CardRecord>();
  readonly #rules: HeldRule[];
  readonly #listeners = new Listeners<ApprovalEvent>();

  constructor(opts: CloverApprovalBrokerOptions) {
    this.#clock = opts.clock;
    this.#levels = opts.levels ?? (() => DEFAULT_LEVEL);
    this.#fence = opts.fence;
    this.#reviewer = opts.reviewer ?? (async () => "unavailable");
    this.#verify = opts.verify ?? (() => false);
    this.#store = opts.rules;
    this.#log = opts.log ?? (() => {});
    this.#localComputer = opts.localComputer;
    this.#pathClass = opts.pathClass;
    let loaded: StoredRule[] = [];
    // A fixed line: the parse error could quote the file.
    try { loaded = this.#store?.load() ?? []; } catch { this.#log("[approvals] the saved rules file is unreadable; starting with no saved rules"); }
    this.#rules = loaded.map((r) => ({ ...r, computers: [...r.computers] }));
  }

  #closed = false;

  async request(req: ApprovalRequest, opts: { signal?: AbortSignal; onCard?: (cardId: string) => void } = {}): Promise<ApprovalDecision> {
    if (opts.signal?.aborted || this.#closed) return { allowed: false, by: "cancelled" };
    const auto = await this.#decide(req);
    if (auto) return auto;
    // Stopped while the reviewer judged it: no card is raised, so none is left open (#267's review item 3).
    if (opts.signal?.aborted) return { allowed: false, by: "cancelled" };
    return this.#showCard(req, opts.signal, opts.onCard);
  }

  cards(): Card[] {
    this.#sweepExpired();
    return [...this.#pending.values()].map((p) => structuredClone(p.card));
  }

  get(cardId: string): CardRecord | undefined {
    this.#sweepExpired();
    const p = this.#pending.get(cardId);
    if (p) return { card: structuredClone(p.card) };
    const r = this.#resolved.get(cardId);
    return r === undefined ? undefined : structuredClone(r);
  }

  pending(computer?: string): CardMeta[] {
    this.#sweepExpired();
    return [...this.#pending.values()]
      .filter((p) => computer === undefined || p.card.computer === computer)
      .map((p) => cardMetaOf(p.card));
  }

  frameChannel(cardId: string): string | undefined {
    this.#sweepExpired();
    const p = this.#pending.get(cardId);
    if (!p) return undefined;
    p.channel ??= `frame_${randomBytes(12).toString("hex")}`;
    return p.channel;
  }

  async answer(cardId: string, a: CardAnswer, from: AnswerOrigin): Promise<AnswerResult> {
    this.#sweepExpired();
    const p = this.#pending.get(cardId);
    if (!p) return this.#resolved.has(cardId) ? "already-answered" : "unknown-card";
    if (a.hash !== p.card.hash) return "hash-mismatch";
    const option = p.card.options.find((o) => o.id === a.optionId);
    if (!option) return "bad-option";
    const children = [...(a.children ?? [])];
    if (children.some((id) => !p.card.children?.some((c) => c.id === id))) return "bad-option";
    if (a.proof.via === "sealed-frame") {
      // THE TEST-BUILD RELAXATION (scripts/test-build.ts; a real build compiles it out): in a test-marked build the
      // harness's own `cli` connection (card-methods.ts's `testHarness`) counts as the app's origin, so the acceptance
      // run answers with no window. The minted channel, the hash, the option and this pending record still hold.
      // (The define is tested in each condition itself, never through a variable, so a real build folds it away.)
      if ((from.role !== "app" && !(typeof __CLOVER_TEST_BUILD__ === "string" && from.role === "cli" && from.testHarness === true)) || p.channel === undefined || a.proof.frame !== p.channel) return "bad-origin";
      if (typeof __CLOVER_TEST_BUILD__ === "string" && from.role !== "app" && !harnessAnswered) {
        harnessAnswered = true;
        this.#log(`[approvals] a test-marked build: the acceptance harness answered card ${cardId} as the app's origin (logged once per run)`);
      }
    } else {
      if (!answerTimeOk(p.card, a.proof.at, this.#clock.now())) return "bad-time";
      if (!(await this.#verify(p.card, a, from))) return "bad-proof";
    }
    if (p.done) return "already-answered";
    // The proof check awaited: a card whose time ran out meanwhile is expired, not answered.
    if (this.#expiredNow(p)) {
      this.#settle(p, "expired", { allowed: false, by: "expired", cardId });
      return "already-answered";
    }
    const allowed = option.kind === "approve";
    // A rule names the computers it holds on: a request that names none is never remembered (nor matched, rule 4).
    const remembered = allowed && option.remember === "always" && this.#rememberable(p.req);
    if (remembered) this.#saveRule(p.req.ruleKey!, p.req.computers, cardId, p.req.bot);
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

  withdrawSession(sessionId: string): number { return this.#endSession(sessionId, "withdrawn"); }

  cancelSession(sessionId: string): number { return this.#endSession(sessionId, "cancelled"); }

  /** The daemon is stopping (INT, #292 review): every open card is cancelled, and a request from then on is refused
   *  (`cancelled`), never left waiting on a card no one can see. */
  close(): void {
    this.#closed = true;
    for (const p of [...this.#pending.values()]) this.#settle(p, "cancelled", { allowed: false, by: "cancelled", cardId: p.card.id });
  }

  rules(): SavedRule[] {
    return this.#rules.map((r) => ({ ruleKey: r.ruleKey ?? r.display, computers: [...r.computers], cardId: r.cardId, savedAt: r.savedAt, ...(r.bot === undefined ? {} : { bot: r.bot }) }));
  }

  watch(fn: (e: ApprovalEvent) => void): Unsubscribe { return this.#listeners.add(fn); }

  #saveRule(ruleKey: string, computers: readonly string[], cardId: string, bot: string | undefined): void {
    this.#rules.push({ keyHash: ruleKeyHash(ruleKey), display: ruleDisplay(ruleKey), ruleKey, computers: [...computers], cardId, savedAt: this.#clock.now(), ...(bot === undefined ? {} : { bot }) });
    const stored: StoredRule[] = this.#rules.map((r) => ({ keyHash: r.keyHash, display: r.display, computers: [...r.computers], cardId: r.cardId, savedAt: r.savedAt, ...(r.bot === undefined ? {} : { bot: r.bot }) }));
    // A fixed line: the error could name the file or quote what was written.
    try { this.#store?.save(stored); } catch { this.#log("[approvals] saving a rule failed; it holds until the daemon restarts"); }
  }

  async #decide(req: ApprovalRequest): Promise<ApprovalDecision | undefined> {
    if (bindsOutsideRequest(req)) return { allowed: false, by: "unbound" }; // rule 9: the level and the card name one computer
    if (ALWAYS_CARD_KINDS.includes(req.kind)) return undefined; // rule 1
    const bound = req.binds !== undefined || req.boundCard !== undefined;
    if (!bound && req.kind === "agent-permission" && isBridgeCall(req.agent)) return { allowed: true, by: "bridge" }; // rule 2
    const level = req.level ?? strictestLevel(req.computers.map((c) => this.#levels(c))) ?? DEFAULT_LEVEL;
    // read-only is absolute: only reads run, and no fenced-path card, saved rule or reviewer changes that.
    if (level === "read-only" && levelDecision(level, req.effect) !== "allow") return { allowed: false, by: "level", level };
    if (this.#unresolved(req)) return undefined; // paths no one resolved: a card every time, whatever rule or level
    if ((req as CloverApprovalRequest).cardAlways === true) return undefined; // a card every time (#353's S3)
    if (level === "read-only" && !bound) return { allowed: true, by: "level", level };
    if (writesRunLater(req, this.#fence)) return { allowed: false, by: "fence" }; // rule 3: no bot or agent writes there
    if (bound) return undefined; // rule 9: the card is the proof, whatever a rule, the level or the reviewer would say
    if (req.paths?.length && this.#fence) { // rule 3
      for (const computer of req.computers) if (this.#fence(computer)?.touches(req.paths)) return undefined;
    }
    const paths = this.#editClass(req);
    // A `.git` or a folder on the user's PATH (R1): a card below automatic, every time (no saved rule answers it, and it
    // offers no "always"), whatever the reviewer would say.
    if (paths === "card" && (level === "ask-risky" || level === "accept-edits")) return undefined;
    if (this.#rememberable(req)) { // rule 4: a rule names every computer the request does
      const hash = ruleKeyHash(req.ruleKey!);
      const rule = this.#rules.find((r) => r.keyHash === hash && r.bot === req.bot && r.computers.length > 0 && req.computers.every((c) => r.computers.includes(c)));
      if (rule) return { allowed: true, by: "rule" };
    }
    const verdict = levelDecision(level, req.effect, req.ownTarget, this.#contained(req, paths)); // rule 5
    if (verdict === "allow") return { allowed: true, by: "level", level };
    if (verdict === "deny") return { allowed: false, by: "level", level };
    if (verdict === "review" && (await this.#reviewer(req)) === "safe") return { allowed: true, by: "level", level };
    return undefined;
  }

  #showCard(req: ApprovalRequest, signal: AbortSignal | undefined, onCard?: (cardId: string) => void): Promise<ApprovalDecision> {
    const issuedAt = this.#clock.now();
    // rule 6; `waitsForUser` holds only for a sensitive change (the cloud cards): a plugin's `confirm` always expires.
    const expires = req.kind === "change" && (req as CloverApprovalRequest).waitsForUser === true ? false : cardExpires(req.kind, req.origin);
    const once = ALWAYS_CARD_KINDS.includes(req.kind) || req.binds !== undefined || req.boundCard !== undefined; // rules 1 and 9
    const options = once || !this.#rememberable(req)
      ? (req.options ?? DEFAULT_OPTIONS).filter((o) => o.remember === undefined)
      : req.options ?? ([
        DEFAULT_OPTIONS[0]!, { id: "always", kind: "approve", label: "Always allow", remember: "always" }, DEFAULT_OPTIONS[1]!,
      ]);
    const unhashed: Omit<Card, "hash"> = {
      id: `card_${randomBytes(12).toString("hex")}`,
      kind: req.kind,
      computer: req.binds?.computer ?? req.computers[0] ?? null, // the binding's computer is one the request touches (rule 9)
      ...(req.session === undefined ? {} : { session: req.session }),
      ...(req.bot === undefined ? {} : { bot: req.bot }),
      ...(req.pluginId === undefined ? {} : { pluginId: req.pluginId }),
      origin: req.origin,
      issuedAt,
      expiresAt: expires ? issuedAt + UNATTENDED_CARD_TIMEOUT_MS : null,
      ...(req.change === undefined ? {} : { change: req.change }),
      ...(req.binds === undefined ? {} : { binds: callBindingOf(req.binds, (t) => createHash("sha256").update(t).digest("hex")) }),
      fields: {
        ...(this.#unresolved(req)
          ? { ...withoutRule(req.fields), reason: { type: "text" as const, text: (req as CloverApprovalRequest).pathsUnlisted === true ? UNLISTED_PATHS_REASON : UNRESOLVED_PATHS_REASON } }
          : withoutRule(req.fields)),
        // The reach of an "always" on this card, from the same key, bot and computers `#saveRule` would store and the match in
        // `#decide` compares (the app words it; it never guesses it). Written here, never taken from the requester.
        ...(options.some((o) => o.remember === "always") && req.ruleKey !== undefined ? { rule: ruleFieldOf(req) } : {}),
      },
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
      try { onCard?.(card.id); } catch { /* the requester's own */ }
      this.#listeners.emit({ type: "requested", card: structuredClone(card) });
      if (signal?.aborted) this.#settle(p, "cancelled", { allowed: false, by: "cancelled", cardId: card.id });
    });
  }

  /** Whether a request's paths weren't resolved where its session runs. */
  #unresolved(req: ApprovalRequest): boolean {
    if ((req as CloverApprovalRequest).pathsUnresolved === true) return true;
    if (!req.paths?.length || this.#localComputer === undefined) return false;
    return req.computers.some((c) => c !== this.#localComputer);
  }

  /** A bot's own edit's paths' class (`pathClass`), for a built-in edit tool's request on this computer (its paths are
   *  the tool's one path, resolved here); undefined for anything else. A move never has one: no bot tool moves, and an
   *  agent's move lists what its agent reports (ACP `locations`, a diff's path, a few input keys), which needn't name
   *  the file it moves away, so no listing vouches for the source. An agent's edit is judged by its own sandbox, as
   *  before (its listing can leave a file out just the same). */
  #editClass(req: ApprovalRequest): PathClass | undefined {
    if (req.effect !== "edit" || req.kind !== "tool" || this.#pathClass === undefined) return undefined;
    const here = this.#localComputer !== undefined && req.computers.length > 0 && req.computers.every((c) => c === this.#localComputer);
    if (!here || req.paths === undefined || req.paths.length === 0) return undefined;
    return this.#pathClass(req.paths);
  }

  /** Whether a request stays inside what the fence and the sandbox confine (`ApprovalRequest.contained`): for an edit,
   *  a bot's own edit of ordinary files only (`#editClass`), whatever the requester said; a move, never; for a fetch or
   *  another tool, the requester's word (Clover's own requesters only). */
  #contained(req: ApprovalRequest, paths: PathClass | undefined): boolean {
    if (req.effect === "edit") return paths === "ordinary";
    if (req.effect === "move") return false;
    return req.contained === true && (req.effect === "fetch" || req.effect === "other");
  }

  /** Whether a request may be remembered or matched: a key that doesn't look like it carries a credential, at least
   *  one computer, paths that were resolved, and no bound call (rule 9). */
  #rememberable(req: ApprovalRequest): boolean {
    return req.binds === undefined && req.boundCard === undefined && req.ruleKey !== undefined && req.ruleKey !== "" && !looksCredentialBearing(req.ruleKey) && req.computers.length > 0 && !this.#unresolved(req)
      && (req as CloverApprovalRequest).cardAlways !== true && this.#editClass(req) !== "card";
  }

  #expiredNow(p: Pending): boolean {
    return p.card.expiresAt !== null && this.#clock.now() >= p.card.expiresAt;
  }

  /** Every open card past its `expiresAt` settles as expired, whatever its timer did (a clock that jumped, a timer
   *  that fired late or never). */
  #sweepExpired(): void {
    for (const p of [...this.#pending.values()]) if (this.#expiredNow(p)) this.#settle(p, "expired", { allowed: false, by: "expired", cardId: p.card.id });
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


/** The rule an "always" on this request would store, as the card's `rule` rows: the kind of thing and the thing (from the
 *  key), the bot it holds for (empty: a request naming no bot) and every computer it holds on. */
function ruleFieldOf(req: ApprovalRequest): { type: "rows"; rows: { label: string; value: string }[] } {
  const shape = ruleShapeOf(req.ruleKey!);
  return { type: "rows", rows: [
    { label: "kind", value: shape.kind },
    { label: "target", value: ruleDisplay(shape.target) },
    { label: "bot", value: req.bot ?? "" },
    { label: "computers", value: req.computers.join("\n") },
  ] };
}

/** The requester's fields without a `rule`: that field is the core's alone (the reach of an "always"), whether or not this card offers one. */
function withoutRule<T extends Record<string, unknown>>(fields: T): Omit<T, "rule"> {
  const { rule: _dropped, ...rest } = structuredClone(fields) as Record<string, unknown>;
  return rest as Omit<T, "rule">;
}
