// `session.resend`: the conversation part's "Try again" on a turn that ended in an error. The page names only the session;
// main reads the session's own log, finds the message the USER typed that began the failed turn, and sends those same
// words again as the user's own message (`pill.send`, the door the composer's send goes through). Nothing the page says
// but the session's id is read: not the words, not pictures, not a message.
//
// What it sends, and when:
//   * only a conversation the conversation part shows: a bot's main conversation (the bot's own `mainSession`) or a side
//     thread, on THIS computer (a session on another computer is sent again from the composer, which relays it);
//   * only when the log's latest event is a `turn_completed` that ended in an error, with nothing since (no message, no
//     new turn, no running one);
//   * only when that turn began from one `user_message` (the event type the host projects ONLY for the user's own input:
//     a task notification, a routine, a plugin, another bot or an agent each project as a different type, and a driver
//     can't emit `user_message`, `HOST_EVENT_TYPES`) and no other input went into the turn;
//   * only a message the log holds in full: the `user_message` event carries `text`, `images`, `files` (and `device`,
//     `sentAt`, which are not sent again). `text` is the stored text as typed, untouched by the projection. A message with
//     `images` or `files` (an `[Image #n]` or `[File #n]` mark names a staged file this door can't re-attach) is refused:
//     "send it again from the composer";
//   * the log is read again right before the send and must still end in that same failed turn (the same `turn_completed`
//     `seq`), one send at a time per session, and the message's id is derived from that turn, so the core's own
//     `clientMessageId` dedup answers a second send for the same failed turn with the first one's seq.
// The call itself is a `gesture` entry: one key press or click the main process saw, spent per call.
import { displayText } from "@waifucave/clover-plugin-sdk/plain";
import type { TreeRoute } from "./tree-calls";

/** One event of a session's log as `session.history` returns it: only the fields read here. */
export interface LogEvent {
  type?: unknown;
  seq?: unknown;
  text?: unknown;
  stopReason?: unknown;
  images?: unknown;
  files?: unknown;
  late?: unknown;
}

/** The event types that are an input to a session, however the host projects it (wire.ts `projectRecord`). */
const INPUT_TYPES: ReadonlySet<string> = new Set(["user_message", "bot_message", "agent_message", "agent_finished", "routine_result", "plugin_message", "note"]);
/** What may sit in the log after a failed turn without being something new. */
const QUIET_AFTER: ReadonlySet<string> = new Set(["agent_error", "session_titled"]);

/** Said to the page whenever the words can't be sent again from here. */
export const RESEND_FROM_COMPOSER = "send it again from the composer";

export type FailedTurn =
  /** `turn`: the failed `turn_completed`'s `seq`; `text`: the user's message, as stored. */
  | { ok: true; turn: number; text: string }
  /** `more`: the log read ran out before the turn's start; an earlier page may settle it. */
  | { ok: false; why: string; more?: true };

const no = (why: string, more?: true): FailedTurn => ({ ok: false, why, ...(more ? { more } : {}) });

/** The failed turn at the end of a log (events oldest first) and the user's message that began it. */
export function failedTurn(events: readonly LogEvent[]): FailedTurn {
  const type = (i: number) => (typeof events[i]?.type === "string" ? (events[i]!.type as string) : "");
  let f = -1;
  for (let i = events.length - 1; i >= 0; i--) if (type(i) === "turn_completed") { f = i; break; }
  if (f < 0) return no("no turn has ended here");
  for (let i = f + 1; i < events.length; i++) if (type(i) === "turn_started") return no("a turn is running");
  for (let i = f + 1; i < events.length; i++) if (!QUIET_AFTER.has(type(i))) return no("something has happened since");
  const end = events[f]!;
  if (end.stopReason !== "error") return no("the last turn did not fail");
  if (typeof end.seq !== "number" || !Number.isSafeInteger(end.seq) || end.late === true) return no("the log doesn't say which turn failed");
  let s = -1;
  for (let i = f - 1; i >= 0; i--) if (type(i) === "turn_started" || type(i) === "turn_completed") { s = i; break; }
  if (s < 0) return no("the start of that turn is not in what was read", true);
  if (type(s) !== "turn_started") return no("that turn has no start");
  for (let i = s + 1; i < f; i++) if (INPUT_TYPES.has(type(i))) return no(`more than one message went into that turn; ${RESEND_FROM_COMPOSER}`);
  let o = -1;
  for (let i = s - 1; i >= 0; i--) {
    if (type(i) === "turn_started" || type(i) === "turn_completed") return no(`that turn began from a message that was waiting; ${RESEND_FROM_COMPOSER}`);
    if (INPUT_TYPES.has(type(i))) { o = i; break; }
  }
  if (o < 0) return no("the message that began that turn is not in what was read", true);
  const opener = events[o]!;
  if (type(o) !== "user_message") return no("that turn was not begun by something you typed");
  if (opener.late === true) return no(`that message arrived out of order; ${RESEND_FROM_COMPOSER}`);
  if (opener.images !== undefined || opener.files !== undefined) return no(`that message had pictures or files; ${RESEND_FROM_COMPOSER}`);
  if (typeof opener.text !== "string" || opener.text.trim() === "") return no("that message has no words");
  return { ok: true, turn: end.seq, text: opener.text };
}

/** The most events one read of the log holds, and how many reads one check may make. */
const PAGE = 500;
const PAGES = 3;

/** The failed turn at the end of `session`'s log, reading back page by page until the message that began it is in hand. */
async function readFailedTurn(r: TreeRoute, session: string): Promise<FailedTurn> {
  let events: LogEvent[] = [];
  let before: number | undefined;
  for (let page = 0; page < PAGES; page++) {
    const got = (await r.request("session.history", { id: session, limit: PAGE, ...(before === undefined ? {} : { before }) })) as { events?: LogEvent[]; hasMore?: unknown } | undefined;
    const batch = Array.isArray(got?.events) ? got!.events! : [];
    events = [...batch, ...events];
    const verdict = failedTurn(events);
    // Settled, or nothing earlier to read.
    if (verdict.ok || verdict.more !== true || got?.hasMore !== true) return verdict;
    const first = batch[0]?.seq;
    if (typeof first !== "number") break;
    before = first;
  }
  return no(`that turn is too long to read here; ${RESEND_FROM_COMPOSER}`);
}

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** The most a refusal's reason shows a page. */
const REASON_MAX = 300;
/** Sessions with a resend under way: a second call for the same session is refused until the first is over. */
const inFlight = new Set<string>();

/** Whether `session` is a conversation this part shows, on this computer: the core's own records, never the id's shape. */
async function shownHere(r: TreeRoute, session: string): Promise<boolean> {
  const got = (await r.request("session.get", { id: session }).catch(() => undefined)) as { session?: { kind?: unknown; bot?: unknown; computer?: unknown } } | undefined;
  const s = got?.session;
  if (s === undefined || typeof s.computer !== "string") return false;
  if (s.kind === "bot") {
    if (typeof s.bot !== "string") return false;
    const listed = (await r.request("bot.list", {})) as { bots?: { id?: unknown; mainSession?: unknown }[] } | undefined;
    if (!(listed?.bots ?? []).some((b) => b.id === s.bot && b.mainSession === session)) return false;
  } else if (s.kind !== "side-thread") {
    return false;
  }
  const computers = (await r.request("computer.list", {})) as { computers?: { name?: unknown; aliases?: unknown; link?: unknown }[] } | undefined;
  const self = (computers?.computers ?? []).find((c) => c.link === "self");
  const names = self === undefined ? [] : [self.name, ...(Array.isArray(self.aliases) ? self.aliases : [])];
  return names.includes(s.computer);
}

/** `session.resend` from the conversation part: `{session}`, and nothing else is read. */
export async function resend(r: TreeRoute, part: string): Promise<{ sent: true }> {
  const raw = (r.params !== null && typeof r.params === "object" && !Array.isArray(r.params) ? r.params : {}) as Record<string, unknown>;
  const session = raw.session;
  const refuse = (why: string, line = why): never => {
    r.log(`tree: ${part}: session.resend refused (${line})`);
    throw r.refuse(why);
  };
  if (typeof session !== "string" || !SESSION_RE.test(session)) return refuse("which conversation?");
  if (inFlight.has(session)) return refuse("it is being sent again already");
  inFlight.add(session);
  try {
    if (!(await shownHere(r, session))) return refuse(`this conversation can't be sent again from here; ${RESEND_FROM_COMPOSER}`, "not a conversation shown here on this computer");
    const first = await readFailedTurn(r, session);
    if (!first.ok) return refuse(first.why);
    // Right before the send: the log must still end in that same failed turn.
    const again = await readFailedTurn(r, session);
    if (!again.ok || again.turn !== first.turn) return refuse(again.ok ? "something has happened since" : again.why);
    try {
      await r.request("pill.send", { to: { session }, text: first.text, clientMessageId: `retry-${first.turn}` });
    } catch (e) {
      const bare = (e instanceof Error ? e.message : String(e)).replace(/(^|[\s("'`])(?:[A-Za-z]:)?[\\/][^\s"'`)]*/g, "$1…");
      return refuse(displayText(bare, REASON_MAX) ?? "it could not be sent", "the core refused the send");
    }
    r.log(`tree: ${part}: session.resend went through`);
    return { sent: true };
  } finally {
    inFlight.delete(session);
  }
}
