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
// 1. Changes, `confirm`, plugin OKs, elicitations and the person's browser (R10) are always cards (§5.5, S5 §7), and none of them offers an
//    "always", whatever `ruleKey` or `options` the requester passes: each is answered on its own (`ALWAYS_CARD_KINDS`).
// 2. An agent's request that exactly names the session's bridge server and one of the bridge's own tools is answered
//    at once: the bridge applies Clover's approval itself when the call arrives (S5 edit 7). Never read from the title.
// 3. A request that touches a fenced path is always a card, at every level, and no saved rule covers it (§9.3). One
//    that would write (edit, move, delete) where a file runs later outside any sandbox (`RUN_LATER_KINDS`: shell start
//    files, login items, the coding agents' installs and settings) is refused without a card (`by: "fence"`), at every
//    level: no bot or agent writes there, whoever answers (the #301 review's ruling).
// 4. A saved rule (from a card's "always") covers the same rule key on the same computers, except at read-only, which
//    is absolute: there only reads run, whatever was saved.
// 5. Otherwise the level decides (`levelDecision`): the strictest level of the computers touched (§9.1 "a move between
//    computers needs both computers' levels"), or a routine's own level once its card was answered (§7). At
//    "ask for risky actions" the safety reviewer judges what isn't plainly safe; when no model can run, it asks. The
//    levels form a total order (`LEVELS`): accept-edits is ask-risky plus edits and moves, so a command at
//    accept-edits is judged as at ask-risky, and a stricter level never allows what a laxer one asks about.
// 6. A card from a turn the user's own message didn't start is denied 10 minutes after it was issued, and a plugin's
//    `confirm` always is; one from the user's turn waits (§5.5, §9.1). A plugin's OK never expires: a found plugin
//    waits for the user however it was found, and only the user's deny refuses it (the registry's `refuse`).
// 7. The user's interrupt withdraws the step's cards; a cancelled or stopped session's cards resolve cancelled, as ACP
//    requires of a client (S5 §8). The first answer wins; a later one is told so.
//    An answer counts only as it arrived (`answer`'s `from`): a sealed-frame proof only from the app's main process
//    (role `app`), naming the channel minted for this card (`frameChannel`). A device's signature counts relayed by
//    any computer (review N4), from a device that may answer cards (a phone, or a desktop with its app's answer key:
//    `mayAnswerCards`, the owner's decision on N1), with its time inside `answerTimeOk`'s bounds, over the option and
//    the children checked (`clover/card-answer/2`).
//    The owner's decision, recorded here: any desktop may answer; a compromised plugin on a Windows or Linux computer
//    could approve actions on other computers.
// 8. An agent never gets an "always": `acpOutcomeFor` picks `allow_once` or `reject_once`, and a card's "always" is
//    saved as Clover's own rule instead (S5 edit 5).
// 9. A request that binds one call (`binds`: a level raise's `computer.setLevel`, the answer key's hand-over, a call
//    for another computer) is always a card, at every level, past any saved rule, the bridge and the reviewer, and
//    never offers an "always": the card is the proof, so it is answered on its own. Read-only's deny and rule 3's
//    refusal still come first; before them all, a binding that names a computer (or a `source`) the request doesn't
//    touch is refused without a card (`by: "unbound"`), so the level that judges and the card name the same
//    computers. The card is the binding's computer's, and seals `callBindingOf(binds)`: the method and
//    SHA-256 over the call's canonical JSON. An approve carries that binding back (`ApprovalDecision.binds`), and
//    `boundCardRecord` hands the approved record to whoever takes it as proof (the computer registry's
//    `{ via: "card" }` raise), which checks it binds exactly its own call: a card answered for one binding never
//    proves another.
import {
  type Card, type CardAnswerProof, type CardFieldName, type CardKind, type CardMeta, type CardOption, type CardOutcome,
  type ChangeSubject, type CloverRole, type DeviceKind, type Level, LEVELS, type SealedValue, type SignedCardAnswer,
  type CallBinding, type CardContent, type TurnOrigin, TREE_TRANSFER, answerTimeOk, callBindingInput, cardAnswerSigningInput, cardContentInput,
  cardHashInput, isUserTurn,
} from "@waifucave/clover-protocol";
import { fromBase64, type Unsubscribe } from "./common";
import { mayAnswerCards, type DeviceRegistry } from "./device-registry";
import { RUN_LATER_KINDS, type Fence } from "./fence";

/** The one call a request's card approves (rule 9), as the requester holds it: the computer that runs it (for
 *  `tree.transfer`, the destination, `source` the computer the files leave), the method, and the params as the call
 *  carries them. The card seals their digest (`callBindingOf`), never the params. */
export interface CallRequestBinding {
  computer: string;
  source?: string;
  method: string;
  params: unknown;
}

/** What a card seals for a bound request: SHA-256 over `callBindingInput(method, params)` in place of the params. */
export function callBindingOf(b: CallRequestBinding, sha256: (text: string) => string): CallBinding {
  return { computer: b.computer, ...(b.source === undefined ? {} : { source: b.source }), method: b.method, params: sha256(callBindingInput(b.method, b.params)) };
}

/** The kinds that are always cards and never offer "always" (rule 1). */
export const ALWAYS_CARD_KINDS: readonly CardKind[] = ["change", "confirm", "plugin-ok", "elicitation", "person-browser"];

/** The kinds whose card is denied after 10 minutes unanswered when the user's own message didn't start the turn
 *  (rule 6): every kind but a plugin's OK, which waits for the user. */
export function cardExpires(kind: CardKind, origin: TurnOrigin): boolean {
  if (kind === "plugin-ok") return false;
  return kind === "confirm" || !isUserTurn(origin);
}

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
  /** Defaults to approve and deny, plus "always" when there is a `ruleKey` (never on a bound card, rule 9). */
  options?: CardOption[];
  /** The one call the card approves (rule 9): always a card, its record the proof for exactly this call. */
  binds?: CallRequestBinding;
}

export type DecisionSource = "level" | "rule" | "bridge" | "card" | "expired" | "withdrawn" | "cancelled" | "fence" | "unbound";

/** Rule 9's first refusal: a binding whose computer, or `source`, isn't among the computers the request touches. */
export function bindsOutsideRequest(req: Pick<ApprovalRequest, "binds" | "computers">): boolean {
  const b = req.binds;
  if (b === undefined) return false;
  return !req.computers.includes(b.computer) || (b.source !== undefined && !req.computers.includes(b.source));
}

/** The effects that write a path (rule 3's refusal). */
export const WRITE_EFFECTS: readonly ActionEffect[] = ["edit", "move", "delete"];

/** Rule 3's refusal: the request would write a `RUN_LATER_KINDS` item on one of its computers. Each path is asked on its
 *  own, as `touches` names only the first item it finds. */
export function writesRunLater(req: Pick<ApprovalRequest, "effect" | "paths" | "computers">, fence: ((computer: string) => Pick<Fence, "touches"> | undefined) | undefined): boolean {
  if (fence === undefined || !req.paths?.length || !WRITE_EFFECTS.includes(req.effect)) return false;
  return req.computers.some((c) => {
    const f = fence(c);
    return f !== undefined && req.paths!.some((p) => { const hit = f.touches([p]); return hit !== null && RUN_LATER_KINDS.includes(hit.kind); });
  });
}

export interface ApprovalDecision {
  allowed: boolean;
  by: DecisionSource;
  /** The level that decided, for `by: "level"`. */
  level?: Level;
  cardId?: string;
  optionId?: string;
  /** The user picked an "always" option: Clover saved its own rule. */
  remembered?: boolean;
  /** An approved bound card's binding, as the card sealed it (rule 9). */
  binds?: CallBinding;
}

/** The approved card record behind a bound decision (rule 9), for a `{ via: "card" }` proof: only when a card decided,
 *  approved, and its record still binds what the decision carried back; otherwise undefined. The taker still checks
 *  the binding against its own call. */
export function boundCardRecord(broker: Pick<ApprovalBroker, "get">, d: ApprovalDecision): CardRecord | undefined {
  if (!d.allowed || d.by !== "card" || d.cardId === undefined || d.binds === undefined) return undefined;
  const r = broker.get(d.cardId);
  if (!r || r.outcome !== "approved" || r.card.options.find((o) => o.id === r.optionId)?.kind !== "approve") return undefined;
  const b = r.card.binds;
  if (!b || b.computer !== d.binds.computer || b.source !== d.binds.source || b.method !== d.binds.method || b.params !== d.binds.params) return undefined;
  return r;
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
 *  run freely at every level; deleting files, purchases and screen control outside the bot's own windows ask. Each
 *  level allows everything the one before it in `LEVELS` does (a test pins it): accept-edits is ask-risky, plus edits
 *  and moves. */
export function levelDecision(level: Level, effect: ActionEffect, ownTarget = false): "allow" | "deny" | "ask" | "review" {
  if (effect === "read" || effect === "search" || effect === "think") return "allow";
  switch (level) {
    case "read-only":
      return "deny";
    case "ask":
      return "ask";
    case "accept-edits":
      if (effect === "edit" || effect === "move") return "allow";
      return levelDecision("ask-risky", effect, ownTarget);
    case "ask-risky":
      if (effect === "delete" || effect === "purchase") return "ask";
      if (effect === "screen") return ownTarget ? "allow" : "ask";
      return "review";
    case "automatic":
      return "allow";
  }
}

/** How much a decision lets through, for the order test: deny < ask < review < allow. */
export const DECISION_RANK: Record<ReturnType<typeof levelDecision>, number> = { deny: 0, ask: 1, review: 2, allow: 3 };

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
/** The device registry, as the answer checks use it: the record and the answer key's signature check. */
export type AnswerDevices = Pick<DeviceRegistry, "get" | "verifyAnswer">;

/** Builds the verifier for device answers: the signing device may answer cards (`mayAnswerCards`), and its answer
 *  key's Ed25519 signature covers `cardAnswerSigningInput` with the option and children. The signature holds end to
 *  end, so any computer may relay it (review N4); a sealed-frame proof never reaches this (the broker checks those). */
export function deviceProofVerifier(devices: AnswerDevices): ProofVerifier {
  return async (card, answer) => {
    const proof = answer.proof;
    if (proof.via !== "device") return false;
    const device = devices.get(proof.device);
    if (!device || !mayAnswerCards(device)) return false;
    const signature = fromBase64(proof.signature);
    if (!signature) return false;
    const input = cardAnswerSigningInput({ id: card.id, hash: card.hash, option: answer.optionId, at: proof.at, children: answer.children ?? [] });
    return devices.verifyAnswer(proof.device, new TextEncoder().encode(input), signature);
  };
}

/** Each computer's record of the card ids whose signed answers it has taken as proof: a signed answer counts once. */
export interface AnswerLedger {
  /** True the first time, false ever after. */
  claim(cardId: string): boolean;
}

export type SignedAnswerVerdict = "ok" | "bad-hash" | "unbound" | "mismatch" | "not-approve" | "bad-device" | "bad-time" | "bad-signature" | "used";

/** The receiver's own card for a call (review N1, part 2): what its built-in tables say for this method and params,
 *  binding exactly this call; undefined when it shows no card for that call, which then takes no signed answer. For
 *  `tree.transfer` the binding comes from the params (`transferBinding`), never from `computer`, so the source and
 *  the destination rebuild the same card (R15). */
export type CallCardRenderer = (call: { computer: string; method: string; params: unknown }) => CardContent | undefined;

/** The calls another computer's signed answer may lift (R1, R15; J-M2's review), each with a sample call. A receiver's
 *  `CallCardRenderer` (lane C's sealed card tables, C-M3) must render each, binding exactly that call, or the feature
 *  fails closed with `mismatch` and never works; the approval-broker suite's card-table case checks it. */
export const CALL_CARD_METHODS: readonly { method: string; params: unknown }[] = [
  { method: "tree.write", params: { path: "home/Studio/notes.md", data: { encoding: "utf8", text: "x" } } },
  { method: "tree.remove", params: { path: "home/Studio/old.log" } },
  { method: "tree.move", params: { from: "home/Studio/a", to: "home/Studio/b" } },
  { method: "tree.mkdir", params: { path: "home/Studio/new" } },
  { method: "tree.symlink", params: { path: "home/Studio/link", target: "a" } },
  { method: "tree.transfer", params: { operation: "move", from: "home/Laptop1/p", to: "home/Studio/p", source: "Laptop1", destination: "Studio" } },
  { method: "terminal.open", params: { cwd: "home/Studio/p", cols: 80, rows: 24 } },
  { method: "mcp.mirror", params: { server: "github", config: {} } },
  { method: "computer.setLevel", params: { level: "automatic" } },
  { method: "tool.run", params: { tool: "mcp__github__create_issue", input: {} } },
];

/** Whether a card's binding names this computer for this call: the one that runs it; for `tree.transfer` (R15) either
 *  end, where the params name the same two computers as the binding (`destination` is `computer`, `source` is
 *  `source`). A `source` on any other method binds nothing. */
export function bindsComputer(b: CallBinding, method: string, params: unknown, self: string): boolean {
  if (b.method !== method) return false;
  if (method !== TREE_TRANSFER) return b.source === undefined && b.computer === self;
  const p = (params ?? {}) as { source?: unknown; destination?: unknown };
  if (b.source === undefined || b.source === b.computer || p.source !== b.source || p.destination !== b.computer) return false;
  return self === b.computer || self === b.source;
}

/** How a receiver takes a signed answer as proof for a call (`peer.call`, `tool.run`, a peer's `tree.*` write) or a
 *  raise (`setLevel`): it recomputes the card's hash; checks the card binds exactly this computer, method and params
 *  (`bindsComputer`: both ends of a `tree.transfer`, each with its own ledger, so each takes the one answer once);
 *  rebuilds its own card for that call (`render`) and refuses one that says anything else (`mismatch`), so a card
 *  that reads "Show the weather" can't bind a level raise; then checks the option is an approve option, that the
 *  device may answer cards (`mayAnswerCards`), the time, and the answer key's signature, and claims the card id in its
 *  ledger, so the same answer never counts twice. A receiver on another version of the tables shows its own card. */
export async function verifySignedAnswer(
  s: SignedCardAnswer,
  c: { self: string; method: string; params: unknown; now: number; sha256(text: string): string; devices: AnswerDevices; ledger: AnswerLedger; render: CallCardRenderer },
): Promise<SignedAnswerVerdict> {
  const { card } = s;
  if (c.sha256(cardHashInput(card)) !== card.hash) return "bad-hash";
  const b = card.binds;
  if (!b || !bindsComputer(b, c.method, c.params, c.self) || b.params !== c.sha256(callBindingInput(c.method, c.params))) return "unbound";
  const mine = c.render({ computer: c.self, method: c.method, params: c.params });
  if (mine === undefined || cardContentInput(mine) !== cardContentInput(card)) return "mismatch";
  if (card.options.find((o) => o.id === s.option)?.kind !== "approve") return "not-approve";
  if ((s.children ?? []).some((id) => !card.children?.some((x) => x.id === id))) return "not-approve";
  const device = c.devices.get(s.device);
  if (!device || !mayAnswerCards(device)) return "bad-device";
  if (!answerTimeOk(card, s.at, c.now)) return "bad-time";
  const signature = fromBase64(s.signature);
  const input = cardAnswerSigningInput({ id: card.id, hash: card.hash, option: s.option, at: s.at, children: s.children ?? [] });
  if (!signature || !(await c.devices.verifyAnswer(s.device, new TextEncoder().encode(input), signature))) return "bad-signature";
  return c.ledger.claim(card.id) ? "ok" : "used";
}
