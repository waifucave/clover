// Clover protocol area: sessions and bots (spec §6, §7, §9.3). Owner: lane D (bots, sessions, memory, routines),
// with lane A for the runtime underneath (plan §4). Pinned by lane B at M0.
//
// A session is any running conversation: a bot's main conversation, a side thread (a routine run), a background
// agent, or a coding session the user started (§9.3). The user's message interrupts a bot's main conversation at
// once (§6.4); messages from other bots, routines, agents and plugins fold into the running turn after its next
// tool call. A session's log keeps the inherited `SessionEvent` stream (events.ts); the Clover kinds below join it when
// lane D wires them through the inherited checklist (docs/claude/protocol-and-remote.md).
import { z } from "zod";
import { utf16 } from "./strings";
import {
  AnyPluginId, BotId, ChangeResult, ComputerName, Cursor, DeviceId, Empty, Ok, SessionId, SessionKind, Text,
  Timestamp, TreePath,
} from "./common";
import { canonicalJson } from "./approvals";
import { coreEvent, defineEvent, defineMethod } from "./rpc";

// -------------------------------------------------------------------------------------------------
// Bots
// -------------------------------------------------------------------------------------------------

/** A bot's state as clients show it. `asleep`: no computer that can run it is connected (§6.4, §14.2 item 18). */
export const BotState = z.enum(["idle", "thinking", "asleep", "paused"]);

export const BotView = z.object({
  /** The bot's id is its plugin's id (§6.1). */
  id: BotId,
  name: Text,
  /** Asset URL of its portrait, when it has one. */
  portrait: utf16(4096).optional(),
  /** A qualified catalog id; the user's default model when there is no key for the bot's own (§6.1). */
  model: utf16(200),
  effort: utf16(32).optional(),
  voice: z.object({ provider: utf16(128), voice: utf16(256), model: utf16(128).optional() }).optional(),
  theme: utf16(256).optional(),
  /** The fields the user layer sets over the plugin's (§6.1). */
  userLayer: z.array(z.enum(["name", "instructions", "model", "effort", "voice", "avatar", "theme", "layout"])),
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
  voice: z.object({ provider: utf16(128), voice: utf16(256), model: utf16(128).optional() }).nullable().optional(),
  avatar: z.object({ file: utf16(4096), format: utf16(32), portrait: utf16(4096).optional() }).nullable().optional(),
  theme: utf16(256).nullable().optional(),
  layout: utf16(4096).nullable().optional(),
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

/** A session from the app Clover replaces, in the archive view (§14.1 "Existing … installs", review S16): readable,
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
  /** What waits for the user in it: pending cards and unanswered questions, as counts only (the shell's needs-you
   *  marks; a card's content stays behind `approvals` and the sealed frames). */
  needsYou: z.object({ cards: z.number().int().nonnegative(), questions: z.number().int().nonnegative() }).optional(),
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
  /** Its file in the tree: `home/<Computer>/.clover/routines/<bot>/<name>.md` (§7). */
  file: TreePath,
  triggers: z.array(z.object({ type: utf16(128), summary: utf16(500) })).max(32),
  level: utf16(32),
  /** A raised level waiting for its card, or a copy with the same id paused (§7). */
  state: z.enum(["active", "paused", "waiting-for-ok", "duplicate", "bot-removed"]),
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
    doc: "Sets or clears fields of a bot's user layer; a change to its instructions applies at the next compaction.",
  }),
  botsPause: defineMethod({
    name: "bots.pause", owner: "D", roles: ["app", "cli", "remote"], userOnly: true,
    params: z.object({ paused: z.boolean() }), result: Ok,
    doc: "The core switch that pauses every bot and routine at once (§9.2).",
  }),
  sessionList: defineMethod({
    name: "session.list", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.read",
    params: z.object({ kinds: z.array(SessionKind).max(4).optional(), bot: BotId.optional() }),
    result: z.object({ sessions: z.array(SessionView) }),
    doc: "Every session: bots' conversations, side threads, background agents and coding sessions (`ListAgents`).",
  }),
  sessionGet: defineMethod({
    name: "session.get", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.read",
    params: SessionParams, result: z.object({ session: SessionView }),
    doc: "One session, with its state.",
  }),
  sessionAttach: defineMethod({
    name: "session.attach", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.read",
    params: z.object({ id: SessionId, since: z.number().int().nonnegative().optional() }),
    result: z.object({ lastSeq: z.number().int().nonnegative() }),
    doc: "Follows a session live: replays events after `since`, then streams them with the inherited `event` notification.",
  }),
  sessionDetach: defineMethod({
    name: "session.detach", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.read",
    params: SessionParams, result: Ok,
    doc: "Stops following a session.",
  }),
  sessionHistory: defineMethod({
    name: "session.history", owner: "D", roles: ["app", "cli", "remote", "web", "layer"], capability: "conversation.read",
    params: z.object({ id: SessionId, before: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500) }),
    result: z.object({ events: z.array(z.record(z.string(), z.unknown())), hasMore: z.boolean() }),
    doc: "A page of a session's past events, newest last; sealed card fields never reach a plugin (§5.4).",
  }),
  sessionSend: defineMethod({
    name: "session.send", owner: "D", roles: ["app", "cli", "remote", "web"], userOnly: true,
    params: z.object({ id: SessionId, message: UserMessageInput }),
    result: z.object({ seq: z.number().int().nonnegative() }),
    doc: "The user's message: it interrupts a bot's main conversation at once; it needs a live connection to the computer running the bot (`BOT_ASLEEP`).",
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
  sessionCompact: defineMethod({
    name: "session.compact", owner: "D", roles: ["app", "cli"], userOnly: true,
    params: SessionParams, result: Ok,
    doc: "Compacts now, so new instructions apply at once at the cost of a cache miss (§5.6).",
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
  archiveList: defineMethod({
    name: "archive.list", owner: "D", roles: ["app", "cli"],
    params: z.object({
      query: utf16(1000).optional(),
      /** Sessions updated before this time, for the next page. */
      before: Timestamp.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    result: z.object({ sessions: z.array(ArchivedSessionView).max(200), more: z.boolean() }),
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

/** The envelope of Clover's session events: the inherited one (`seq`, `sessionId`, `ts`), plus the lease epoch every
 *  log event carries once lane H's lease exists (§6.4 "Events carry their lease epoch"). */
function sessionEvent<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({
    type: z.literal(type), seq: z.number().int().nonnegative(), sessionId: SessionId, ts: Timestamp,
    epoch: z.number().int().nonnegative().optional(), ...shape,
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

export const CloverSessionEvent = z.discriminatedUnion("type", [
  BotMessageEvent, AgentMessageEvent, AgentFinishedEvent, RoutineResultEvent, NoteEvent, PluginMessageEvent,
]);
export type CloverSessionEvent = z.infer<typeof CloverSessionEvent>;

const READERS = ["app", "cli", "remote", "web", "layer"] as const;

export const SESSIONS_EVENTS = {
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
    type: "session_changed", owner: "D", roles: READERS, capability: "conversation.read", schema: SessionChangedEvent,
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
    fixture: { type: "routine_result", seq: 15, sessionId: "s_alpha", ts: 1781270003000, routine: "r_morning", name: "Morning brief", sideThread: "s_side_9", text: "3 new issues, no failed deploys." },
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
