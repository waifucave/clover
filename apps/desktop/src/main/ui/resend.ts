// `session.resend`: the conversation part's "Try again" on a turn that ended in an error. The page names only the session;
// main forwards `{session}` to the daemon's own `session.resend` on the app's connection and decides nothing from the
// session's log: the daemon does, under the session's own ordering (the latest turn failed, it began from the user's own
// message by the turn's recorded origin, nothing sent or started since, once per failed turn, a bot's main conversation on
// this computer only). The page gets `{sent: true}`: no seq, no words, no id. Nothing the page says but the session's id
// is read: not the words, pictures, a message or an id.
//
// The call itself is a `gesture` entry: one key press or click the main process saw, spent per call. Main also lets one
// call per session be under way at a time, so a second click while the first is on its way is refused.
import { displayText } from "@waifucave/clover-plugin-sdk/plain";
import type { TreeRoute } from "./tree-calls";

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** The most a refusal's reason shows a page. */
const REASON_MAX = 300;
/** Sessions with a call under way. */
const inFlight = new Set<string>();

/** `session.resend` from the conversation part: `{session}`, and nothing else is read or sent. */
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
    await r.request("session.resend", { session });
  } catch (e) {
    // The daemon's own plain sentence, with any path cut out and capped.
    const bare = (e instanceof Error ? e.message : String(e)).replace(/(^|[\s("'`])(?:[A-Za-z]:)?[\\/][^\s"'`)]*/g, "$1…");
    return refuse(displayText(bare, REASON_MAX) ?? "it could not be sent again", "the core refused it");
  } finally {
    inFlight.delete(session);
  }
  r.log(`tree: ${part}: session.resend went through`);
  return { sent: true };
}
