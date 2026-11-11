// What a plugin (MCP) tool shows in the conversation beside its real name: its listing's `title` as the
// `tool_call.displayTitle`, and its successful result's `structuredContent` as the `tool_result.display` object. Both
// are a plugin's own data, so both are made plain and bounded here, the one place they are read:
// * plain text: control (C0, C1), soft hyphen, bidirectional, zero-width, variation selector, tag and line/paragraph
//   separator characters are dropped, at most MARKS_MAX combining marks stay on a base character, whitespace runs
//   become one space, and the ends are trimmed; nothing is ever parsed as markup (a client draws both
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

import { displayText, MARKS_MAX } from "@waifucave/clover-plugin-sdk/plain";
export { displayText, MARKS_MAX };

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

  /** Forgets a call's display (it was cancelled, timed out or failed). */
  drop(callId: string): void {
    this.#pending.delete(callId);
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
