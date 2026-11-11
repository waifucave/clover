// The one cleaner for text a page may show that a file, a plugin or a model wrote (a tool's display, an avatar's credit
// note, a picked file's name, the core's reason for a refusal): plain, one line, bounded. Control (C0, C1), soft hyphen,
// bidirectional, zero-width, variation selector, tag and line/paragraph separator characters are dropped, at most
// MARKS_MAX combining marks stay on a base character, whitespace runs become one space, and the ends are trimmed.
// Nothing is ever parsed as markup. Its call sites share it (core `tool-display.ts` and `bots/user-layer.ts`, the
// desktop door `tree-calls.ts`, the bot editor): a test holds them to it.

/** How much of a raw string is looked at: well past any cap, so cleaning only shortens what's kept. */
const RAW_MAX = 1_024;

// C0 and DEL and C1 controls and the soft hyphen (U+00AD); bidirectional marks, embeddings, overrides and isolates
// (U+061C, U+200E/F, U+202A–E, U+2066–9); zero-width and invisible format characters (U+200B–D, U+2060–4, U+FEFF,
// U+180E); variation selectors (U+FE00–F, U+E0100–E01EF), tag characters (U+E0000–E007F) and a lone surrogate.
const DROPPED = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}\p{Cs}]/gu;
/** At most this many combining marks on one base character; the rest are dropped, so nothing renders as a tall stack. */
export const MARKS_MAX = 3;
const MARK_RUN = new RegExp(`(\\p{M}{${MARKS_MAX}})\\p{M}+`, "gu");
const SPACES = /[\s\u2028\u2029]+/g;

/** `raw` as one plain line of at most `max` UTF-16 units; undefined when it isn't a string or nothing is left. */
export function displayText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = raw.slice(0, RAW_MAX).replace(DROPPED, "").replace(MARK_RUN, "$1").replace(SPACES, " ").trim();
  if (clean === "") return undefined;
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, max);
  // Never half a surrogate pair at the end.
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trimEnd() || undefined;
}
