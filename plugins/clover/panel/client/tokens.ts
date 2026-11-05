// The theme tokens the panel wears, by lane B's catalog names (`packages/plugin-sdk/src/catalogs/tokens.ts`,
// B-M0 cde691273): `color.text.muted` arrives in CSS as `--clover-color-text-muted`. test/styles.test.ts
// fails if styles.css uses a token this list doesn't name, or this list names one styles.css doesn't use.
// The shell's gallery test checks every catalog name here against a snapshot of B's catalog.

/** Tokens from lane B's catalog. */
export const CATALOG_TOKENS = [
  "color.accent",
  "color.accent.text",
  "color.attention.text",
  "color.control",
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
  "color.text.muted",
  "color.text.secondary",
  "font.line.tight",
  "font.mono",
  "font.sans",
  "font.size.body",
  "font.size.caption",
  "font.size.control",
  "font.weight.regular",
  "radius.large",
  "radius.medium",
  "radius.round",
  "radius.small",
  "space.m",
  "space.s",
  "space.xs",
] as const;

/** Part-local tokens, named as B's rule names a plugin's own (`<top-level id>.<name>`, so `clover.…`),
 *  each a request to B for a catalog entry (listed in the PR body). */
export const PART_TOKENS: readonly string[] = [
];

export const TOKENS: readonly string[] = [...CATALOG_TOKENS, ...PART_TOKENS];

/** `color.text.muted` → `--clover-color-text-muted` (B's `cssProperty`). */
export const cssVariable = (token: string) => `--clover-${token.replace(/-/g, "_").replace(/\./g, "-")}`;
