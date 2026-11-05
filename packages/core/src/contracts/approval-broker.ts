// Contract: ApprovalBroker (spec §5.4 "Asking the user", §5.5 "Approvals are core data that plugins show but cannot
// read", "Sensitive changes are approvals too", "Where cards appear"; §7 routine levels; §9.1 levels and the reviewer;
// §9.3 agents' permission requests; spike S5 §8). Owner: lane C, with lane K's sign-off for agents.
//
// Every question that gates an action goes through one broker: a bot's tool call at its computer's level, an ACP
// agent's `session/request_permission`, a sensitive change, a plugin's `confirm`, a found plugin's OK. The broker
// answers at once where a level, a saved rule or the bridge rule allows, and otherwise shows a sealed card (§5.5) and
// waits for the first answer from a sealed frame or a paired device.
//
// The rules the contract pins (and the fake keeps):
// 1. Changes, `confirm` and plugin OKs are always cards (§5.5).
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
// 8. An agent never gets an "always": `acpOutcomeFor` picks `allow_once` or `reject_once`, and a card's "always" is
//    saved as Clover's own rule instead (S5 edit 5).
import {
  type Card, type CardAnswerProof, type CardFieldName, type CardMeta, type CardOption, type CardOutcome,
  type ChangeSubject, type Level, LEVELS, type SealedValue, type TurnOrigin, cardAnswerSigningInput,
} from "@waifucave/clover-protocol";
import type { Unsubscribe } from "./common";

/** What an action does, for the level table: ACP's tool kinds, plus screen control and purchases (§9.1). */
export const ACTION_EFFECTS = ["read", "search", "think", "fetch", "edit", "move", "delete", "execute", "screen", "purchase", "other"] as const;
export type ActionEffect = (typeof ACTION_EFFECTS)[number];

export type ApprovalKind = "tool" | "agent-permission" | "change" | "confirm" | "plugin-ok";

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

export type AnswerResult = "accepted" | "already-answered" | "unknown-card" | "hash-mismatch" | "bad-option" | "bad-proof";

export type ApprovalEvent =
  /** A new card: the whole of it, for the app's main process and the native iOS app (`card_requested`). */
  | { type: "requested"; card: Card }
  | { type: "resolved"; cardId: string; outcome: CardOutcome; optionId?: string };

export interface SavedRule {
  ruleKey: string;
  computers: string[];
  cardId: string;
  savedAt: number;
}

/** The safety reviewer behind "ask for risky actions" (§9.1), injected: lane C's real one picks its model by
 *  Winter's `reviewer.model` rules and answers `unavailable` when no model can run. */
export type Reviewer = (req: ApprovalRequest) => Promise<"safe" | "risky" | "unavailable">;

/** Checks an answer's proof: a sealed frame's channel, or a paired device's signature (§5.5). */
export type ProofVerifier = (card: Card, optionId: string, proof: CardAnswerProof) => boolean | Promise<boolean>;

export interface ApprovalBroker {
  /** Decides by rules 1–5, or shows a card and waits. Never rejects; an aborted signal decides `cancelled`. */
  request(req: ApprovalRequest, opts?: { signal?: AbortSignal }): Promise<ApprovalDecision>;
  /** Pending cards in full, for the app's main process and the native iOS app only (§5.5). */
  cards(): Card[];
  /** Pending cards without their text (`cardMetaOf`), for plugins with `approvals`. */
  pending(computer?: string): CardMeta[];
  answer(cardId: string, a: { optionId: string; hash: string; proof: CardAnswerProof }): Promise<AnswerResult>;
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
    options: card.options.map((o) => ({ id: o.id, kind: o.kind })),
  };
}

/** Builds a verifier that accepts a sealed frame's answer (the app's main process vouches for its channel) and a
 *  device's answer only with a valid Ed25519 signature over `cardAnswerSigningInput` from a device still paired. */
export function deviceProofVerifier(devices: { verify(device: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> }): ProofVerifier {
  return async (card, optionId, proof) => {
    if (proof.via === "sealed-frame") return true;
    let signature: Uint8Array;
    try {
      signature = Uint8Array.from(atob(proof.signature), (c) => c.charCodeAt(0));
    } catch {
      return false;
    }
    const data = new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option: optionId, at: proof.at }));
    return devices.verify(proof.device, data, signature);
  };
}
