// The theme tokens the window frame wears, by lane B's catalog names (`packages/plugin-sdk/src/catalogs/tokens.ts`,
// B-M0 cc3aa7e76): `color.text.muted` arrives in CSS as `--moss-color-text-muted`. test/styles.test.ts
// fails if styles.css uses a token this list doesn't name, or this list names one styles.css doesn't use.
// The shell's gallery test checks every catalog name here against a snapshot of B's catalog.

/** Tokens from lane B's catalog. */
export const CATALOG_TOKENS = [
  "color.accent",
  "color.attention.text",
  "color.control",
  "color.danger",
  "color.focus",
  "color.hairline",
  "color.hairline.raised",
  "color.hover",
  "color.selected",
  "color.surface",
  "color.text",
  "color.text.muted",
  "color.text.secondary",
  "font.line.body",
  "font.line.tight",
  "font.sans",
  "font.size.body",
  "font.size.caption",
  "font.size.control",
  "font.size.label",
  "font.size.title",
  "font.weight.regular",
  "font.weight.semibold",
  "radius.large",
  "radius.medium",
  "radius.round",
  "radius.small",
  "space.l",
  "space.m",
  "space.s",
  "space.xl",
  "space.xs",
  "space.xxl",
] as const;

/** The `moss` plugin's own tokens (`plugin.moss.<name>`, B's rule for a plugin's own), each a request to
 *  B for a catalog entry (listed in the PR body). */
export const PART_TOKENS: readonly string[] = [
  "plugin.moss.bar.blur",
  "plugin.moss.bar.height",
  "plugin.moss.bar.tint",
  "plugin.moss.scrim",
  "plugin.moss.sidebar.solid",
  "plugin.moss.sidebar.tint",
];

export const TOKENS: readonly string[] = [...CATALOG_TOKENS, ...PART_TOKENS];

/** `color.text.muted` → `--moss-color-text-muted` (B's `cssProperty`). */
export const cssVariable = (token: string) => `--moss-${token.replace(/-/g, "_").replace(/\./g, "-")}`;
