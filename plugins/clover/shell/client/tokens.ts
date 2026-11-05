// The theme tokens this part wears (`color.text` arrives as `--clover-color-text`). The catalog is
// lane B's, in the plugin SDK; this list is what to check against it. test/styles.test.ts fails if
// styles.css and this list disagree.
export const TOKENS = {
  "color.canvas": "The sidebar's plane, the base the app sits on",
  "color.raised": "Banners",
  "color.control": "A portrait with no picture",
  "color.hover": "A row under the pointer",
  "color.selected": "The open route's row",
  "color.hairline": "The sidebar's edge and dividers",
  "color.text": "Names and the wordmark",
  "color.text-secondary": "Row ink and app glyphs",
  "color.text-muted": "Status lines and headings",
  "color.link": "A banner's action",
  "color.strong": "Count badges and the unread dot",
  "color.on-strong": "A count on its badge",
  "color.accent": "A bot that is thinking or working",
  "color.warning": "Needs you; warning banners",
  "color.danger": "A failed or stalled agent",
  "color.focus": "The keyboard focus ring",
  "font.body": "The body face",
  "font.display": "The wordmark",
  "text.small": "Rows",
  "text.caption": "Status lines, headings and banners",
  "radius.control": "Rows and tool buttons",
  "radius.card": "Banners",
  "radius.pill": "Portraits and badges",
} as const;

export type Token = keyof typeof TOKENS;

export const cssVariable = (token: string) => `--clover-${token.replace(/\./g, "-")}`;
