// The theme tokens this part wears. A token named `color.text` in the catalog arrives in CSS as
// `--clover-color-text`; the catalog itself (names, types, defaults) is lane B's, in the plugin SDK,
// and this list is what to check against it. test/styles.test.ts fails if styles.css uses a token
// this list does not name, or this list names one styles.css does not use.
export const TOKENS = {
  "color.surface": "The content plane the conversation sits on",
  "color.raised": "Cards, tool output and code blocks: one step above the surface",
  "color.control": "Chips and small controls",
  "color.bubble": "The user's own message bubble",
  "color.hairline": "Dividers on the surface",
  "color.hairline-raised": "Dividers and rims drawn on raised planes",
  "color.hover": "A row or control under the pointer",
  "color.selected": "A chosen option",
  "color.text": "Body text",
  "color.text-secondary": "Secondary text: tool lines, quotes",
  "color.text-muted": "Quiet meta: times, notes, labels",
  "color.text-placeholder": "Placeholder text in fields",
  "color.link": "Links and link-like buttons",
  "color.accent": "Brand accent: selected options, event rules",
  "color.strong": "The primary action's fill",
  "color.on-strong": "Text on the primary action",
  "color.danger": "Failures",
  "color.warning": "Held calls, the safety check, warnings",
  "color.diff-added": "Added-line counts",
  "color.diff-removed": "Removed-line counts",
  "color.focus": "The keyboard focus ring",
  "color.shadow": "Shadows under floating controls",
  "font.body": "The body face",
  "font.display": "Headings in Markdown",
  "font.mono": "Code and tool output",
  "text.body": "Body size",
  "text.small": "Secondary size: tool lines, notes",
  "text.caption": "Meta size: times, chips",
  "text.code": "Code size",
  "line.body": "Body line height",
  "radius.bubble": "The user's bubble",
  "radius.card": "Cards and code blocks",
  "radius.control": "Small controls and options",
  "radius.pill": "Pills",
} as const;

export type Token = keyof typeof TOKENS;

/** `color.text` → `--clover-color-text`. */
export const cssVariable = (token: string) => `--clover-${token.replace(/\./g, "-")}`;
