// The theme tokens the diff panel wears, by lane B's catalog names (`packages/plugin-sdk/src/catalogs/tokens.ts`,
// B-M0 cc3aa7e76): `color.text.muted` arrives in CSS as `--clover-color-text-muted`. test/styles.test.ts
// fails if styles.css uses a token this list doesn't name, or this list names one styles.css doesn't use.
// The shell's gallery test checks every catalog name here against a snapshot of B's catalog.

/** Tokens from lane B's catalog. */
export const CATALOG_TOKENS = [
  "color.attention",
  "color.attention.text",
  "color.control",
  "color.diff.added",
  "color.diff.removed",
  "color.focus",
  "color.hairline",
  "color.hover",
  "color.raised",
  "color.selected",
  "color.surface",
  "color.text",
  "color.text.muted",
  "color.text.placeholder",
  "font.mono",
  "font.sans",
  "font.size.caption",
  "font.size.control",
  "font.size.label",
  "radius.medium",
  "radius.round",
  "radius.small",
  "space.m",
  "space.s",
  "space.xl",
  "space.xs",
] as const;

/** The `clover` plugin's own tokens (`plugin.clover.<name>`, B's rule for a plugin's own), each a request to
 *  B for a catalog entry (listed in the PR body). */
export const PART_TOKENS: readonly string[] = [
  "plugin.clover.diff.added.soft",
  "plugin.clover.diff.removed.soft",
  "plugin.clover.line.code",
];

export const TOKENS: readonly string[] = [...CATALOG_TOKENS, ...PART_TOKENS];

/** `color.text.muted` → `--clover-color-text-muted` (B's `cssProperty`). */
export const cssVariable = (token: string) => `--clover-${token.replace(/-/g, "_").replace(/\./g, "-")}`;
