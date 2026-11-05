// The theme tokens this part wears (`color.text` arrives as `--clover-color-text`). The catalog is
// lane B's, in the plugin SDK; this list is what to check against it. test/styles.test.ts fails if
// styles.css and this list disagree.
export const TOKENS = {
  "color.composer": "The composer card's face",
  "color.composer-rim": "The composer card's rim",
  "color.floating": "Menus that float above content",
  "color.control": "Round buttons and attachment chips",
  "color.hover": "A control under the pointer",
  "color.selected": "The chosen effort",
  "color.hairline-raised": "Rims on floating and raised planes",
  "color.strong": "The send button's fill",
  "color.on-strong": "The send button's glyph",
  "color.accent": "Push-to-talk while held; the drop target",
  "color.on-accent": "The glyph on the accent",
  "color.text": "Typed text",
  "color.text-secondary": "The model pill; the asleep note",
  "color.text-muted": "Notes and details",
  "color.text-placeholder": "The placeholder",
  "color.danger": "Too many attachments",
  "color.focus": "The keyboard focus ring",
  "color.shadow": "The card's and the menu's shadow",
  "font.body": "The body face",
  "text.body": "Typed text, bound to the user's message size",
  "text.small": "The model pill and chips",
  "text.caption": "Notes",
  "line.body": "Typed text's line height",
  "radius.composer": "The composer card",
  "radius.card": "The model menu",
  "radius.control": "Chips and menu items",
  "radius.pill": "Round buttons and pills",
} as const;

export type Token = keyof typeof TOKENS;

export const cssVariable = (token: string) => `--clover-${token.replace(/\./g, "-")}`;
