// The activity feed and a tool's live picture on the app (lane AF, spec revision 19, §3.6): a folder-installed plugin that
// reads the bots' feed (`activity.read.bots`) and their pictures (`picture.read.bots`) and publishes one picture of its own
// through a server that declares it. The OK card says what the plugin may do in the corrected plain lines; the feed followed
// a bot through thinking, working (naming the tool) and done, carrying only a state, a name, a tool and a time; the picture
// was keyed to the bot's session and shows the publisher's id, and its stream gave the frame the tool wrote; the other kind of
// data, a server that declares no picture and a made-up session were all refused. Kept apart from run.ts (which starts a run
// when loaded) so the verdict can be unit-tested.

export const FEED_STEP = "the activity feed and a tool's live picture: a folder-installed plugin follows a bot through thinking, working and done (states, a name and a tool's name only), lists and opens the picture its own tool published (keyed to the bot's session), and is refused the code sessions' feed and pictures, a picture from a server that declares none and a picture under a made-up session; its OK card says the corrected lines";

/** The OK card's plain lines this row looks for (the catalog's `ok` words, and the picture line from the manifest). */
export const FEED_CARD_LINES: readonly string[] = [
  "follows what all your bots are doing: their names, their states and which tool they are using, never their words",
  "shows live pictures of what all your bots' tools are doing, which can include your own screen and pages you are signed in to",
  "It shows a live picture of what it is doing.",
  "or press its own key anywhere in MOSS Code's window",
  "reads MOSS Code's settings, and changes its window's look, language and which plugin does each job when you press its controls",
  "adds items to the menu in your menu bar",
  "shows and changes, for each plugin tool, whether it may be used and whether it asks first",
];

/** Which of the card's lines the card text lacks. */
export function feedCardWrong(cardText: string): string[] {
  return FEED_CARD_LINES.filter((l) => !cardText.includes(l)).map((l) => `its OK card doesn't say "${l.slice(0, 60)}"`);
}

/** The probe's answer, `acceptance-feed-pong k=v …`, as pairs. */
export function feedProbePairs(text: string): Record<string, string> {
  const at = text.indexOf("acceptance-feed-pong");
  if (at < 0) return {};
  return Object.fromEntries(text.slice(at).split(/\s+/).slice(1).filter((kv) => kv.includes("=")).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
}

/** `thinking`, `working` and `done` in that order somewhere in a bot's states (others may lie between). */
export function followsThroughTurn(states: string): boolean {
  const order = ["thinking", "working", "done"];
  return states.split(",").some((entry) => {
    const list = entry.slice(entry.indexOf("/") + 1).split(">");
    let want = 0;
    for (const s of list) if (s === order[want]) want++;
    return want === order.length;
  });
}

/** The keys a feed view may carry: a state, a name, a tool's name and a time, nothing of what was said. */
const ALLOWED_KEYS = new Set(["subject", "state", "name", "tool", "since"]);

/** What is wrong with the probe's answer, one clause each; empty when the feed and the pictures answered as served. */
export function feedProbeWrong(said: Record<string, string>): string[] {
  const wrong: string[] = [];
  const want = (k: string, ok: (v: string) => boolean, what: string) => {
    const v = said[k];
    if (v === undefined || !ok(v)) wrong.push(`${k}: ${what} (got ${v ?? "nothing"})`);
  };
  want("states", followsThroughTurn, "a bot followed through thinking, working and done");
  want("keys", (v) => v.split(",").length > 0 && v.split(",").every((k) => ALLOWED_KEYS.has(k)) && v.includes("state"), "views carrying only a state, a name, a tool and a time");
  want("tool", (v) => v === "show", "the working state naming the tool Show");
  want("list", (v) => /^bots:\d+$/.test(v), "the bots' feed listed");
  want("other-activity", (v) => v.startsWith("refused:"), "the code sessions' feed refused without activity.read.sessions");
  want("pictures", (v) => /^acceptance-feed:show:64x48:screen-false:session-set$/.test(v), "its own picture listed, with its publisher, its tool's name and its size");
  want("stream", (v) => /^frame:120:ffd8$/.test(v), "the picture's stream giving the frame the tool wrote");
  want("other-pictures", (v) => v.startsWith("refused:"), "the code sessions' pictures refused without picture.read.sessions");
  want("no-declare", (v) => v.startsWith("refused:"), "a picture from a server that declares none refused");
  want("made-up-session", (v) => v.startsWith("refused:"), "a picture naming a session of its own refused");
  return wrong;
}
