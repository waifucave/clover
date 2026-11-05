// The theme tokens this part wears, by lane B's catalog names (`packages/plugin-sdk/src/catalogs/tokens.ts`,
// B-M0 cde691273): `color.text.muted` arrives in CSS as `--clover-color-text-muted`. test/styles.test.ts
// fails if styles.css uses a token this list doesn't name, or this list names one styles.css doesn't use.
// The shell's gallery test checks every catalog name here against a snapshot of B's catalog.

/** Tokens from lane B's catalog. */
export const CATALOG_TOKENS = [
  "bubble.radius",
  "bubble.user.background",
  "color.accent",
  "color.accent.text",
  "color.attention.text",
  "color.control",
  "color.danger",
  "color.diff.added",
  "color.diff.removed",
  "color.focus",
  "color.hairline",
  "color.hairline.raised",
  "color.hover",
  "color.raised",
  "color.selected",
  "color.surface",
  "color.text",
  "color.text.inverse",
  "color.text.muted",
  "color.text.placeholder",
  "color.text.secondary",
  "font.display",
  "font.line.body",
  "font.line.tight",
  "font.mono",
  "font.sans",
  "font.size.body",
  "font.size.caption",
  "font.size.code",
  "font.size.control",
  "radius.large",
  "radius.medium",
  "radius.round",
  "radius.small",
  "space.m",
  "space.s",
  "space.xs",
] as const;

/** Part-local tokens, named as B's rule has a plugin's own (`<top-level id>.<name>`, so `clover.…`), each
 *  a request to B for a catalog entry (listed in the PR body). A theme sets them like any other. */
export const PART_TOKENS = [
  "clover.line.code",
] as const;

export const TOKENS: readonly string[] = [...CATALOG_TOKENS, ...PART_TOKENS];

/** `color.text.muted` → `--clover-color-text-muted`; a hyphen inside a segment would become `_` (B's
 *  `cssProperty`), and none of these has one. */
export const cssVariable = (token: string) => `--clover-${token.replace(/-/g, "_").replace(/\./g, "-")}`;
