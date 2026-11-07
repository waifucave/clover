// Clover protocol area: approvals (spec §5.5 "Approvals are core data that plugins show but cannot read", §9.1,
// §9.3). Owner: lane C (sealed-card data, ids, hashes and signed answers, C-M3); lane E renders sealed frames
// (E-M3). Pinned by lane B at M0.
//
// A card is core data. The app's main process and the native iOS app get its sealed fields; a plugin with the
// `approvals` capability hears only which cards are pending and where (`card_pending`), and places their sealed
// frames, never their text. The core takes an answer only from a sealed frame, through the app's main process (role
// `app`) on a channel the core minted for that card (`card.frame`), or from a paired device's own app, signed with
// its answer key over the card's id and hash, the option, the time and the children checked. The answer key is apart
// from the device's link key (review N1): a phone's own key, or a desktop app's key the OS keeps from plugin code where
// it can (`ANSWER_KEY_HOLDERS`; the owner accepted that on Linux, and on Windows without a TPM, it can't).
// Servers, cloud computers and browsers never sign: the web companion answers no card. A signed answer counts
// whichever computer relays it (review N4); a sealed frame's only from the app on its own channel. The receiver
// rebuilds its own card for a bound call and refuses a signed card that says anything else. Every device shows a
// pending card; the first answer wins, and a signed answer is used once per card id on every computer, since it also
// travels as the proof of a raise (`SignedCardAnswer`).
//
// The card's hash is SHA-256 over its canonical JSON (RFC 8785, JCS: keys sorted by UTF-16 code units, numbers and
// strings as ECMAScript serializes them), never over another language's default encoder. The phone recomputes the hash
// from the card it shows and signs that, never the hash it was sent. `generated/clover/fixtures/card-hash-vectors.json`
// pins the encoding (nulls, `/`, non-ASCII, U+2028, emoji, large integers).
import { z } from "zod";
import { utf16 } from "./strings";
import {
  AnyPluginId, BotId, CardId, ComputerName, DeviceId, Empty, SessionId, Sha256Hex, Text, Timestamp, TreePath, TurnOrigin,
} from "./common";
import { coreEvent, defineEvent, defineMethod } from "./rpc";

/** What a card asks about. */
export const CARD_KINDS = [
  /** A bot's tool call at its computer's level (risky commands, deletes, purchases, screen control; §9.1). */
  "tool",
  /** An ACP agent's `session/request_permission` (§9.3). */
  "agent-permission",
  /** A plugin's OK: found on disk, or an update or edit that adds a trigger, or new card styling (§5.1, §5.5, §5.6). */
  "plugin-ok",
  /** A sensitive change, or a change to the core's settings from a layer other than `clover`'s (§5.5). */
  "change",
  /** A plugin's `confirm(text)` (§5.4). */
  "confirm",
  /** An MCP server's or an agent's URL-mode elicitation, such as a sign-in link (spike S5 §7, §12): the link is sealed,
   *  so no plugin can swap it. `host` is the link's site and `command` the whole link; approving opens it in the
   *  user's browser (the app does, never a plugin), denying declines. */
  "elicitation",
  /** A session asks to drive the person's own logged-in browser partition, `user` (ruling R10; lane L): a bot or a
   *  coding session uses its own partition otherwise. One card per session, never an "always"; on a yes the browser
   *  lets that session alone use it (`allowPersonsBrowser(session, true)`). */
  "person-browser",
] as const;
export const CardKind = z.enum(CARD_KINDS);
export type CardKind = z.infer<typeof CardKind>;

/** The sensitive changes (§5.5 "Sensitive changes are approvals too"), plus the cloud computer cards (§9.2), an agent
 *  with no sandbox (§9.3) and a core setting changed from another layer. */
export const ChangeSubject = z.enum([
  "routine-level", "computer-level", "device-add", "device-revoke", "main-computer", "plugin-load", "dev-folder",
  "repo-trust", "saved-rule", "connector-permission", "computer-create", "computer-resize", "computer-delete",
  "agent-unsandboxed", "core-setting",
]);
export type ChangeSubject = z.infer<typeof ChangeSubject>;

/** The sealed fields a plugin can place by name with `<Card.Field name>` (plugin SDK UI API). A card may leave any
 *  out; a plugin may leave any out too (§5.5). `title`: the card's heading. `what`: what it asks, in a sentence ("Run
 *  this command?"). `command`: the command, the edit or the call's input, as code. `computer`: where it runs. `risk`:
 *  the safety reviewer's verdict. `reason`: why the bot wants it. `source`: who asks (the bot, the agent, the plugin
 *  with its id and source). `host`: the site a link or a fetch goes to (an elicitation's link). `paths`: the files it
 *  touches. `detail`: anything more, as rows. `expires`: when it is denied unanswered. */
export const CARD_FIELD_NAMES = [
  "title", "what", "command", "computer", "risk", "reason", "source", "host", "paths", "detail", "expires",
] as const;
export const CardFieldName = z.enum(CARD_FIELD_NAMES);
export type CardFieldName = z.infer<typeof CardFieldName>;

/** A sealed field's content. Strings come from the built-in tables and trusted packs only (§5.5 "Translations").
 *  Wherever a sealed field is drawn (the app's frames, the iOS app), control characters and bidirectional marks show
 *  as visible escapes (`\u202E`), and a field too long for its space is never cut silently: it says so and offers the
 *  rest, so what the user approves is what runs. */
/** Sealed text holds no lone surrogate (review N6): Swift's strings can't, so the iOS app would hash another card. A
 *  card's hash maps any that slips through to U+FFFD anyway (`canonicalJson`). */
const sealed = (max: number) => utf16(max).refine((s) => s.isWellFormed(), { message: "a lone surrogate" });

export const SealedValue = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: sealed(4000) }),
  z.object({ type: z.literal("code"), code: sealed(64_000), language: utf16(32).optional() }),
  z.object({ type: z.literal("list"), items: z.array(sealed(4000)).max(200) }),
  z.object({ type: z.literal("rows"), rows: z.array(z.object({ label: sealed(200), value: sealed(4000) })).max(100) }),
]);
export type SealedValue = z.infer<typeof SealedValue>;

/** An option's id, as cards and answers name it. */
export const CARD_OPTION_ID_RE = /^[a-z0-9_-]{1,64}$/;
export const CardOptionId = utf16(64, 1).regex(CARD_OPTION_ID_RE);

/** A sealed button. `<Card.Approve>` and `<Card.Deny>` place the first option of their kind, or a named one. An
 *  "always" option saves Clover's own rule; an agent still gets `allow_once` (§9.3, spike S5 edit 5). */
export const CardOption = z.object({
  id: CardOptionId,
  kind: z.enum(["approve", "deny"]),
  label: Text,
  remember: z.enum(["always"]).optional(),
});
export type CardOption = z.infer<typeof CardOption>;

/** Who a card is for and where it came from, without its text: what a plugin with `approvals` hears. */
export const CardMeta = z.object({
  id: CardId,
  kind: CardKind,
  computer: ComputerName.nullable(),
  session: SessionId.optional(),
  bot: BotId.optional(),
  /** A plugin's card: whose. */
  pluginId: AnyPluginId.optional(),
  origin: TurnOrigin,
  issuedAt: Timestamp,
  /** Set when the turn's origin isn't the user's: denied then, 10 minutes after it was issued (§5.5). */
  expiresAt: Timestamp.nullable(),
  /** The options' ids and kinds, and which one is "always", so a plugin can place each button; never their labels. */
  options: z.array(CardOption.pick({ id: true, kind: true, remember: true })).max(8),
});
export type CardMeta = z.infer<typeof CardMeta>;

/** The one call a card approves, when it approves a call: the computer that runs it, the method, and SHA-256 over the
 *  canonical JSON of `{ method, params }` (`callBindingInput`). A receiver takes a signed answer as proof only for the
 *  call its card binds (§8.5: a raise travels only with its signed answer). `source` only for `tree.transfer` (R15):
 *  the computer the files leave, `computer` being the one they go to; either end takes the answer, once. */
export const CallBinding = z.object({ computer: ComputerName, source: ComputerName.optional(), method: utf16(128, 1), params: Sha256Hex });
export type CallBinding = z.infer<typeof CallBinding>;

/** Ruling R15, as lane J built it (#179's review, F2): a move or copy between two computers is one call that one card
 *  binds, `tree.transfer`, with the operation, both tree paths and both computers. The card's `binds.computer` is the
 *  `destination` and `binds.source` the `source`; each holder rebuilds the card from these params and checks the one
 *  signed answer against it (`verifySignedAnswer` takes either end as itself). A binding only, never a method on the
 *  wire: the files move by `tree.receive` and `tree.send` (computers.ts). */
export const TREE_TRANSFER = "tree.transfer";
export const TreeTransferParams = z.strictObject({
  operation: z.enum(["move", "copy"]),
  from: TreePath,
  to: TreePath,
  source: ComputerName,
  destination: ComputerName,
});
export type TreeTransferParams = z.infer<typeof TreeTransferParams>;

/** The whole card, for the app's main process and the native iOS app only. `hash` is SHA-256 over
 *  `cardHashInput(card)`; a signed answer covers it. */
export const Card = CardMeta.extend({
  hash: Sha256Hex,
  change: ChangeSubject.optional(),
  binds: CallBinding.optional(),
  fields: z.partialRecord(CardFieldName, SealedValue),
  options: z.array(CardOption).min(1).max(8),
  /** A plugin OK covers the plugin and its children, with a checkbox per child (§5.1). */
  children: z.array(z.object({ id: AnyPluginId, label: Text, checked: z.boolean() })).max(256).optional(),
});
export type Card = z.infer<typeof Card>;

/** How an answer proves it came from the user (§5.5). A sealed frame's click or key press counts only when the app
 *  saw it come from the hardware, while the button showed whole and uncovered and no computer-use action ran; the core
 *  takes it only from role `app`, on the channel it minted for that card. A device's answer is signed with its answer
 *  key, apart from its link key (a phone's own, a desktop app's; never a server's, a cloud computer's or a browser's,
 *  review N1), with `at` inside `answerTimeOk`'s bounds, and counts whichever computer relays it (review N4). */
export const CardAnswerProof = z.discriminatedUnion("via", [
  z.object({
    via: z.literal("sealed-frame"),
    /** The channel the core minted for this card's frame (`card.frame`). */
    frame: utf16(128, 1),
    input: z.enum(["click", "key"]),
    at: Timestamp,
  }),
  z.object({
    via: z.literal("device"),
    device: DeviceId,
    at: Timestamp,
    /** Ed25519 with the device's answer key over `cardAnswerSigningInput(...)`, base64. */
    signature: utf16(256, 1),
  }),
]);
export type CardAnswerProof = z.infer<typeof CardAnswerProof>;

export const CardOutcome = z.enum(["approved", "denied", "expired", "withdrawn", "cancelled"]);
export type CardOutcome = z.infer<typeof CardOutcome>;

/** Canonical JSON: keys sorted at every depth, no spaces. The input to a card's hash. */
export function canonicalJson(value: unknown): string {
  // A lone surrogate becomes U+FFFD first, so every language hashes the same string (review N6).
  if (typeof value === "string") return JSON.stringify(value.toWellFormed());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k.toWellFormed())}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** What a card's `hash` covers: everything but the hash itself. */
export function cardHashInput(card: Omit<Card, "hash"> | Card): string {
  const { hash: _hash, ...rest } = card as Card;
  return canonicalJson(rest);
}

/** What a card says, apart from where and when it was shown: its kind, the change or call it approves, its sealed
 *  fields and its options (review N1). A receiver that takes a signed answer as proof rebuilds its own card for the
 *  call from its built-in tables and compares this, so a card whose text says one thing can't bind another call. */
export type CardContent = Pick<Card, "kind" | "fields" | "options"> & Partial<Pick<Card, "change" | "binds" | "children">>;
export function cardContentInput(card: CardContent): string {
  return canonicalJson({ kind: card.kind, change: card.change, binds: card.binds, fields: card.fields, options: card.options, children: card.children?.map(({ id, label }) => ({ id, label })) });
}

/** What a paired device signs to answer a card: the card's id and hash, the option, the time, and the children it
 *  checked (a plugin OK's checkboxes), sorted and joined by `,` on the last line (empty when there are none). */
export function cardAnswerSigningInput(a: { id: string; hash: string; option: string; at: number; children?: readonly string[] }): string {
  const children = [...(a.children ?? [])].sort().join(",");
  return `clover/card-answer/2\n${a.id}\n${a.hash}\n${a.option}\n${a.at}\n${children}`;
}

/** How far a device's clock may stray from the shared clock when it signs an answer. */
export const CARD_ANSWER_SKEW_MS = 60_000;

/** An answer's time must fall between the card's issue (less the skew) and the earlier of now (plus the skew) and the
 *  card's expiry. */
export function answerTimeOk(card: Pick<Card, "issuedAt" | "expiresAt">, at: number, now: number): boolean {
  const latest = Math.min(now + CARD_ANSWER_SKEW_MS, card.expiresAt ?? Number.POSITIVE_INFINITY);
  return at >= card.issuedAt - CARD_ANSWER_SKEW_MS && at <= latest;
}

/** The text a `CallBinding`'s `params` hash covers. */
export function callBindingInput(method: string, params: unknown): string {
  return canonicalJson({ method, params });
}

/** A paired device's answer as proof for another computer: the whole card, so the receiver recomputes its hash and
 *  checks what it binds, and the signature over `cardAnswerSigningInput`. The receiver verifies it itself, takes only
 *  an approve option, and uses a card id once (C's `verifySignedAnswer`). */
export const SignedCardAnswer = z.object({
  card: Card,
  option: CardOptionId,
  children: z.array(AnyPluginId).max(256).optional(),
  device: DeviceId,
  at: Timestamp,
  /** Ed25519 over `cardAnswerSigningInput(...)`, base64. */
  signature: utf16(256, 1),
});
export type SignedCardAnswer = z.infer<typeof SignedCardAnswer>;

export const APPROVALS_METHODS = {
  cardList: defineMethod({
    name: "card.list", owner: "C", roles: ["app", "remote"],
    params: Empty, result: z.object({ cards: z.array(Card) }),
    doc: "Every pending card with its sealed fields, for the app's main process and the iOS app.",
  }),
  cardGet: defineMethod({
    name: "card.get", owner: "C", roles: ["app", "remote"],
    params: z.object({ id: CardId }),
    result: z.object({
      card: Card,
      outcome: CardOutcome.optional(),
      option: utf16(64).optional(),
      /** The device whose answer won, when one did. */
      device: DeviceId.optional(),
      resolvedAt: Timestamp.optional(),
    }),
    doc: "One card, pending or resolved, so the app can still draw a resolved card's sealed fields where it shows.",
  }),
  cardPending: defineMethod({
    name: "card.pending", owner: "C", roles: ["layer"], capability: "approvals",
    params: Empty, result: z.object({ cards: z.array(CardMeta) }),
    doc: "Pending cards' ids and computers, never their text (§5.5 `approvals.watch`).",
  }),
  cardFrame: defineMethod({
    name: "card.frame", owner: "C", roles: ["app"],
    params: z.object({ id: CardId }), result: z.object({ channel: utf16(128, 1) }),
    doc: "Mints the channel a card's sealed frame answers on; a sealed-frame proof names it, and only for this card.",
  }),
  cardAnswer: defineMethod({
    name: "card.answer", owner: "C", roles: ["app", "remote", "peer"],
    params: z.object({
      id: CardId, hash: Sha256Hex, option: CardOptionId, proof: CardAnswerProof,
      /** A plugin OK's checked children; a device signs them too. */
      children: z.array(AnyPluginId).max(256).optional(),
    }),
    result: z.object({ accepted: z.boolean(), reason: utf16(500).optional() }),
    doc: "Answers a card from a sealed frame, or with a paired device's signature; the first answer wins.",
  }),
  cardConfirm: defineMethod({
    name: "card.confirm", owner: "C", roles: ["layer"],
    /** The plugin is the layer connection's own; a host half's `confirm` goes through `pluginHost.api`. */
    params: z.object({ text: utf16(2000, 1) }),
    result: z.object({ answer: z.enum(["yes", "no", "timeout"]) }),
    doc: "A plugin's `confirm(text)`: a sealed card naming the plugin; denied after 10 minutes unanswered (§5.4).",
  }),
} as const;

export const CardRequestedEvent = coreEvent("card_requested", { card: Card });
export const CardPendingEvent = coreEvent("card_pending", { card: CardMeta });
export const CardResolvedEvent = coreEvent("card_resolved", {
  id: CardId,
  outcome: CardOutcome,
  option: utf16(64).optional(),
  /** The device that answered, when one did. */
  device: DeviceId.optional(),
});

export const APPROVALS_EVENTS = {
  cardRequested: defineEvent({
    type: "card_requested", owner: "C", roles: ["app", "remote"], schema: CardRequestedEvent,
    fixture: {
      type: "card_requested", ts: 1781270000000,
      card: {
        id: "card_0a1b2c3d", kind: "tool", computer: "Studio", session: "s_alpha", bot: "alpha", origin: "routine",
        issuedAt: 1781270000000, expiresAt: 1781270600000,
        hash: "a".repeat(64),
        fields: {
          title: { type: "text", text: "Run a command?" },
          command: { type: "code", code: "rm -rf build/", language: "sh" },
          computer: { type: "text", text: "Studio" },
          risk: { type: "text", text: "Deletes a folder" },
        },
        options: [
          { id: "allow_once", kind: "approve", label: "Allow" },
          { id: "allow_always", kind: "approve", label: { en: "Always allow", fr: "Toujours autoriser" }, remember: "always" },
          { id: "deny", kind: "deny", label: "Deny" },
        ],
      },
    },
    doc: "A new card, with its sealed fields.",
  }),
  cardPending: defineEvent({
    type: "card_pending", owner: "C", roles: ["layer"], capability: "approvals", schema: CardPendingEvent,
    fixture: {
      type: "card_pending", ts: 1781270000000,
      card: {
        id: "card_0a1b2c3d", kind: "tool", computer: "Studio", session: "s_alpha", bot: "alpha", origin: "routine",
        issuedAt: 1781270000000, expiresAt: 1781270600000,
        options: [{ id: "allow_once", kind: "approve" }, { id: "deny", kind: "deny" }],
      },
    },
    doc: "A new card, without its text, for plugins that place sealed frames.",
  }),
  cardResolved: defineEvent({
    type: "card_resolved", owner: "C", roles: ["app", "remote", "layer"], capability: "approvals",
    schema: CardResolvedEvent,
    fixture: { type: "card_resolved", ts: 1781270004000, id: "card_0a1b2c3d", outcome: "approved", option: "allow_once" },
    doc: "A card was answered, expired, withdrawn (an interrupt) or cancelled (its session stopped).",
  }),
} as const;
