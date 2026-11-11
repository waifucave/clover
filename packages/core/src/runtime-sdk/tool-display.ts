// What a plugin (MCP) tool shows in the conversation beside its real name: its listing's `title` as the
// `tool_call.displayTitle`, and its successful result's `structuredContent` as the `tool_result.display` object. Both
// are a plugin's own data, so both are made plain and bounded here, the one place they are read:
// * plain text: control (C0, C1), bidirectional, zero-width and line/paragraph separator characters are dropped,
//   whitespace runs become one space, and the ends are trimmed; nothing is ever parsed as markup (a client draws both
//   as text, the swatch only as a background colour);
// * bounded: a raw string is cut before it is cleaned, so a 1 MB value costs nothing, and the clean text is cut to its
//   cap in UTF-16 units (the protocol's `utf16` measure) without splitting a surrogate pair; empty means none;
// * exact: a display is exactly `{kind, label, value, swatch?}`, read as four own fields with `typeof`; the rest of the
//   plugin's `structuredContent` (a pinned note's handle, anything nested) never leaves the daemon.
//
// Display only: a title never names the tool on a card, in a rule, in the reviewer's input or on the OK card (they show
// the served `mcp__…` name), and a tool's MCP `annotations` (readOnlyHint and the rest) are not read at all: what is
// read-only or contained comes from the plugin's manifest alone.
import {
  TOOL_DISPLAY_KIND_SHAPE, TOOL_DISPLAY_LABEL_MAX, TOOL_DISPLAY_SWATCH_SHAPE, TOOL_DISPLAY_TITLE_MAX, TOOL_DISPLAY_VALUE_MAX,
  type ToolDisplay,
} from "@waifucave/clover-protocol";

/** How much of a raw string is looked at: well past any cap, so cleaning only shortens what's kept. */
const RAW_MAX = 1_024;

// C0 and DEL and C1 controls; bidirectional marks, embeddings, overrides and isolates (U+061C, U+200E/F, U+202A–E,
// U+2066–9); zero-width and invisible format characters (U+200B–D, U+2060–4, U+FEFF, U+180E); and U+2028/9.
const DROPPED = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const SPACES = /[\s\u2028\u2029]+/g;

/** `raw` as one plain line of at most `max` UTF-16 units; undefined when it isn't a string or nothing is left. */
export function displayText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = raw.slice(0, RAW_MAX).replace(DROPPED, "").replace(SPACES, " ").trim();
  if (clean === "") return undefined;
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, max);
  // Never half a surrogate pair at the end.
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trimEnd() || undefined;
}

/** A plugin tool's listing `title`, for display: plain, one line, at most 60 characters. */
export function toolDisplayTitle(raw: unknown): string | undefined {
  return displayText(raw, TOOL_DISPLAY_TITLE_MAX);
}

/** A plugin tool result's `structuredContent` as a display, or undefined when it doesn't give a valid one. */
export function toolDisplay(raw: unknown): ToolDisplay | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const own = (k: string): unknown => (Object.hasOwn(raw, k) ? (raw as Record<string, unknown>)[k] : undefined);
  const kind = own("kind");
  if (typeof kind !== "string" || !TOOL_DISPLAY_KIND_SHAPE.test(kind)) return undefined;
  const label = displayText(own("label"), TOOL_DISPLAY_LABEL_MAX);
  const value = displayText(own("value"), TOOL_DISPLAY_VALUE_MAX);
  if (label === undefined || value === undefined) return undefined;
  const swatch = own("swatch");
  return { kind, label, value, ...(typeof swatch === "string" && TOOL_DISPLAY_SWATCH_SHAPE.test(swatch) ? { swatch } : {}) };
}

/** The most results kept waiting for their `tool_result` frame; past it the oldest go (a call the runtime never
 *  reported, an interrupted one). */
export const PENDING_DISPLAYS_MAX = 256;

/** One session's displays from its plugin tools' results, by call id, until the projector takes each for the call's
 *  `tool_result` (once: a replayed frame never re-stamps one). */
export class ToolDisplays {
  readonly #pending = new Map<string, ToolDisplay>();

  /** Keeps what a successful result shows; an error, or a result with no valid display, keeps nothing. */
  put(callId: string, result: { isError?: unknown; structuredContent?: unknown }): void {
    if (result.isError === true) return;
    const d = toolDisplay(result.structuredContent);
    if (d === undefined) return;
    this.#pending.delete(callId);
    this.#pending.set(callId, d);
    while (this.#pending.size > PENDING_DISPLAYS_MAX) this.#pending.delete(this.#pending.keys().next().value!);
  }

  take(callId: string): ToolDisplay | undefined {
    const d = this.#pending.get(callId);
    if (d !== undefined) this.#pending.delete(callId);
    return d;
  }

  get size(): number {
    return this.#pending.size;
  }

  clear(): void {
    this.#pending.clear();
  }
}
