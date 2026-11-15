// `conversation.messageAction`: a press on a plugin's small button in a message's row (`conversation.message.action`, data
// the conversation part draws itself: no frame, no component). The page names three things: the entry's ref, the session
// and the message's seq. Main decides the rest from what it holds, never from the page:
//   * the entry must be an active entry of that spot as the part's own `entries` resolve it now (its plugin on, its `when`
//     holding in that tab), and the handler is that entry's own `call`, from the plugin's manifest;
//   * it runs that plugin's handler, in its `ui` table only (`host.call` through `plugin.layer.api`, the core's capability
//     gate, as the plugin), with `{ session, seq }` and nothing else;
//   * its answer reaches the page as `{ ok: true }`, or `{ note }`: one plain sentence, cut to 300 characters.
// The call is a `gesture` entry: one key press or click the main process saw, spent per call; and one press at a time
// per entry and message.
import { displayText } from "@waifucave/clover-plugin-sdk/plain";
import type { TreeRoute } from "./tree-calls";

/** The spot whose entries this door runs. */
export const MESSAGE_ACTION_SPOT = "conversation.message.action";

const REF_RE = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?#[A-Za-z0-9._-]{1,64}$/;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const HANDLER_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
/** The most a handler's note shows a page. */
export const NOTE_MAX = 300;

const inFlight = new Set<string>();

/** The press, routed: `{ ok: true }` or `{ note }`. */
export async function messageAction(r: TreeRoute, part: string): Promise<{ ok: true } | { note: string }> {
  const raw = (r.params !== null && typeof r.params === "object" && !Array.isArray(r.params) ? r.params : {}) as Record<string, unknown>;
  const refuse = (why: string, line = why): never => {
    r.log(`tree: ${part}: conversation.messageAction refused (${line})`);
    throw r.refuse(why);
  };
  const ref = raw.entry;
  const session = raw.session;
  const seq = raw.seq;
  if (typeof ref !== "string" || !REF_RE.test(ref)) return refuse("which button?");
  if (typeof session !== "string" || !SESSION_RE.test(session)) return refuse("which conversation?");
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return refuse("which message?");
  if (r.entries === undefined) return refuse("message actions aren't served here");
  // Only an active entry of the spot, as the part's own spot resolves it now; its handler is the manifest's.
  const entry = r.entries(MESSAGE_ACTION_SPOT).find((e) => e.ref === ref);
  if (entry === undefined) return refuse("that button isn't there any more", `no active entry ${ref}`);
  const call = entry.fields.call;
  if (typeof call !== "string" || !HANDLER_RE.test(call)) return refuse("that button runs nothing", `${ref} has no handler`);
  const key = `${ref}|${session}|${seq}`;
  if (inFlight.has(key)) return refuse("it is running already");
  inFlight.add(key);
  let answer: unknown;
  try {
    const got = (await r.request("plugin.layer.api", { pluginId: entry.pluginId, call: "host.call", args: [call, { session, seq }], session })) as { result?: unknown } | undefined;
    answer = got?.result;
  } catch (e) {
    // The core's or the handler's own sentence, with any path cut out and capped.
    const bare = (e instanceof Error ? e.message : String(e)).replace(/(^|[\s("'`])(?:[A-Za-z]:)?[\\/][^\s"'`)]*/g, "$1…");
    return refuse(displayText(bare, NOTE_MAX) ?? "it didn't work", `${entry.pluginId}'s ${call} failed`);
  } finally {
    inFlight.delete(key);
  }
  const note = answer !== null && typeof answer === "object" ? (answer as { note?: unknown }).note : undefined;
  r.log(`tree: ${part}: conversation.messageAction ran ${entry.pluginId}'s ${call}`);
  if (typeof note === "string") {
    const plain = displayText(note, NOTE_MAX);
    if (plain !== undefined && plain !== "") return { note: plain };
  }
  return { ok: true };
}
