// MOSS protocol area: sessions and bots (spec §6, §7, §9.3). Owner: lane D (bots, sessions, memory, routines),
// with lane A for the runtime underneath (plan §4). Pinned by lane B at M0.
//
// A session is any running conversation: a bot's main conversation, a side thread (a routine run), a background
// agent, or a coding session the user started (§9.3). The user's message interrupts a bot's main conversation at
// once (§6.4); messages from other bots, routines, agents and plugins fold into the running turn after its next
// tool call. A session's log keeps the inherited `SessionEvent` stream (events.ts); the MOSS kinds below join it when
// lane D wires them through the inherited checklist (docs/claude/protocol-and-remote.md).
import { z } from "zod";
import { utf16 } from "./strings";
import {
  AnyPluginId, BotId, ChangeResult, ComputerName, Cursor, DeviceId, Empty, Ok, SessionId, SessionKind, Text,
  Timestamp, TreePath,
} from "./common";
import { canonicalJson } from "./approvals";
import { STAGE_IMAGE_B64_MAX_LENGTH, STAGE_IMAGE_MEDIA_TYPES } from "./methods";
import { coreEvent, defineEvent, defineMethod } from "./rpc";

// -------------------------------------------------------------------------------------------------
// Bots
// -------------------------------------------------------------------------------------------------

/** A bot's state as clients show it. `asleep`: no computer that can run it is connected (§6.4, §14.2 item 18). */
export const BotState = z.enum(["idle", "thinking", "asleep", "paused"]);

/** To be retired in part by spec revision 19 (§6.1, G7, G8): a bot becomes engine data (`BotRecordView`, bots.ts) and its
 *  `theme`, `layout` and the user layer go with the plugin bot (a figure left the platform for the avatar plugin); lane BT moves the bots over (`bot.move.status`). */
export const BotView = z.object({
  /** The bot's id is its plugin's id (§6.1). */
  id: BotId,
  name: Text,
  /** Asset URL of its portrait, when it has one. */
  portrait: utf16(4096).optional(),
  /** A qualified catalog id; the user's default model when there is no key for the bot's own (§6.1). */
  model: utf16(200),
  effort: utf16(32).optional(),
  theme: utf16(256).optional(),
  /** The fields the user layer sets over the plugin's (§6.1). */
  userLayer: z.array(z.enum(["name", "instructions", "model", "effort", "theme", "layout", "lan"])),
  /** The bot's browser tabs may reach the LAN (private and link-local addresses; never loopback or metadata, lane L's
   *  #260). Only the person sets it, in the user layer (`bot.setUserLayer`, theirs alone); it is never a plugin's. */
  lan: z.boolean().optional(),
  state: BotState,
  /** The computer running its main conversation (the main, or the takeover computer). */
  computer: ComputerName.optional(),
  mainSession: SessionId,
});
export type BotView = z.infer<typeof BotView>;

/** A change to a bot's user layer (§6.1). A field set to `null` is cleared (Reset); a field left out is unchanged.
 *  Bots can't write the user layer (§9.1). */
export const UserLayerPatch = z.object({
  name: Text.nullable().optional(),
  instructions: utf16(200_000).nullable().optional(),
  model: utf16(200).nullable().optional(),
  effort: utf16(32).nullable().optional(),
  theme: utf16(256).nullable().optional(),
  layout: utf16(4096).nullable().optional(),
  /** The bot's LAN setting (lane L's `lanBots`): written only by the person, through their own app or terminal, or a
   *  sealed card a plugin's request becomes. A bot, a session or a plugin never sets it: `bot.setUserLayer` is the
   *  user's alone, and a plugin's `bot` entry has no such field. */
  lan: z.boolean().nullable().optional(),
});
export type UserLayerPatch = z.infer<typeof UserLayerPatch>;

// -------------------------------------------------------------------------------------------------
// Sessions
// -------------------------------------------------------------------------------------------------

/** A session's state (spike S5 §8 for agents; bots and side threads use the same set). `failed` carries why. */
export const SESSION_STATUSES = ["starting", "ready", "prompting", "cancelling", "idle", "stopped", "failed"] as const;
export const SessionStatus = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatus>;
export const SessionFailure = z.enum(["sign-in", "crashed", "stalled", "error"]);
export type SessionFailure = z.infer<typeof SessionFailure>;

/** A session from the app MOSS replaces, in the archive view (§14.1 "Existing … installs", review S16): readable,
 *  never a bot's history. */
export const ArchivedSessionView = z.object({
  id: utf16(128, 1),
  title: utf16(500).optional(),
  mode: z.enum(["code", "chat", "dispatch"]),
  /** A code session's project folder. */
  project: utf16(4096).optional(),
  model: utf16(256).optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** How many messages the session holds: the user's and the assistant's, as the store's index counts them. */
  messages: z.number().int().nonnegative(),
});
export type ArchivedSessionView = z.infer<typeof ArchivedSessionView>;

export const SessionView = z.object({
  id: SessionId,
  kind: SessionKind,
  bot: BotId.optional(),
  /** A side thread's or a background agent's bot's main session. */
  parent: SessionId.optional(),
  /** The computer running it (§6.4). */
  computer: ComputerName,
  title: utf16(200).optional(),
  status: SessionStatus,
  failure: SessionFailure.optional(),
  startedAt: Timestamp,
  updatedAt: Timestamp,
  /** A background agent's or coding session's backend (an `agentBackends` id, §9.3). */
  backend: utf16(128).optional(),
  model: utf16(200).optional(),
  effort: utf16(32).optional(),
  /** An agent's root folder in the tree (§9.1). */
  root: TreePath.optional(),
  /** A coding session's or an agent's git branch in its root, for the sidebar's badge (lane F's ask). */
  branch: utf16(256, 1).optional(),
  /** How many files it changed that aren't committed yet: a count only, for the sidebar's badge (lane F's ask). */
  changes: z.number().int().nonnegative().optional(),
  /** A routine run's routine. */
  routine: utf16(128).optional(),
  /** A background agent started from a plugin's agent definition: `<plugin>:<id>`, as the core read it from the
   *  plugin registry (never the bot's words). */
  definition: utf16(200).optional(),
  /** What waits for the user in it: pending cards and unanswered questions, as counts only (the shell's needs-you
   *  marks; a card's content stays behind `approvals` and the sealed frames). */
  needsYou: z.object({ cards: z.number().int().nonnegative(), questions: z.number().int().nonnegative() }).optional(),
  /** When this computer's copy last forked from the computer running the session and was cut back to follow it: what
   *  this computer held from there was kept aside and went to that computer, which shows it after its own, marked late
   *  ("Earlier on <computer>"). A client reads the history again when it changes. */
  rebasedAt: Timestamp.optional(),
  /** The user put this session in the archive: the sidebar's lists leave it out (the Archive page is where it lives). Absent: not archived. */
  archived: z.boolean().optional(),
});
export type SessionView = z.infer<typeof SessionView>;

/** A user's message. The daemon stamps it with the device it came from and the shared clock's send time (§6.4,
 *  §9.1 "Each user message says which device it came from"). An attached image becomes part of the transcript;
 *  other attachments are passed as folder-tree paths (§8.5). */
export const UserMessageInput = z.object({
  text: utf16(1_000_000),
  /** Images the client staged, by the path the daemon gave it. */
  images: z.array(z.object({ n: z.number().int().positive(), path: utf16(4096, 1) })).max(32).optional(),
  files: z.array(z.object({ n: z.number().int().positive(), path: TreePath })).max(64).optional(),
  /** The client's id for this message, so a resend is not a second message. */
  clientMessageId: utf16(128, 1),
  /** When the client sent it, on the shared clock (§6.4): with the device, it orders the user's messages, so one sent
   *  earlier from a slower device goes first (`(sentAt, device)`). A client with no synced clock leaves it out, and the
   *  daemon stamps the time it received the message (lane D's request). The daemon that receives it clamps it to its
   *  receive time plus or minus `SENT_AT_WINDOW_MS` (`clampSentAt`, review N5), so no stamp jumps the queue or
   *  backdates the transcript beyond that. */
  sentAt: Timestamp.optional(),
  /** The sending device's signature over `userMessageSigningInput`, with the key it answers cards with (a phone's own
   *  key, a desktop app's answer key; a browser has none), base64. It travels with the message when another computer
   *  relays it (`peer.session.send`); the computer running the bot verifies it, and a relayed message without a good
   *  one, or signed with no `sentAt`, still arrives but its turn isn't the user's (review N3). */
  signature: utf16(256, 1).optional(),
});
export type UserMessageInput = z.infer<typeof UserMessageInput>;

/** How far a message's `sentAt` may sit from the receiving daemon's clock, either way (review N5). */
export const SENT_AT_WINDOW_MS = 2 * 60 * 1000;

/** A message's send time as the receiver orders it: the client's stamp, clamped to `receivedAt` plus or minus
 *  `SENT_AT_WINDOW_MS`; the receive time when there is none. A stamp outside the window is moved to its edge. */
export function clampSentAt(sentAt: number | undefined, receivedAt: number): number {
  if (sentAt === undefined || !Number.isFinite(sentAt)) return receivedAt;
  return Math.min(Math.max(sentAt, receivedAt - SENT_AT_WINDOW_MS), receivedAt + SENT_AT_WINDOW_MS);
}

/** What a user message's hash covers: its text and attachments, canonical (the hash is sha256 of this, hex). */
export function userMessageHashInput(m: Pick<UserMessageInput, "text" | "images" | "files">): string {
  return canonicalJson({ text: m.text, images: m.images ?? [], files: m.files ?? [] });
}

// Keeps its old spelling on purpose: clients that keep the old name speak this value on the wire.
/** What the sending device signs for a message another computer may relay (review N3): the session, the client's
 *  message id, the message's hash and its send time, one per line. */
export function userMessageSigningInput(a: { session: string; clientMessageId: string; hash: string; sentAt: number }): string {
  return `clover/user-message/1\n${a.session}\n${a.clientMessageId}\n${a.hash}\n${a.sentAt}`;
}

/** A routine, as the synced list keeps it (§8.5): any device can show it, even while its computer is off. */
export const RoutineView = z.object({
  id: utf16(128, 1),
  name: utf16(200),
  bot: BotId,
  computer: ComputerName,
  /** Its file in the tree: `home/<Computer>/.moss/routines/<bot>/<name>.md` (§7). */
  file: TreePath,
  triggers: z.array(z.object({ type: utf16(128), summary: utf16(500) })).max(32),
  level: utf16(32),
  /** A raised level waiting for its card, or a copy with the same id paused (§7). */
  state: z.enum(["active", "paused", "waiting-for-ok", "duplicate", "bot-removed"]),
  /** Why MOSS paused it, while it stays paused (a plugin's trigger started it too often, §7); the user's resume (the
   *  file's `paused` taken out) clears it. */
  pausedWhy: utf16(300).optional(),
  lastRunAt: Timestamp.optional(),
  nextRunAt: Timestamp.optional(),
});
export type RoutineView = z.infer<typeof RoutineView>;

export const RoutineRunView = z.object({
  routine: utf16(128),
  session: SessionId,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  outcome: z.enum(["running", "done", "failed", "skipped", "missed"]),
  summary: utf16(4000).optional(),
});

export type RoutineRunView = z.infer<typeof RoutineRunView>;

export const MemoryEntry = z.object({ path: utf16(1024), size: z.number().int().nonnegative(), modifiedAt: Timestamp });
export type MemoryEntry = z.infer<typeof MemoryEntry>;

const SessionParams = z.object({ id: SessionId });

/** One line of a session's diff: context, added or removed, with its numbers on each side. */
export const SessionDiffLine = z.object({
  kind: z.enum(["context", "add", "del"]),
  old: z.number().int().nonnegative().optional(),
  new: z.number().int().nonnegative().optional(),
  text: utf16(100_000),
});
export const SessionDiffHunk = z.object({ header: utf16(2_000), lines: z.array(SessionDiffLine) });
/** One file a coding session or an agent changed in its folder (`session.diff`). `tooLarge`: past the per-file or the
 *  total bound, listed with its counts but no lines. */
export const SessionDiffFile = z.object({
  path: utf16(4_096, 1),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  from: utf16(4_096).optional(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  hunks: z.array(SessionDiffHunk).optional(),
  tooLarge: z.boolean().optional(),
  binary: z.boolean().optional(),
});
export type SessionDiffFile = z.infer<typeof SessionDiffFile>;
export const SessionDiff = z.object({
  /** What it compares against: the folder's branch (or `HEAD`), or that it has no commits yet. Empty for no repo. */
  base: utf16(256),
  /** What it compares: the working tree. */
  target: utf16(256),
  /** Other targets the panel may offer: none yet. */
  targets: z.array(utf16(256)).max(16),
  files: z.array(SessionDiffFile).max(1_000),
  /** Why the list is empty or short (no folder, not a git repository, on another computer, what the bounds cut). */
  notice: utf16(1_000).optional(),
});
export type SessionDiff = z.infer<typeof SessionDiff>;

/** A model as a picker lists it (`models.list`). */
export const ModelListing = z.object({
  /** The qualified catalog id `session.setModel` takes. */
  id: utf16(200, 1),
  name: Text,
  /** The provider entry, its name as the plugin's manifest gives it (in the user's locale), and the plugin that
   *  contributes it. */
  provider: utf16(128, 1),
  providerName: Text,
  plugin: AnyPluginId,
  /** Its reasoning-effort levels, in order; empty when it has none. */
  efforts: z.array(utf16(32, 1)).max(16),
  defaultEffort: utf16(32, 1).optional(),
  /** Whether it takes images (so a picker can say an attachment won't go). */
  images: z.boolean(),
  /** Whether its provider is signed in; a model whose provider isn't can't run a turn yet. */
  signedIn: z.boolean(),
});
export type ModelListing = z.infer<typeof ModelListing>;

/** What a first working reply still needs (the setup guide, 2026-11-20): a model provider (a key or a sign-in), then a
 *  default model. Engine state, so every client asks the same question and gets the same answer. */
export const SetupMissing = z.enum(["provider", "model"]);
export type SetupMissing = z.infer<typeof SetupMissing>;

export const SetupState = z.object({
  /** Nothing is missing: a turn has a model and a provider to answer with. */
  ready: z.boolean(),
  missing: z.array(SetupMissing).max(2),
  /** The providers the person added (a stored key or sign-in), by catalog provider id. */
  providers: z.array(utf16(128, 1)).max(1_000),
  /** The default model now, if any: `chosen` when the settings name it (picked, or written by the engine for the one
   *  provider added), `computed` when it is the one provider's recommended model and not written yet. */
  default: z.object({ model: utf16(200, 1), source: z.enum(["chosen", "computed"]), effort: utf16(32, 1).optional() }).optional(),
  /** Each added provider's recommended default, its family's (a model and its effort), where it has one (the guide's
   *  pre-filled pick). */
  recommended: z.record(utf16(128, 1), z.object({ model: utf16(200, 1), effort: utf16(32, 1).optional() })).optional(),
  /** The person skipped the guide: it doesn't open by itself again (it stays reachable from Settings). */
  dismissed: z.boolean(),
});
export type SetupState = z.infer<typeof SetupState>;

export const SESSIONS_METHODS = {
  botList: defineMethod({
    name: "bot.list", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "bots.read",
    params: Empty, result: z.object({ bots: z.array(BotView) }),
    doc: "Every bot, with its state and settings.",
  }),
  botGet: defineMethod({
    name: "bot.get", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "bots.read",
    params: z.object({ id: BotId }), result: z.object({ bot: BotView }),
    doc: "One bot, with its state and settings.",
  }),
  botSetUserLayer: defineMethod({
    name: "bot.setUserLayer", owner: "D", roles: ["app", "cli", "layer"], userOnly: true, change: "core",
    params: z.object({ id: BotId, patch: UserLayerPatch }), result: ChangeResult,
    doc: "Sets or clears fields of a bot's user layer; a change to its instructions applies at its next turn.",
  }),
  botsPause: defineMethod({
    name: "bots.pause", owner: "D", roles: ["app", "cli", "remote"], userOnly: true,
    params: z.object({ paused: z.boolean() }), result: Ok,
    doc: "The core switch that pauses every bot and routine at once (§9.2).",
  }),
  sessionList: defineMethod({
    name: "session.list", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.*",
    params: z.object({ kinds: z.array(SessionKind).max(4).optional(), bot: BotId.optional() }),
    result: z.object({ sessions: z.array(SessionView) }),
    doc: "Every session: bots' conversations, side threads, background agents and coding sessions (`ListAgents`).",
  }),
  sessionGet: defineMethod({
    name: "session.get", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.*",
    params: SessionParams, result: z.object({ session: SessionView }),
    doc: "One session, with its state.",
  }),
  sessionAttach: defineMethod({
    name: "session.attach", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.*",
    params: z.object({ id: SessionId, since: z.number().int().nonnegative().optional() }),
    result: z.object({ lastSeq: z.number().int().nonnegative() }),
    doc: "Follows a session live: replays events after `since`, then streams them with the inherited `event` notification.",
  }),
  sessionDetach: defineMethod({
    name: "session.detach", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.*",
    params: SessionParams, result: Ok,
    doc: "Stops following a session.",
  }),
  sessionHistory: defineMethod({
    name: "session.history", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.*",
    params: z.object({ id: SessionId, before: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500) }),
    result: z.object({ events: z.array(z.record(z.string(), z.unknown())), hasMore: z.boolean() }),
    doc: "A page of a session's past events, newest last; sealed card fields never reach a plugin (§5.4).",
  }),
  sessionDiff: defineMethod({
    name: "session.diff", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.*",
    params: z.object({ id: SessionId, target: utf16(256).optional() }),
    result: SessionDiff,
    doc: "A coding session's or an agent's changes in its folder, read only: the working tree against HEAD (untracked files as added), per file with its hunks, bounded per file and in total. A folder that isn't a git repository, or isn't on this computer, answers no files and a notice. A plugin's own connection (a layer) also needs the capability files, since the diff carries file contents.",
  }),
  sessionOutputs: defineMethod({
    name: "session.outputs", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.*",
    params: z.object({ id: SessionId, limit: z.number().int().min(1).max(100).optional() }),
    result: z.object({ items: z.array(z.object({ id: utf16(255, 1), name: utf16(255, 1), kind: z.enum(["page", "file", "image"]) })).max(100), more: z.number().int().nonnegative() }),
    doc: "The files a session delivered to its outputs folder (`<home>/outputs/<session>`), newest first: names and kinds only, never their content.",
  }),
  sessionContext: defineMethod({
    name: "session.context", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.*",
    params: SessionParams,
    result: z.union([
      z.object({ used: z.number().min(0).max(1), tokens: z.number().int().nonnegative(), window: z.number().int().positive() }),
      z.object({ reported: z.literal(false) }),
    ]).nullable(),
    doc: "How full a session's context is: its last turn's measured prompt (`turn_completed.contextTokens`, for an agent the context it reported) against its model's context window; `{ reported: false }` for a coding session or an agent whose agent has reported none; null when neither is known.",
  }),
  sessionConnectors: defineMethod({
    name: "session.connectors", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.*",
    params: SessionParams,
    result: z.object({ total: z.number().int().nonnegative(), needSignIn: z.number().int().nonnegative() }),
    doc: "How many plugin MCP servers a session gets, and how many of them belong to a plugin with a sign-in that isn't signed in: counts only.",
  }),
  sessionSend: defineMethod({
    name: "session.send", owner: "D", roles: ["app", "cli", "remote", "web"], userOnly: true,
    params: z.object({ id: SessionId, message: UserMessageInput }),
    result: z.object({ seq: z.number().int().nonnegative() }),
    doc: "The user's message: it interrupts a bot's main conversation at once; it needs a live connection to the computer running the bot (`BOT_ASLEEP`).",
  }),
  sessionResend: defineMethod({
    name: "session.resend", owner: "D", roles: ["app"], userOnly: true,
    params: z.object({ session: SessionId }),
    result: z.object({ seq: z.number().int().nonnegative() }),
    doc: "Try again on a bot's main conversation whose latest turn ended in an error: the host sends the message that began that turn again, as a new message from this client, when that message was the user's own (a relay another computer's device did not sign, a task notification, a routine, a plugin, a bot or an agent is refused), nothing was sent or started since, and it carries no file and no picture it no longer holds (a picture is checked as the composer's send checks it; a message with files is refused: send it again from the composer). Once per failed turn. The caller names only the session: never the words, a message id or attachments. Not for a side thread, an agent or a coding session, nor for a conversation another computer runs. App role only: it is the app's \"Try again\" button; the terminal and a phone have none.",
  }),
  sessionPost: defineMethod({
    name: "session.post", owner: "D", roles: ["layer"], capability: "conversation.post",
    params: z.object({
      id: SessionId,
      kind: z.enum(["note", "message"]),
      text: utf16(100_000, 1),
      /** A note's label, shown with the plugin's name. */
      label: utf16(120).optional(),
    }),
    result: z.object({ seq: z.number().int().nonnegative() }),
    doc: "A plugin adds a note, or sends a bot a message that folds in; a turn it starts is the plugin's (§5.4).",
  }),
  sessionInterrupt: defineMethod({
    name: "session.interrupt", owner: "D", roles: ["app", "cli", "remote", "web"], userOnly: true,
    params: SessionParams, result: Ok,
    doc: "Stops the current step; background tasks keep running (§6.4).",
  }),
  sessionStop: defineMethod({
    name: "session.stop", owner: "D", roles: ["app", "cli", "remote"], userOnly: true,
    params: SessionParams, result: Ok,
    doc: "Stops a side thread, a background agent or a coding session (`TaskStop`).",
  }),
  sessionAnswer: defineMethod({
    name: "session.answer", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.post",
    params: z.object({
      id: SessionId, callId: utf16(128, 1),
      answers: z.record(z.string(), utf16(10_000)),
      notes: z.record(z.string(), utf16(10_000)).optional(),
    }),
    result: Ok,
    doc: "Answers an `AskUserQuestion`, which plugins may read and show in any form (§5.5).",
  }),
  sessionSetModel: defineMethod({
    name: "session.setModel", owner: "D", roles: ["app", "cli", "remote"], userOnly: true,
    params: z.object({ id: SessionId, model: utf16(200, 1), effort: utf16(32).optional() }),
    result: Ok,
    doc: "Switches an agent's or coding session's model mid-session; a bot's model is its user layer (§6.3).",
  }),
  sessionStageImage: defineMethod({
    name: "session.stageImage", owner: "D", roles: ["app", "cli", "remote"], userOnly: true,
    params: z.object({
      id: SessionId,
      mediaType: z.enum(STAGE_IMAGE_MEDIA_TYPES),
      /** Strict base64, at most `STAGE_IMAGE_B64_MAX_LENGTH` (the app's cap: one request line's worth). */
      dataBase64: z.string().min(1).max(STAGE_IMAGE_B64_MAX_LENGTH),
    }),
    result: z.object({ path: utf16(4096, 1) }),
    doc: "Stages an image for a session's next message, on the computer that holds it, with the app's caps (§6.6 \"attachments\"): the media types the bytes must sniff as, and the size. `session.send` names it by the path given back; a client off this computer (a phone, lane I) names only images staged so, never a file of its own.",
  }),
  modelsList: defineMethod({
    name: "models.list", owner: "A", roles: ["app", "cli", "remote"],
    params: z.object({ session: SessionId.optional() }),
    result: z.object({ models: z.array(ModelListing).max(10_000), default: utf16(200).optional() }),
    doc: "The models a session can switch to (`session.setModel`), read-only, for a model picker (lane I's phone among them): every model of a provider plugin that is on, signed in or not, less blocked rows and the rows of a blocked provider (a picker never offers what `session.setModel` refuses). With `session`, only the ones that session's runtime takes. `default` is the user's default model.",
  }),
  modelsSetDefault: defineMethod({
    name: "models.setDefault", owner: "A", roles: ["app", "cli"], userOnly: true,
    params: z.object({ model: utf16(200, 1) }),
    result: z.object({ setup: SetupState }),
    doc: "Sets the person's default model (what a bot or a session with no model of its own runs on): a model `models.list` offers whose provider the person added. Kept until they pick another or remove its provider (the setup guide, 2026-11-20).",
  }),
  setupState: defineMethod({
    name: "setup.state", owner: "A", roles: ["app", "cli"],
    params: z.object({}),
    result: SetupState,
    doc: "Whether this home is set up for a first working reply: the providers added, the default model and what is missing. The apps' setup guide opens by itself while it isn't, unless dismissed.",
  }),
  setupDismiss: defineMethod({
    name: "setup.dismiss", owner: "A", roles: ["app", "cli"], userOnly: true,
    params: z.object({ dismissed: z.boolean() }),
    result: SetupState,
    doc: "The person skipped the setup guide (`dismissed: true`: it no longer opens by itself, in either app), or asked for it back.",
  }),
  sessionCompact: defineMethod({
    name: "session.compact", owner: "D", roles: ["app", "cli"], userOnly: true,
    params: SessionParams, result: Ok,
    doc: "Compacts now: the conversation becomes a summary and the prompt's harness blocks are rebuilt (a cache miss). A conversation inside the compaction's retention window is refused as having nothing to compact; an instructions edit doesn't need it, since it reaches the next turn (§5.6).",
  }),
  memoryList: defineMethod({
    name: "memory.list", owner: "D", roles: ["app", "cli", "layer"], capability: "memory.read",
    params: z.object({ bot: BotId }), result: z.object({ entries: z.array(MemoryEntry) }),
    doc: "A bot's memory files: `MEMORY.md` and the files it links to (§6.5).",
  }),
  memoryRead: defineMethod({
    name: "memory.read", owner: "D", roles: ["app", "cli", "layer"], capability: "memory.read",
    params: z.object({ bot: BotId, path: utf16(1024, 1) }), result: z.object({ text: z.string() }),
    doc: "One memory file.",
  }),
  routineList: defineMethod({
    name: "routine.list", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "routines.read",
    params: z.object({ bot: BotId.optional() }), result: z.object({ routines: z.array(RoutineView) }),
    doc: "The synced list of routines (§8.5).",
  }),
  routineRuns: defineMethod({
    name: "routine.runs", owner: "D", roles: ["app", "cli", "remote", "layer"], capability: "routines.read",
    params: z.object({ id: utf16(128, 1), cursor: Cursor.optional(), limit: z.number().int().min(1).max(200).optional() }),
    result: z.object({ runs: z.array(RoutineRunView), next: Cursor.optional() }),
    doc: "A routine's runs, newest first.",
  }),
  routineRunNow: defineMethod({
    name: "routine.runNow", owner: "D", roles: ["app", "cli"], userOnly: true,
    params: z.object({ id: utf16(128, 1) }), result: z.object({ session: SessionId }),
    doc: "Runs a routine now, in a side thread on its computer.",
  }),
  routineGet: defineMethod({
    name: "routine.get", owner: "D", roles: ["app"], userOnly: true, windowOnly: true,
    params: z.object({ bot: BotId, id: utf16(128, 1) }),
    result: z.object({ routine: RoutineView, instructions: z.string() }),
    doc: "One routine of the bot on this computer with its instructions, read from its file as it is now, for the person's edit (`routine.edit`), so an edit never writes over text the person couldn't see. The person's window only.",
  }),
  routineEdit: defineMethod({
    name: "routine.edit", owner: "D", roles: ["app"], userOnly: true, windowOnly: true,
    params: z.object({
      /** The bot whose routine it is: a routine of another bot is not found through it. */
      bot: BotId,
      id: utf16(128, 1),
      patch: z.object({
        name: utf16(200, 1).optional(),
        /** Replaces its schedule trigger (`every <N><s|m|h|d>` or a 5-field cron); its other triggers stay. */
        schedule: utf16(200, 1).optional(),
        /** The instructions, the file's body. */
        instructions: utf16(60_000, 1).optional(),
        /** `paused: true` in its file, or taken out (resume). */
        paused: z.boolean().optional(),
      }).strict(),
    }),
    result: z.object({ routine: RoutineView }),
    doc: "The user changes a routine on this computer: the core rewrites that routine's own file (§7, the file stays the truth) under the Routine tool's rules: a schedule that doesn't read is refused, its id and webhook key stay where they are, a new name renames its file in the bot's own folder and can't take another routine's name, and a raised level waits for its OK again. The person's window only.",
  }),
  routineWebhookKey: defineMethod({
    name: "routine.webhookKey", owner: "D", roles: ["app", "cli"], userOnly: true,
    params: z.object({ id: utf16(128, 1), rotate: z.boolean().optional() }),
    result: z.object({ url: utf16(4096, 1), key: utf16(256, 1) }),
    doc: "A webhook routine's URL and key, for the user to paste into the service that calls it (§7). The key is shown once; after that only a new one (`rotate`), which replaces it, is shown. Never to a bot, a plugin or a remote client.",
  }),
  archiveList: defineMethod({
    name: "archive.list", owner: "D", roles: ["app", "cli"],
    params: z.object({
      query: utf16(1000).optional(),
      /** The last page's `cursor`, for the next page (opaque: it names the last session shown, by its `updatedAt` and
       *  its id, so sessions that share an `updatedAt` are never skipped or shown twice). */
      cursor: Cursor.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    result: z.object({ sessions: z.array(ArchivedSessionView).max(200), more: z.boolean(), cursor: Cursor.optional() }),
    doc: "The previous app's sessions, newest first, for the archive view (§14.1).",
  }),
  archiveHistory: defineMethod({
    name: "archive.history", owner: "D", roles: ["app", "cli"],
    params: z.object({ id: utf16(128, 1), cursor: Cursor.optional(), limit: z.number().int().min(1).max(500).optional() }),
    result: z.object({
      /** The previous app's `SessionEvent`s as it stored them, oldest first: read with the inherited schema,
       *  skipping what a client doesn't know. */
      events: z.array(z.unknown()).max(500),
      cursor: Cursor.optional(),
    }),
    doc: "A previous-app session's transcript, read-only; it never becomes a bot's history.",
  }),
} as const;

// -------------------------------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------------------------------

export const BotChangedEvent = coreEvent("bot_changed", { bot: BotView });
export const BotRemovedEvent = coreEvent("bot_removed", { id: BotId });
export const BotsPausedEvent = coreEvent("bots_paused", { paused: z.boolean() });
export const SessionChangedEvent = coreEvent("session_changed", { session: SessionView });
export const RoutinesChangedEvent = coreEvent("routines_changed", { bot: BotId.optional() });

/** The envelope of MOSS's session events: the inherited one (`seq`, `sessionId`, `ts`, `late`), plus the lease epoch
 *  every log event carries once lane H's lease exists (§6.4 "Events carry their lease epoch"). `late`: the event
 *  reached this log after events that happened later (an earlier lease's, or another computer's set aside after a
 *  fork, §8.5); a client shows it apart, as history. */
function sessionEvent<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({
    type: z.literal(type), seq: z.number().int().nonnegative(), sessionId: SessionId, ts: Timestamp,
    epoch: z.number().int().nonnegative().optional(), late: z.literal(true).optional(), ...shape,
  });
}

/** Another bot's `SendMessage`, folded into this conversation (§6.4). */
export const BotMessageEvent = sessionEvent("bot_message", { from: BotId, fromSession: SessionId, text: utf16(1_000_000) });
/** A background agent's `SendMessage` to its bot while it works (§9.3). Shown as `agent-report` (§5.5). */
export const AgentMessageEvent = sessionEvent("agent_message", { agent: SessionId, text: utf16(1_000_000) });
/** A background agent finished: the task notification, with the final text unchanged (spike S5 §8). */
export const AgentFinishedEvent = sessionEvent("agent_finished", {
  agent: SessionId,
  backend: utf16(128),
  stopReason: z.enum(["end_turn", "refusal", "cancelled", "stopped", "stalled", "sign-in", "crashed", "error"]),
  text: utf16(1_000_000),
  /** Its full transcript in the tree (`bots/<bot>/agents/…`). */
  transcript: TreePath,
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).optional(),
});
/** A routine run's short result, posted into the bot's main conversation (§7). */
export const RoutineResultEvent = sessionEvent("routine_result", {
  routine: utf16(128), name: utf16(200), sideThread: SessionId, text: utf16(100_000),
  /** The run didn't finish well: an error, a timeout, a refusal, or it was stopped or cut off (lane G's notifier shows
   *  only these when the user asks for routine failures). */
  failed: z.boolean(),
});
/** A labelled note: a plugin's (`conversation.post`), a `turn.start` hook's, or the core's (servers added between
 *  compactions, §6.1). */
export const NoteEvent = sessionEvent("note", {
  from: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("plugin"), pluginId: AnyPluginId }),
    z.object({ kind: z.literal("hook"), pluginId: AnyPluginId, hook: utf16(128) }),
    z.object({ kind: z.literal("core") }),
  ]),
  label: utf16(120),
  text: utf16(100_000),
});
/** A message a plugin sends a bot: its `conversation.send` (with `conversation.post`), or an MCP Apps page's
 *  `ui/message`, which is never the user's, whatever key press or click came with it (§5.5). The turn it starts is the
 *  plugin's; shown with the plugin's name (`from.kind: "plugin"`). */
export const PluginMessageEvent = sessionEvent("plugin_message", {
  from: z.object({ kind: z.literal("plugin"), pluginId: AnyPluginId }),
  text: utf16(1_000_000),
  /** An MCP Apps page's message: the tool call whose page sent it. */
  app: z.object({ callId: utf16(128, 1) }).optional(),
});
/** The fields the user's `user_message` gains (§6.4): the device it came from and its send time on the shared
 *  clock. A message stamped before output the model already produced sits after that output, showing its time. */
export const UserMessageStamp = z.object({ device: DeviceId, sentAt: Timestamp });

export const SetupChangedEvent = coreEvent("setup_changed", { setup: SetupState });

export const MossSessionEvent = z.discriminatedUnion("type", [
  BotMessageEvent, AgentMessageEvent, AgentFinishedEvent, RoutineResultEvent, NoteEvent, PluginMessageEvent,
]);
export type MossSessionEvent = z.infer<typeof MossSessionEvent>;

const READERS = ["app", "cli", "remote", "web", "layer"] as const;

export const SESSIONS_EVENTS = {
  setupChanged: defineEvent({
    type: "setup_changed", owner: "A", roles: ["app", "cli"], schema: SetupChangedEvent,
    fixture: { type: "setup_changed", ts: 1781270000000, setup: { ready: true, missing: [], providers: ["anthropic"], default: { model: "anthropic/claude-opus-5-5", source: "chosen", effort: "medium" }, dismissed: false } },
    doc: "What the home's setup needs changed: a provider was added or removed, or the default model or the guide's dismissal changed.",
  }),
  botChanged: defineEvent({
    type: "bot_changed", owner: "D", roles: READERS, capability: "bots.read", schema: BotChangedEvent,
    fixture: {
      type: "bot_changed", ts: 1781270000000,
      bot: { id: "alpha", name: "Alpha", model: "fireworks/kimi-k3", effort: "medium", userLayer: ["model"], state: "idle", computer: "Studio", mainSession: "s_alpha" },
    },
    doc: "A bot's settings or state changed.",
  }),
  botRemoved: defineEvent({
    type: "bot_removed", owner: "D", roles: READERS, capability: "bots.read", schema: BotRemovedEvent,
    fixture: { type: "bot_removed", ts: 1781270000000, id: "pack/luna" },
    doc: "A bot's plugin was removed; its memory and transcript stay under its id (§6.1).",
  }),
  botsPaused: defineEvent({
    type: "bots_paused", owner: "D", roles: READERS, capability: "bots.read", schema: BotsPausedEvent,
    fixture: { type: "bots_paused", ts: 1781270000000, paused: true },
    doc: "The pause switch moved.",
  }),
  sessionChanged: defineEvent({
    type: "session_changed", owner: "D", roles: READERS, capability: "conversation.*", schema: SessionChangedEvent,
    fixture: {
      type: "session_changed", ts: 1781270000000,
      session: { id: "s_agent_1", kind: "agent", bot: "alpha", parent: "s_alpha", computer: "Desktop1", status: "prompting", startedAt: 1781269990000, updatedAt: 1781270000000, backend: "claude-code", root: "home/Desktop1/project1" },
    },
    doc: "A session started, changed state or ended.",
  }),
  routinesChanged: defineEvent({
    type: "routines_changed", owner: "D", roles: READERS, capability: "routines.read", schema: RoutinesChangedEvent,
    fixture: { type: "routines_changed", ts: 1781270000000, bot: "alpha" },
    doc: "The routine list changed; clients re-read `routine.list`.",
  }),
  botMessage: defineEvent({
    type: "bot_message", owner: "D", roles: READERS, capability: "conversation.read", scope: "session", schema: BotMessageEvent,
    fixture: { type: "bot_message", seq: 12, sessionId: "s_alpha", ts: 1781270000000, epoch: 3, from: "pack/luna", fromSession: "s_luna", text: "The deploy finished." },
    doc: "Another bot's message, folded in.",
  }),
  agentMessage: defineEvent({
    type: "agent_message", owner: "K", roles: READERS, capability: "conversation.read", scope: "session", schema: AgentMessageEvent,
    fixture: { type: "agent_message", seq: 13, sessionId: "s_alpha", ts: 1781270001000, agent: "s_agent_1", text: "Tests pass; opening the PR next." },
    doc: "A background agent's message to its bot.",
  }),
  agentFinished: defineEvent({
    type: "agent_finished", owner: "K", roles: READERS, capability: "conversation.read", scope: "session", schema: AgentFinishedEvent,
    fixture: {
      type: "agent_finished", seq: 14, sessionId: "s_alpha", ts: 1781270002000, agent: "s_agent_1", backend: "claude-code",
      stopReason: "end_turn", text: "Fixed the login bug; PR #12.", transcript: "bots/alpha/agents/s_agent_1/acp.ndjson",
      usage: { inputTokens: 43467, outputTokens: 318 },
    },
    doc: "A background agent's task notification.",
  }),
  routineResult: defineEvent({
    type: "routine_result", owner: "D", roles: READERS, capability: "conversation.read", scope: "session", schema: RoutineResultEvent,
    fixture: { type: "routine_result", seq: 15, sessionId: "s_alpha", ts: 1781270003000, routine: "r_morning", name: "Morning brief", sideThread: "s_side_9", text: "3 new issues, no failed deploys.", failed: false },
    doc: "A routine run's result in the main conversation.",
  }),
  note: defineEvent({
    type: "note", owner: "D", roles: READERS, capability: "conversation.read", scope: "session", schema: NoteEvent,
    fixture: { type: "note", seq: 16, sessionId: "s_alpha", ts: 1781270004000, from: { kind: "plugin", pluginId: "weather" }, label: "Forecast", text: "Rain after 4 pm." },
    doc: "A labelled note in the conversation.",
  }),
  pluginMessage: defineEvent({
    type: "plugin_message", owner: "D", roles: READERS, capability: "conversation.read", scope: "session", schema: PluginMessageEvent,
    fixture: { type: "plugin_message", seq: 17, sessionId: "s_alpha", ts: 1781270005000, from: { kind: "plugin", pluginId: "blender" }, text: "Render the next frame.", app: { callId: "call_7" } },
    doc: "A plugin's message to the bot; the turn it starts is the plugin's.",
  }),
} as const;
