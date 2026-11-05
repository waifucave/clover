// Refusals and failures, in plain words. Every one becomes a tool error (`isError: true`) the model reads; nothing is
// thrown out of the MCP server.

/** A refusal or failure the tool words itself. */
export class ToolFailure extends Error {}

/**
 * The browser API's error codes, as the core's browser service gives them (`packages/core/src/browser/policy.ts`,
 * `BrowserErrorCode`), with what each means to a model. How a code reaches the plugin host is lane B's to settle; this
 * reads `code` off the error, or `data.code` for a JSON-RPC error, and falls back to the error's own message.
 */
const SENTENCES: Record<string, string> = {
  held: "The person is using this tab in the browser view right now, so it's theirs until they let go of it. Wait and try again, or work in another tab. (You can still list tabs and take screenshots.)",
  point_stale: "That point came from a screenshot taken at another size: the tab has changed size since. Take a new screenshot and use its points.",
  stalled: "The tab has stopped drawing, so there's no fresh picture of it. Try again in a moment, or reload it.",
  no_tab: "That tab isn't open any more. Use tabs to see the tabs you have.",
  not_yours: "That tab belongs to someone else; you can use only your own tabs.",
  url_refused: "The browser doesn't open that address: only web pages (http and https) and about:blank.",
  no_app: "The Clover app isn't running on this computer, so its browser isn't either. It starts again by itself; try again shortly.",
  bad_owner: "The browser didn't accept whose tab this is.",
};

/** What the tool says when the person holds a tab, whether it finds out first or the core does. */
export const HELD_SENTENCE = SENTENCES.held!;

/** Codes whose own message carries what the model needs. */
const WITH_DETAIL: ReadonlySet<string> = new Set(["method_refused", "bad_viewport", "app_failed"]);

export function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const o = e as { code?: unknown; data?: unknown };
  if (typeof o.code === "string") return o.code;
  if (typeof o.data === "object" && o.data !== null) {
    const d = o.data as { code?: unknown; reason?: unknown };
    if (typeof d.code === "string") return d.code;
    if (typeof d.reason === "string") return d.reason;
  }
  return undefined;
}

function messageOf(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return m.trim().length > 0 ? m.trim() : "no reason given";
}

/** An error from the browser API (or anything else that went wrong under a verb), in words for the model. */
export function describeError(e: unknown, verb: string): string {
  if (e instanceof ToolFailure) return e.message;
  if (e instanceof Error && e.name === "AbortError") return `The ${verb} was stopped before it finished.`;
  const code = errorCode(e);
  if (code !== undefined) {
    const sentence = SENTENCES[code];
    if (sentence !== undefined) return sentence;
    if (WITH_DETAIL.has(code)) return `The browser refused the ${verb}: ${messageOf(e)}`;
  }
  return `The browser couldn't ${verb}: ${messageOf(e)}`;
}
