// The theme tokens the browser panel wears, by lane B's catalog names (`packages/plugin-sdk/src/catalogs/tokens.ts`,
// B-M0 cc3aa7e76): `color.text.muted` arrives in CSS as `--clover-color-text-muted`. test/styles.test.ts
// fails if styles.css uses a token this list doesn't name, or this list names one styles.css doesn't use.
// The shell's gallery test checks every catalog name here against a snapshot of B's catalog.

/** Tokens from lane B's catalog. */
export const CATALOG_TOKENS = [
  "color.accent.soft",
  "color.accent.text",
  "color.danger",
  "color.focus",
  "color.hairline",
  "color.hairline.raised",
  "color.hover",
  "color.raised",
  "color.selected",
  "color.surface",
  "color.text",
  "color.text.muted",
  "color.text.placeholder",
  "color.text.secondary",
  "font.sans",
  "font.size.body",
  "font.size.control",
  "font.size.label",
  "radius.large",
  "radius.medium",
  "radius.small",
  "space.m",
  "space.s",
  "space.xl",
  "space.xs",
] as const;

/** The `clover` plugin's own tokens (`plugin.clover.<name>`, B's rule for a plugin's own). `bar.height` is the
 *  panel header's 45 px, the one the panel host's header wears too (the base theme has it); lane B's catalog has it
 *  as `titlebar.height`, which this takes the place of once B is on main. */
export const PART_TOKENS: readonly string[] = [
  "plugin.clover.bar.height",
];

export const TOKENS: readonly string[] = [...CATALOG_TOKENS, ...PART_TOKENS];

/** `color.text.muted` → `--clover-color-text-muted` (B's `cssProperty`). */
export const cssVariable = (token: string) => `--clover-${token.replace(/-/g, "_").replace(/\./g, "-")}`;
