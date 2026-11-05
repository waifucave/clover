// Contract: ApprovalBroker (spec §5.4 "Asking the user", §5.5 "Approvals are core data that plugins show but cannot
// read", "Sensitive changes are approvals too", "Where cards appear"; §7 routine levels; §9.1 levels and the reviewer;
// §9.3 agents' permission requests; spike S5 §8). Owner: lane C, with lane K's sign-off for agents.
//
// Every question that gates an action goes through one broker: a bot's tool call at its computer's level, an ACP
// agent's `session/request_permission`, a sensitive change, a plugin's `confirm`, a found plugin's OK, an MCP server's
// or an agent's URL-mode elicitation (a sign-in link, whose link the card seals). The broker
// answers at once where a level, a saved rule or the bridge rule allows, and otherwise shows a sealed card (§5.5) and
// waits for the first answer from a sealed frame or a paired device.
//
// The rules the contract pins (and the fake keeps):
// 1. Changes, `confirm`, plugin OKs and elicitations are always cards (§5.5, S5 §7).
// 2. An agent's request that exactly names the session's bridge server and one of the bridge's own tools is answered
//    at once: the bridge applies Clover's approval itself when the call arrives (S5 edit 7). Never read from the title.
// 3. A request that touches a fenced path is always a card, at every level, and no saved rule covers it (§9.3).
// 4. A saved rule (from a card's "always") covers the same rule key on the same computers.
// 5. Otherwise the level decides (`levelDecision`): the strictest level of the computers touched (§9.1 "a move between
//    computers needs both computers' levels"), or a routine's own level once its card was answered (§7). At
//    "ask for risky actions" the safety reviewer judges what isn't plainly safe; when no model can run, it asks.
// 6. A card from a turn the user's own message didn't start is denied 10 minutes after it was issued, and a plugin's
//    `confirm` always is; one from the user's turn waits (§5.5, §9.1).
// 7. The user's interrupt withdraws the step's cards; a cancelled or stopped session's cards resolve cancelled, as ACP
//    requires of a client (S5 §8). The first answer wins; a later one is told so.
//    An answer counts only as it arrived (`answer`'s `from`): a sealed-frame proof only from the app's main process
//    (role `app`), naming the channel minted for this card (`frameChannel`); a device's signature only from the device
//    the link authenticated, never a `browser` device, with its time inside `answerTimeOk`'s bounds, over the option
//    and the children checked (`clover/card-answer/2`).
// 8. An agent never gets an "always": `acpOutcomeFor` picks `allow_once` or `reject_once`, and a card's "always" is
//    saved as Clover's own rule instead (S5 edit 5).
import {
  type Card, type CardAnswerProof, type CardFieldName, type CardKind, type CardMeta, type CardOption, type CardOutcome,
  type ChangeSubject, type CloverRole, type DeviceKind, type Level, LEVELS, type SealedValue, type SignedCardAnswer,
  type TurnOrigin, answerTimeOk, callBindingInput, cardAnswerSigningInput, cardHashInput,
} from "@waifucave/clover-protocol";
import type { Unsubscribe } from "./common";

/** What an action does, for the level table: ACP's tool kinds, plus screen control and purchases (§9.1). */
export const ACTION_EFFECTS = ["read", "search", "think", "fetch", "edit", "move", "delete", "execute", "screen", "purchase", "other"] as const;
export type ActionEffect = (typeof ACTION_EFFECTS)[number];

/** The card kinds: `tool`, `agent-permission`, `change`, `confirm`, `plugin-ok`, `elicitation`. */
export type ApprovalKind = CardKind;

/** One option of ACP's `session/request_permission`. */
export interface AgentPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** An ACP agent's permission request, as lane K hands it over (S5 §8). */
export interface AgentPermission {
  backend: string;
  toolCallId: string;
  /** ACP's tool kind: `edit`, `execute`, `other` … (also mapped to `effect`). */
  toolKind: string;
  /** Shown on the card; never parsed for the bridge rule. */
  title: string;
  rawInput?: unknown;
  /** An MCP call's server and tool, read from the structured input (Cursor's `rawInput.providerIdentifier` and
   *  `toolName`), never from the title. */
  mcp?: { server: string; tool: string };
  /** The session's bridge server name and the bridge's own tools (S5 edit 7). */
  bridge?: { server: string; tools: readonly string[] };
  options: readonly AgentPermissionOption[];
}

export interface ApprovalRequest {
  kind: ApprovalKind;
  /** The session asking; its cards are withdrawn on the user's interrupt and cancelled when it stops. */
  session?: string;
  bot?: string;
  /** What started the turn (§5.5): only the user's own message makes a card wait past 10 minutes. */
  origin: TurnOrigin;
  /** The computers the action touches; the strictest level judges. Empty for a change with no computer. */
  computers: readonly string[];
  /** A routine's own level, once its card was answered (§7); otherwise each computer's level applies. */
  level?: Level;
  effect: ActionEffect;
  /** Screen control in a window or tab the bot opened itself (§9.1: only outside those does it ask). */
  ownTarget?: boolean;
  /** Real paths the action touches, for rule 3. */
  paths?: readonly string[];
  /** The key an "always" answer saves (`Bash(git push:*)`, `mcp__blender__Render`); the requester computes it. */
  ruleKey?: string;
  /** The sealed content (§5.5): strings from the built-in tables and trusted packs only. */
  fields: Partial<Record<CardFieldName, SealedValue>>;
  agent?: AgentPermission;
  change?: ChangeSubject;
  /** A plugin's `confirm` or OK: whose. */
  pluginId?: string;
  children?: Card["children"];
  /** Defaults to approve and deny, plus "always" when there is a `ruleKey`. */
  options?: CardOption[];
}

export type DecisionSource = "level" | "rule" | "bridge" | "card" | "expired" | "withdrawn" | "cancelled";

export interface ApprovalDecision {
  allowed: boolean;
  by: DecisionSource;
  /** The level that decided, for `by: "level"`. */
  level?: Level;
  cardId?: string;
  optionId?: string;
  /** The user picked an "always" option: Clover saved its own rule. */
  remembered?: boolean;
}

export type AnswerResult =
  | "accepted" | "already-answered" | "unknown-card" | "hash-mismatch" | "bad-option" | "bad-proof"
  /** The proof can't come from where the answer did: a sealed frame not through the app, another device's signature. */
  | "bad-origin"
  /** A device's `at` outside `answerTimeOk`'s bounds. */
  | "bad-time";

/** Where an answer arrived from, as the connection says, never as the answer does: its role, and for a device link
 *  (`remote`, `peer`), the device the link authenticated. */
export interface AnswerOrigin {
  role: CloverRole;
  device?: string;
}

export interface CardAnswer {
  optionId: string;
  hash: string;
  proof: CardAnswerProof;
  /** A plugin OK's checked children, out of the card's `children`. */
  children?: readonly string[];
}

export type ApprovalEvent =
  /** A new card: the whole of it, for the app's main process and the native iOS app (`card_requested`). */
  | { type: "requested"; card: Card }
  /** `card_resolved`; `device` is the paired device whose answer won, when one did. */
  | { type: "resolved"; cardId: string; outcome: CardOutcome; optionId?: string; device?: string; children?: string[] };

/** A card and, once it is resolved, how (`card.get`). */
export interface CardRecord {
  card: Card;
  outcome?: CardOutcome;
  optionId?: string;
  /** The paired device whose answer won, when one did. */
  device?: string;
  /** The children the answer checked (a plugin OK). */
  children?: string[];
  resolvedAt?: number;
}

export interface SavedRule {
  ruleKey: string;
  computers: string[];
  cardId: string;
  savedAt: number;
}

/** The safety reviewer behind "ask for risky actions" (§9.1), injected: lane C's real one picks its model by
 *  the inherited `reviewer.model` rules and answers `unavailable` when no model can run. */
export type Reviewer = (req: ApprovalRequest) => Promise<"safe" | "risky" | "unavailable">;

/** Checks a device's signature on an answer (§5.5); the broker itself checks the origin, the time and the frame
 *  channels. */
export type ProofVerifier = (card: Card, answer: CardAnswer, from: AnswerOrigin) => boolean | Promise<boolean>;

export interface ApprovalBroker {
  /** Decides by rules 1–5, or shows a card and waits. Never rejects; an aborted signal decides `cancelled`. */
  request(req: ApprovalRequest, opts?: { signal?: AbortSignal }): Promise<ApprovalDecision>;
  /** Pending cards in full, for the app's main process and the native iOS app only (§5.5). */
  cards(): Card[];
  /** One card in full, pending or resolved, for the same two: the conversation keeps a resolved card in place, with
   *  its fields and no buttons (`card.get`). Resolved cards are kept as long as their session's log. */
  get(cardId: string): CardRecord | undefined;
  /** Pending cards without their text (`cardMetaOf`), for plugins with `approvals`. */
  pending(computer?: string): CardMeta[];
  /** Mints the channel this card's sealed frame answers on (`card.frame`); undefined once it isn't pending. */
  frameChannel(cardId: string): string | undefined;
  answer(cardId: string, a: CardAnswer, from: AnswerOrigin): Promise<AnswerResult>;
  /** The user interrupted the session's step: its pending cards resolve `withdrawn` (§6.4). How many did. */
  withdrawSession(sessionId: string): number;
  /** The session was cancelled or stopped: its pending cards resolve `cancelled`. How many did. */
  cancelSession(sessionId: string): number;
  rules(): SavedRule[];
  watch(fn: (e: ApprovalEvent) => void): Unsubscribe;
}

/** What a level does with an effect: `review` means the reviewer judges at "ask for risky actions" (§9.1). Reads
 *  run freely at every level; deleting files, purchases and screen control outside the bot's own windows ask. */
export function levelDecision(level: Level, effect: ActionEffect, ownTarget = false): "allow" | "deny" | "ask" | "review" {
  if (effect === "read" || effect === "search" || effect === "think") return "allow";
  switch (level) {
    case "read-only":
      return "deny";
    case "ask":
      return "ask";
    case "ask-risky":
      if (effect === "delete" || effect === "purchase") return "ask";
      if (effect === "screen") return ownTarget ? "allow" : "ask";
      return "review";
    case "accept-edits":
      return effect === "edit" || effect === "move" ? "allow" : "ask";
    case "automatic":
      return "allow";
  }
}

/** The strictest of some levels (§9.1); `undefined` for none. */
export function strictestLevel(levels: readonly Level[]): Level | undefined {
  let best: Level | undefined;
  for (const l of levels) if (best === undefined || LEVELS.indexOf(l) < LEVELS.indexOf(best)) best = l;
  return best;
}

/** Rule 2: exact server and tool, from structured input. */
export function isBridgeCall(agent: AgentPermission | undefined): boolean {
  if (!agent?.mcp || !agent.bridge) return false;
  return agent.mcp.server === agent.bridge.server && agent.bridge.tools.includes(agent.mcp.tool);
}

/** The ACP answer for a decision (S5 edit 5): `allow_once` or `reject_once`, never an "always"; a refusal when the
 *  agent offers no `allow_once`; `cancelled` when it offers no `reject_once`, or the decision was a cancel. */
export function acpOutcomeFor(
  decision: Pick<ApprovalDecision, "allowed" | "by">,
  options: readonly AgentPermissionOption[],
): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
  if (decision.by === "cancelled" || decision.by === "withdrawn") return { outcome: "cancelled" };
  const allow = options.find((o) => o.kind === "allow_once");
  const reject = options.find((o) => o.kind === "reject_once");
  if (decision.allowed && allow) return { outcome: "selected", optionId: allow.optionId };
  return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
}

/** A card without its text: what a plugin with `approvals` may hear (§5.5). */
export function cardMetaOf(card: Card): CardMeta {
  return {
    id: card.id,
    kind: card.kind,
    computer: card.computer,
    ...(card.session === undefined ? {} : { session: card.session }),
    ...(card.bot === undefined ? {} : { bot: card.bot }),
    ...(card.pluginId === undefined ? {} : { pluginId: card.pluginId }),
    origin: card.origin,
    issuedAt: card.issuedAt,
    expiresAt: card.expiresAt,
    options: card.options.map((o) => ({ id: o.id, kind: o.kind, ...(o.remember === undefined ? {} : { remember: o.remember }) })),
  };
}

/** What a verifier needs of the device registry. */
export interface AnswerDevices {
  verify(device: string, data: Uint8Array, signature: Uint8Array): Promise<boolean>;
  get(device: string): { kind: DeviceKind; revokedAt?: number } | undefined;
}

function fromBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Builds the verifier for device answers: the signing device must be the one the link authenticated, paired, not a
 *  `browser` device, and its Ed25519 signature must cover `cardAnswerSigningInput` with the option and children. A
 *  sealed-frame proof never reaches it (the broker checks those), so it refuses one. */
export function deviceProofVerifier(devices: AnswerDevices): ProofVerifier {
  return async (card, answer, from) => {
    const proof = answer.proof;
    if (proof.via !== "device" || from.device !== proof.device) return false;
    const device = devices.get(proof.device);
    if (!device || device.kind === "browser" || device.revokedAt !== undefined) return false;
    const signature = fromBase64(proof.signature);
    if (!signature) return false;
    const input = cardAnswerSigningInput({ id: card.id, hash: card.hash, option: answer.optionId, at: proof.at, children: answer.children ?? [] });
    return devices.verify(proof.device, new TextEncoder().encode(input), signature);
  };
}

/** Each computer's record of the card ids whose signed answers it has taken as proof: a signed answer counts once. */
export interface AnswerLedger {
  /** True the first time, false ever after. */
  claim(cardId: string): boolean;
}

export type SignedAnswerVerdict = "ok" | "bad-hash" | "unbound" | "not-approve" | "bad-device" | "bad-time" | "bad-signature" | "used";

/** How a receiver takes a signed answer as proof for a call (`peer.call`, `tool.run`) or a raise (`setLevel`): it
 *  recomputes the card's hash, checks the card binds exactly this computer, method and params, that the option is an
 *  approve option, that the device is paired and not a browser, the time, and the signature, and then claims the card
 *  id in its ledger, so the same answer never counts twice. */
export async function verifySignedAnswer(
  s: SignedCardAnswer,
  c: { self: string; method: string; params: unknown; now: number; sha256(text: string): string; devices: AnswerDevices; ledger: AnswerLedger },
): Promise<SignedAnswerVerdict> {
  const { card } = s;
  if (c.sha256(cardHashInput(card)) !== card.hash) return "bad-hash";
  const b = card.binds;
  if (!b || b.computer !== c.self || b.method !== c.method || b.params !== c.sha256(callBindingInput(c.method, c.params))) return "unbound";
  if (card.options.find((o) => o.id === s.option)?.kind !== "approve") return "not-approve";
  if ((s.children ?? []).some((id) => !card.children?.some((x) => x.id === id))) return "not-approve";
  const device = c.devices.get(s.device);
  if (!device || device.kind === "browser" || device.revokedAt !== undefined) return "bad-device";
  if (!answerTimeOk(card, s.at, c.now)) return "bad-time";
  const signature = fromBase64(s.signature);
  const input = cardAnswerSigningInput({ id: card.id, hash: card.hash, option: s.option, at: s.at, children: s.children ?? [] });
  if (!signature || !(await c.devices.verify(s.device, new TextEncoder().encode(input), signature))) return "bad-signature";
  return c.ledger.claim(card.id) ? "ok" : "used";
}
