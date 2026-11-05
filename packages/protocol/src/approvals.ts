// Clover protocol area: approvals (spec §5.5 "Approvals are core data that plugins show but cannot read", §9.1,
// §9.3). Owner: lane C (sealed-card data, ids, hashes and signed answers, C-M3); lane E renders sealed frames
// (E-M3). Pinned by lane B at M0.
//
// A card is core data. The app's main process and the native iOS app get its sealed fields; a plugin with the
// `approvals` capability hears only which cards are pending and where (`card_pending`), and places their sealed
// frames, never their text. The core takes an answer only from a sealed frame, over a channel the app's main process
// opens for that frame alone, or from a paired device's own app, signed with its device key over the card's id and
// hash. Every device shows a pending card; the first answer wins.
import { z } from "zod";
import { utf16 } from "./strings";
import {
  AnyPluginId, BotId, CardId, ComputerName, DeviceId, Empty, SessionId, Sha256Hex, Text, Timestamp, TurnOrigin,
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

/** A sealed field's content. Strings come from the built-in tables and trusted packs only (§5.5 "Translations"). */
export const SealedValue = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: utf16(4000) }),
  z.object({ type: z.literal("code"), code: utf16(64_000), language: utf16(32).optional() }),
  z.object({ type: z.literal("list"), items: z.array(utf16(4000)).max(200) }),
  z.object({ type: z.literal("rows"), rows: z.array(z.object({ label: utf16(200), value: utf16(4000) })).max(100) }),
]);
export type SealedValue = z.infer<typeof SealedValue>;

/** A sealed button. `<Card.Approve>` and `<Card.Deny>` place the first option of their kind, or a named one. An
 *  "always" option saves Clover's own rule; an agent still gets `allow_once` (§9.3, spike S5 edit 5). */
export const CardOption = z.object({
  id: utf16(64, 1).regex(/^[a-z0-9_-]+$/),
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

/** The whole card, for the app's main process and the native iOS app only. `hash` is SHA-256 over
 *  `cardHashInput(card)`; a signed answer covers it. */
export const Card = CardMeta.extend({
  hash: Sha256Hex,
  change: ChangeSubject.optional(),
  fields: z.partialRecord(CardFieldName, SealedValue),
  options: z.array(CardOption).min(1).max(8),
  /** A plugin OK covers the plugin and its children, with a checkbox per child (§5.1). */
  children: z.array(z.object({ id: AnyPluginId, label: Text, checked: z.boolean() })).max(256).optional(),
});
export type Card = z.infer<typeof Card>;

/** How an answer proves it came from the user (§5.5). A sealed frame's click or key press counts only when the app
 *  saw it come from the hardware, while the button showed whole and uncovered and no computer-use action ran. */
export const CardAnswerProof = z.discriminatedUnion("via", [
  z.object({
    via: z.literal("sealed-frame"),
    /** The channel the app's main process opened for that frame alone. */
    frame: utf16(128, 1),
    input: z.enum(["click", "key"]),
    at: Timestamp,
  }),
  z.object({
    via: z.literal("device"),
    device: DeviceId,
    at: Timestamp,
    /** Ed25519 over `cardAnswerSigningInput(...)`, base64. */
    signature: utf16(256, 1),
  }),
]);
export type CardAnswerProof = z.infer<typeof CardAnswerProof>;

export const CardOutcome = z.enum(["approved", "denied", "expired", "withdrawn", "cancelled"]);
export type CardOutcome = z.infer<typeof CardOutcome>;

/** Canonical JSON: keys sorted at every depth, no spaces. The input to a card's hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** What a card's `hash` covers: everything but the hash itself. */
export function cardHashInput(card: Omit<Card, "hash"> | Card): string {
  const { hash: _hash, ...rest } = card as Card;
  return canonicalJson(rest);
}

/** What a paired device signs to answer a card: the card's id and hash, the option and the time. */
export function cardAnswerSigningInput(a: { id: string; hash: string; option: string; at: number }): string {
  return `clover/card-answer/1\n${a.id}\n${a.hash}\n${a.option}\n${a.at}`;
}

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
    name: "card.pending", owner: "C", roles: ["layer", "plugin-host"], capability: "approvals",
    params: Empty, result: z.object({ cards: z.array(CardMeta) }),
    doc: "Pending cards' ids and computers, never their text (§5.5 `approvals.watch`).",
  }),
  cardAnswer: defineMethod({
    name: "card.answer", owner: "C", roles: ["app", "remote", "peer"],
    params: z.object({ id: CardId, hash: Sha256Hex, option: utf16(64, 1), proof: CardAnswerProof }),
    result: z.object({ accepted: z.boolean(), reason: utf16(500).optional() }),
    doc: "Answers a card from a sealed frame, or with a paired device's signature; the first answer wins.",
  }),
  cardConfirm: defineMethod({
    name: "card.confirm", owner: "C", roles: ["layer", "plugin-host"],
    params: z.object({ pluginId: AnyPluginId, text: utf16(2000, 1) }),
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
    type: "card_pending", owner: "C", roles: ["layer", "plugin-host"], capability: "approvals", schema: CardPendingEvent,
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
    type: "card_resolved", owner: "C", roles: ["app", "remote", "layer", "plugin-host"], capability: "approvals",
    schema: CardResolvedEvent,
    fixture: { type: "card_resolved", ts: 1781270004000, id: "card_0a1b2c3d", outcome: "approved", option: "allow_once" },
    doc: "A card was answered, expired, withdrawn (an interrupt) or cancelled (its session stopped).",
  }),
} as const;
