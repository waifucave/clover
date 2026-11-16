// MOSS protocol area: bots as engine data (spec revision 19, §6.1 "A bot is engine data", "A bot's data is its folder
// under the home's `bots/`", §6.9, §6.10, §13 Split 1; items 101, 113, 114, 124; G8, R5). Owner: lane BT (bots as engine
// data and the one-time move). Shapes pinned by lane SP; nothing here is served yet.
//
// * A bot is a folder under the home: `bots/<seg>/` (`<seg>` the id with `/` written `--`, §5.1), holding its record
//   (`BOT_RECORD_FILE`: name, model, effort, voice, greeting, face pins, who made it), its instructions file
//   (`BOT_INSTRUCTIONS_FILE`, the `<bot-instructions>` block, read at each turn), its memory and its agents' transcripts.
//   The record is the user's: the core writes it, and no bot does (§9.1). The instructions file is written with the
//   ordinary Write and Edit, under `instructionsEditRule`.
// * Bots are listed, made, changed and removed through `bot.records`, `bot.create`, `bot.edit` and `bot.remove`; one bot's
//   single conversation is `bot.conversation`, and its routines are `routine.list { bot }` (sessions.ts). MOSS's list
//   reads each bot's last line and unread state (`bot.summaries`), which is conversation text, so it needs
//   `conversation.read` where `bot.records` needs only `bots.read`.
// * The one-time move (`BotMoveJournal`): each bot a plugin brought (the old `bot` entry, sessions.ts `BotView`) becomes a
//   record with the same id, its plugin's instructions, greeting, model and default voice, the user's layer over them,
//   and its memory, transcripts and routines where they already are. To be retired once moved: the plugin bot format
//   (`plugin-bot.ts`), `bot.setUserLayer`, `bot.importAvatar`, `bot.avatarFormats` and `BotView`'s `avatar`, `theme` and
//   `layout` (§6.1, G7, G8).
import { z } from "zod";
import { utf16 } from "./strings";
import { AnyPluginId, BotId, ChangeResult, Ok, SessionId, Text, Timestamp } from "./common";
import { coreEvent, defineEvent, defineMethod } from "./rpc";

/** The record's file and the instructions file, inside `bots/<seg>/`. */
export const BOT_RECORD_FILE = "bot.json";
export const BOT_INSTRUCTIONS_FILE = "instructions.md";
/** The move's journal, under the home: written once, when every plugin bot has been moved or left. */
export const BOT_MOVE_JOURNAL = "bots/.moved.json";

/** The living-bots kit's traits (§6.9): a name makes them all, and the user may pin the shape and the colour. The kit's
 *  own names for shapes and its ten colours are the kit's (held outside the repo, item 110), so they are plain strings
 *  here. */
export const BotFace = z.object({
  /** A shape the kit knows; unset: made from the name. */
  shape: utf16(32, 1).optional(),
  /** One of the kit's ten colour names, or `#rrggbb`; unset: made from the name. */
  color: z.union([utf16(32, 1).regex(/^[a-z-]+$/), z.string().regex(/^#[0-9a-f]{6}$/i)]).optional(),
});
export type BotFace = z.infer<typeof BotFace>;

/** A bot's voice choice (§6.6, item 113): a provider and a voice the voice plugins offer, or none. */
export const BotVoice = z.union([
  z.object({ provider: utf16(128, 1), voice: utf16(256, 1), model: utf16(128).optional() }),
  z.object({ silent: z.literal(true) }),
]);
export type BotVoice = z.infer<typeof BotVoice>;

/** Who made a bot: the person, another bot (which may then edit its instructions with no card), or the move. */
export const BotMaker = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("bot"), id: BotId }),
  z.object({ kind: z.literal("move"), plugin: AnyPluginId }),
  /** The default bot MOSS offers (Alpha, §6.2). */
  z.object({ kind: z.literal("default") }),
]);
export type BotMaker = z.infer<typeof BotMaker>;

/** The record on disk (`bots/<seg>/bot.json`), format 1. */
export const BotRecord = z.object({
  record: z.literal(1),
  id: BotId,
  name: Text,
  /** A qualified catalog id; unset: the user's default model (§6.1). */
  model: utf16(200).optional(),
  effort: utf16(32).optional(),
  voice: BotVoice.optional(),
  greeting: utf16(20_000).optional(),
  face: BotFace.optional(),
  madeBy: BotMaker,
  createdAt: Timestamp,
});
export type BotRecord = z.infer<typeof BotRecord>;

/** A bot as clients show it: its record, its main session and its state (the activity feed has the finer one). */
export const BotRecordView = BotRecord.omit({ record: true }).extend({
  mainSession: SessionId,
  /** The instructions file's size, so a client knows it isn't empty without reading it. */
  instructionsBytes: z.number().int().nonnegative(),
});
export type BotRecordView = z.infer<typeof BotRecordView>;

/** A change to a bot's record or instructions. A field set to `null` is cleared (back to what the name or the user's
 *  default gives); a field left out is unchanged. */
export const BotPatch = z.object({
  name: Text.optional(),
  instructions: utf16(200_000).optional(),
  model: utf16(200).nullable().optional(),
  effort: utf16(32).nullable().optional(),
  voice: BotVoice.nullable().optional(),
  greeting: utf16(20_000).nullable().optional(),
  face: BotFace.nullable().optional(),
});
export type BotPatch = z.infer<typeof BotPatch>;

/** One line of MOSS's list (§6.10): the bot's last line of activity, its time and whether the user has read it. */
export const BotSummary = z.object({
  id: BotId,
  last: z.object({ text: utf16(200), from: z.enum(["user", "bot", "note"]), at: Timestamp }).optional(),
  unread: z.boolean(),
});
export type BotSummary = z.infer<typeof BotSummary>;

/** Who may edit a bot's instructions file, and how (§6.1, item 114): the bot itself and a bot it made, with no card; any
 *  other bot, with a card; the user, in MOSS's window. A session that is no bot's (a coding session, an agent) never. */
export function instructionsEditRule(editor: { kind: "user" } | { kind: "bot"; id: string } | { kind: "other" }, target: Pick<BotRecord, "id" | "madeBy">): "free" | "card" | "refused" {
  if (editor.kind === "user") return "free";
  if (editor.kind === "other") return "refused";
  if (editor.id === target.id) return "free";
  if (target.madeBy.kind === "bot" && target.madeBy.id === editor.id) return "free";
  return "card";
}

/** What became of one plugin bot in the move. */
export const BotMoveOutcome = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("moved"), id: BotId, plugin: AnyPluginId }),
  /** A record of that id was already there (made earlier, or moved on another computer): kept, the plugin's ignored. */
  z.object({ outcome: z.literal("kept"), id: BotId, plugin: AnyPluginId }),
  z.object({ outcome: z.literal("failed"), id: BotId, plugin: AnyPluginId, why: utf16(500) }),
]);
export type BotMoveOutcome = z.infer<typeof BotMoveOutcome>;

/** The move's journal (`BOT_MOVE_JOURNAL`), written once: the move never runs again while it exists. */
export const BotMoveJournal = z.object({
  move: z.literal(1),
  at: Timestamp,
  bots: z.array(BotMoveOutcome).max(1024),
});
export type BotMoveJournal = z.infer<typeof BotMoveJournal>;

export const BotRecordChangedEvent = coreEvent("bot_record_changed", { bot: BotRecordView });
export const BotRecordRemovedEvent = coreEvent("bot_record_removed", { id: BotId });
export const BotSummaryChangedEvent = coreEvent("bot_summary_changed", { summary: BotSummary });
export const BotsMovedEvent = coreEvent("bots_moved", { journal: BotMoveJournal });

export const BOTS_METHODS = {
  botRecords: defineMethod({
    name: "bot.records", owner: "BT", roles: ["app", "cli", "remote", "layer"], capability: "bots.read",
    params: z.object({}),
    result: z.object({ bots: z.array(BotRecordView).max(1024) }),
    doc: "Every bot as engine data: its record, its main session and the size of its instructions.",
  }),
  botCreate: defineMethod({
    /** The user's, in MOSS's window or the CLI. A bot making a bot is an open point (the lane map's undefined points). */
    name: "bot.create", owner: "BT", roles: ["app", "cli"], userOnly: true,
    params: z.object({ name: Text, instructions: utf16(200_000).optional(), model: utf16(200).optional(), effort: utf16(32).optional(), voice: BotVoice.optional(), face: BotFace.optional() }),
    result: z.object({ bot: BotRecordView }),
    doc: "Makes a bot: a folder under the home's bots/ with its record and instructions file; its id comes from its name.",
  }),
  botEdit: defineMethod({
    name: "bot.edit", owner: "BT", roles: ["app", "cli", "layer"], userOnly: true, change: "core",
    params: z.object({ id: BotId, patch: BotPatch }),
    result: ChangeResult,
    doc: "Changes a bot's record or instructions for the user; the next turn uses it. From a plugin's layer it is a sealed card.",
  }),
  botRemove: defineMethod({
    name: "bot.remove", owner: "BT", roles: ["app", "cli"], userOnly: true,
    params: z.object({ id: BotId }),
    result: Ok,
    doc: "Removes a bot; what is kept of its folder, memory and conversation is an open point.",
  }),
  botConversation: defineMethod({
    name: "bot.conversation", owner: "BT", roles: ["app", "cli", "remote", "layer"], capability: "conversation.read",
    params: z.object({ id: BotId, before: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500) }),
    result: z.object({ session: SessionId, events: z.array(z.record(z.string(), z.unknown())), hasMore: z.boolean() }),
    doc: "A page of one bot's single conversation, newest last (its main session's history); sealed card fields never reach a plugin.",
  }),
  botSummaries: defineMethod({
    name: "bot.summaries", owner: "BT", roles: ["app", "remote", "layer"], capability: "conversation.read",
    params: z.object({}),
    result: z.object({ summaries: z.array(BotSummary).max(1024) }),
    doc: "Each bot's last line of activity, its time and whether the user has read it, for MOSS's list.",
  }),
  botMarkRead: defineMethod({
    name: "bot.markRead", owner: "BT", roles: ["app", "remote"], userOnly: true,
    params: z.object({ id: BotId, at: Timestamp }),
    result: Ok,
    doc: "The user has read a bot's conversation up to a time: its unread dot goes.",
  }),
  botMoveStatus: defineMethod({
    name: "bot.move.status", owner: "BT", roles: ["app", "cli"],
    params: z.object({}),
    result: z.object({ journal: BotMoveJournal.optional(), pending: z.array(AnyPluginId).max(1024) }),
    doc: "The one-time move of plugin bots into records: what it did, or which plugin bots still wait for it.",
  }),
} as const;

export const BOTS_EVENTS = {
  botRecordChanged: defineEvent({
    type: "bot_record_changed", owner: "BT", roles: ["app", "cli", "remote", "layer"], schema: BotRecordChangedEvent, capability: "bots.read",
    fixture: { type: "bot_record_changed", ts: 1781270000000, bot: { id: "alpha", name: "Alpha", model: "anthropic/claude-sonnet", madeBy: { kind: "default" }, createdAt: 1781270000000, mainSession: "s_alpha", instructionsBytes: 1200 } },
    doc: "A bot was made or its record or instructions changed.",
  }),
  botRecordRemoved: defineEvent({
    type: "bot_record_removed", owner: "BT", roles: ["app", "cli", "remote", "layer"], schema: BotRecordRemovedEvent, capability: "bots.read",
    fixture: { type: "bot_record_removed", ts: 1781270000000, id: "nova" },
    doc: "A bot was removed.",
  }),
  botSummaryChanged: defineEvent({
    type: "bot_summary_changed", owner: "BT", roles: ["app", "remote", "layer"], schema: BotSummaryChangedEvent, capability: "conversation.read",
    fixture: { type: "bot_summary_changed", ts: 1781270000000, summary: { id: "alpha", last: { text: "Done: the report is in your folder.", from: "bot", at: 1781270000000 }, unread: true } },
    doc: "A bot's last line or unread state changed.",
  }),
  botsMoved: defineEvent({
    type: "bots_moved", owner: "BT", roles: ["app", "cli"], schema: BotsMovedEvent,
    fixture: { type: "bots_moved", ts: 1781270000000, journal: { move: 1, at: 1781270000000, bots: [{ outcome: "moved", id: "alpha", plugin: "alpha" }] } },
    doc: "The one-time move of plugin bots into records ran.",
  }),
} as const;
