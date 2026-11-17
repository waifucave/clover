// MOSS protocol area: what the engine gives every place (spec revision 19, §3.6; G4, G5, G6; items 105 and 115). Owner:
// lane AF (the activity feed, a tool's live picture and reads by kind). Shapes pinned by lane SP; nothing here is served
// yet.
//
// * Reading is scoped by KIND of data, never by app: code sessions (`sessions`) or bots (`bots`). A capability per kind
//   (the plugin SDK's catalog): `sessions.read` and `conversation.read` for what was said, `activity.read.sessions` and
//   `activity.read.bots` for the feed, `picture.read.sessions` and `picture.read.bots` for live pictures. A method that
//   takes a `kind` names its capability with `.*` (`activity.read.*`): the kind decides which one (`kindCapability`).
// * The activity feed: one state per code session and per bot, from `ACTIVITY_STATES`. It carries states and names only:
//   never message text, tool arguments or card text (`ActivityView` has no field that could hold them).
// * A tool's live picture: a tool plugin whose MCP server declares `picture: true` in its manifest may publish one for the
//   session of the tool call it serves (its OK card says it "shows a live picture of what it is doing"). The engine keys
//   it to that tool call's session, never to an id the publisher names; it is inert pixels (`PICTURE_FORMATS`), shown with
//   the publisher's plugin id, never markup. A window opens one (`picture.open`) and gets its frames as `picture.frame`
//   notifications on its own connection; a plugin reads one through the plugin API's `pictures` (a byte stream).
import { z } from "zod";
import { utf16 } from "./strings";
import { AnyPluginId, BotId, Ok, SessionId, Timestamp } from "./common";
import { coreEvent, defineEvent, defineMethod } from "./rpc";

// -------------------------------------------------------------------------------------------------
// Kinds of data
// -------------------------------------------------------------------------------------------------

/** The kinds a read is scoped by (§3.6): the user's code sessions, or bots (their conversations and what they do). */
export const DATA_KINDS = ["sessions", "bots"] as const;
export const DataKind = z.enum(DATA_KINDS);
export type DataKind = z.infer<typeof DataKind>;

/** The capability that reads `kind` from a family written `<family>.*` (`activity.read.*` → `activity.read.bots`). What was
 *  said is the odd pair: `conversation.*` is `sessions.read` for code sessions and `conversation.read` for bots'
 *  conversations. The one mapping every gate uses (`pluginMayCall`, the SDK's `apiCallAllowed`, the contracts'
 *  `readerMay`), so a family a lane adds is read the same everywhere. */
export function kindCapability(family: string, kind: DataKind): string {
  if (family === "conversation.*") return kind === "sessions" ? "sessions.read" : "conversation.read";
  return `${family.slice(0, -1)}${kind}`;
}

/** Whether a capability names a family by kind (`<family>.*`), not `call:*` or `network:*`. */
export function isKindFamily(capability: string): boolean {
  return capability.endsWith(".*") && capability !== "call:*" && capability !== "network:*";
}

/** The spec revision from which `conversation.read` means bots' conversations only (§5.4): a grant OK'd before it gives
 *  no read of bots' conversations until the plugin asks again (`grantReadsBots`). */
export const CONVERSATION_READ_NARROWED_AT = 19;

/** Whether a plugin's `conversation.read`, OK'd at spec revision `okRevision` (undefined: before revisions were kept),
 *  reads bots' conversations now. What such an older grant still reads of code sessions is open (the lane map's
 *  undefined points). */
export function grantReadsBots(okRevision: number | undefined): boolean {
  return okRevision !== undefined && okRevision >= CONVERSATION_READ_NARROWED_AT;
}

// -------------------------------------------------------------------------------------------------
// The activity feed
// -------------------------------------------------------------------------------------------------

/** The feed's states (G4; the living bots' moods, §6.9). */
export const ACTIVITY_STATES = ["idle", "listening", "thinking", "working", "asking", "stuck", "done", "asleep"] as const;
export const ActivityState = z.enum(ACTIVITY_STATES);
export type ActivityState = z.infer<typeof ActivityState>;

/** What the feed is about: a code session, or a bot (its main conversation, side threads and agents as one). */
export const ActivitySubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sessions"), id: SessionId }),
  z.object({ kind: z.literal("bots"), id: BotId }),
]);
export type ActivitySubject = z.infer<typeof ActivitySubject>;

/** One subject's place in the feed: its state and names only. `name` is the session's title or the bot's name; `tool` the
 *  wire name of the tool it is working with (`working`), never its arguments. Strict: nothing else can ride along. */
export const ActivityView = z.strictObject({
  subject: ActivitySubject,
  state: ActivityState,
  name: utf16(200).optional(),
  tool: utf16(128).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  since: Timestamp,
});
export type ActivityView = z.infer<typeof ActivityView>;

export const ActivityChangedEvent = coreEvent("activity_changed", { activity: ActivityView });

// -------------------------------------------------------------------------------------------------
// A tool's live picture
// -------------------------------------------------------------------------------------------------

/** The pixels a picture's frames carry: whole images, never markup. */
export const PICTURE_FORMATS = ["jpeg", "png", "webp"] as const;
export const PictureFormat = z.enum(PICTURE_FORMATS);
export type PictureFormat = z.infer<typeof PictureFormat>;
/** Caps on what a publisher sends: one frame's bytes, its size and the rate the engine passes on. */
export const PICTURE_FRAME_MAX_BYTES = 2 * 1024 * 1024;
export const PICTURE_MAX_WIDTH = 3840;
export const PICTURE_MAX_HEIGHT = 2400;
export const PICTURE_MAX_FPS = 30;

/** A picture's id: the engine's, never the publisher's. */
export const PictureId = utf16(64, 1).regex(/^pic_[A-Za-z0-9_-]{6,58}$/);

export const PictureView = z.object({
  id: PictureId,
  /** The kind of the session it belongs to: a code session's, or a bot's (any of its sessions). */
  kind: DataKind,
  /** The tool call's session, which the engine took from the call the publisher served. */
  session: SessionId,
  bot: BotId.optional(),
  /** The publisher, shown beside the picture. */
  publisher: AnyPluginId,
  /** The tool's wire name (`mcp__<namespace>__<Tool>`). */
  tool: utf16(128).optional(),
  format: PictureFormat,
  width: z.number().int().positive().max(PICTURE_MAX_WIDTH),
  height: z.number().int().positive().max(PICTURE_MAX_HEIGHT),
  /** It can show the user's own screen (a computer-use tool's), with the product's own windows blacked out. */
  screen: z.boolean(),
  startedAt: Timestamp,
});
export type PictureView = z.infer<typeof PictureView>;

/** What a publisher declares when it opens its picture (the stream's `meta`); the session is never in it. */
export const PicturePublishMeta = z.strictObject({
  format: PictureFormat,
  width: z.number().int().positive().max(PICTURE_MAX_WIDTH),
  height: z.number().int().positive().max(PICTURE_MAX_HEIGHT),
  screen: z.boolean().optional(),
});
export type PicturePublishMeta = z.infer<typeof PicturePublishMeta>;

/** A publisher's byte stream is a run of frames, each a 4-byte big-endian length and that many bytes of one image in the
 *  declared format; a frame over `PICTURE_FRAME_MAX_BYTES` ends the picture. */
export const PICTURE_FRAME_LENGTH_BYTES = 4;

/** The notification that carries a picture's frames to the window that opened it (`picture.open`, `browser.view.open`):
 *  per connection, never an area's event. Latest wins: a slow reader skips frames, never queues them. */
export const PICTURE_FRAME_NOTIFICATION = "picture.frame";
export const PictureFrame = z.object({
  stream: utf16(64, 1),
  seq: z.number().int().nonnegative(),
  format: PictureFormat,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** The image, base64. */
  data: z.string().max(Math.ceil(PICTURE_FRAME_MAX_BYTES / 3) * 4),
  at: Timestamp,
});
export type PictureFrame = z.infer<typeof PictureFrame>;

export const PictureChangedEvent = coreEvent("picture_changed", { picture: PictureView });
export const PictureEndedEvent = coreEvent("picture_ended", {
  id: PictureId,
  kind: DataKind,
  session: SessionId,
  why: z.enum(["publisher", "session", "plugin-stopped", "too-large"]),
});

export const ACTIVITY_METHODS = {
  activityList: defineMethod({
    name: "activity.list", owner: "AF", roles: ["app", "cli", "layer", "remote"], capability: "activity.read.*",
    params: z.object({ kind: DataKind }),
    result: z.object({ activity: z.array(ActivityView).max(4096) }),
    doc: "The activity feed of one kind (code sessions or bots): states and names only, never words.",
  }),
  pictureList: defineMethod({
    name: "picture.list", owner: "AF", roles: ["app", "layer"], capability: "picture.read.*",
    params: z.object({ kind: DataKind, session: SessionId.optional(), bot: BotId.optional() }),
    result: z.object({ pictures: z.array(PictureView).max(256) }),
    doc: "The live pictures tools are publishing now, of one kind, for one session or bot or all.",
  }),
  pictureOpen: defineMethod({
    /** A window's (role `app`): its frames come as `picture.frame` on this connection. A plugin reads a picture through
     *  the plugin API's `pictures.open` instead. */
    name: "picture.open", owner: "AF", roles: ["app"],
    params: z.object({ id: PictureId, maxFps: z.number().int().min(1).max(PICTURE_MAX_FPS).optional() }),
    result: z.object({ stream: utf16(64, 1) }),
    doc: "Follows one live picture: its frames come to this connection, latest wins, until it ends or is closed.",
  }),
  pictureClose: defineMethod({
    name: "picture.close", owner: "AF", roles: ["app"],
    params: z.object({ stream: utf16(64, 1) }),
    result: Ok,
    doc: "Stops following a live picture.",
  }),
} as const;

export const ACTIVITY_EVENTS = {
  activityChanged: defineEvent({
    type: "activity_changed", owner: "AF", roles: ["app", "cli", "layer", "remote"], schema: ActivityChangedEvent, capability: "activity.read.*", transient: true,
    fixture: { type: "activity_changed", ts: 1781270000000, activity: { subject: { kind: "bots", id: "alpha" }, state: "working", name: "Alpha", tool: "Bash", since: 1781270000000 } },
    doc: "A code session's or a bot's new state; a plugin hears only the kinds it reads.",
  }),
  pictureChanged: defineEvent({
    type: "picture_changed", owner: "AF", roles: ["app", "layer"], schema: PictureChangedEvent, capability: "picture.read.*", transient: true,
    fixture: { type: "picture_changed", ts: 1781270000000, picture: { id: "pic_abcdef", kind: "bots", session: "s_alpha", bot: "alpha", publisher: "moss/browser", tool: "mcp__moss__Browser", format: "jpeg", width: 1280, height: 800, screen: false, startedAt: 1781270000000 } },
    doc: "A live picture started or changed size or format.",
  }),
  pictureEnded: defineEvent({
    type: "picture_ended", owner: "AF", roles: ["app", "layer"], schema: PictureEndedEvent, capability: "picture.read.*", transient: true,
    fixture: { type: "picture_ended", ts: 1781270000000, id: "pic_abcdef", kind: "bots", session: "s_alpha", why: "publisher" },
    doc: "A live picture ended: its publisher closed it, its session ended, its plugin stopped, or a frame was too large.",
  }),
} as const;
