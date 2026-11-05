// Theme format 1 (spec §5.5, §5.9): `{ theme: 1, name, appearance?, tokens, dark?, css?, fonts?, icons? }`. A theme is
// data: design tokens first, then CSS that the app's cleaner keeps to its part (lane E). A `ui` entry's `style` file
// is in this format too, and restyles one part in place.
//
// Its paths (`css`, `fonts[].src`, `icons`) are relative to the plugin folder, as every `Path` is (§5.9), wherever the
// theme file sits: `tab/theme.json` names `tab/theme.css`. A CSS file's own `url()`s are relative to that CSS file, as
// in any stylesheet, and stay inside the folder (`css-url.ts`).
//
// Appearance. A theme applies only in the appearances it names: `light`, `dark`, or `both` (the default). In a
// `light` or `dark` theme, `tokens` are that appearance's values and `dark` is ignored. In a `both` theme, `tokens`
// apply in light and dark alike, and `dark.tokens` replace some of them in dark. So a light-only theme does nothing
// in dark: its tab shows the layers under it in dark, never its light colours on a dark ground.
//
// The fallback order for one token, in one appearance, at one part (§5.5 "Themes stack"): the first of these that
// applies in that appearance and sets the token wins, highest first:
//   6. the user's own overrides;
//   5. the plugins that dress the part, the smallest part first, then each part around it (tokens flow down);
//   4. the bot's theme, in its tab;
//   3. the user's global theme (until the user picks one, the base theme);
//   2. in bot tabs, the base theme for all bot tabs (`clover`'s);
//   1. the catalog's default for that appearance (`dark` where it has one, else `default`).
// A plugin's own tokens (`plugin.<id>.…`) have no catalog default: unset, its CSS's `var()` fallback applies.
// `resolveTokens` computes one part's values from its layers.
import { z } from "zod";
import { TOKENS, isSafeTokenValue, type TokenValue } from "../catalogs/tokens";
import { Path, Text } from "../manifest/fields";

/** A token's value: a string, or a plain number for `number` and `fontWeight` tokens. The catalog
 *  (`catalogs/tokens.ts`) checks each value against its token's type. */
export const ThemeTokenValueSchema = z.union([z.string().max(300), z.number().finite()]);
/** Token name → value: the catalog's tokens, and the plugin's own (`<top-level plugin id>.<name>`). */
export const ThemeTokensSchema = z.record(z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9.-]*$/), ThemeTokenValueSchema);

export const ThemeSchema = z.strictObject({
  $schema: z.string().max(2048).optional(),
  theme: z.literal(1),
  name: Text,
  appearance: z.enum(["light", "dark", "both"]).optional(),
  tokens: ThemeTokensSchema,
  /** The dark appearance's token values, for a theme that is `both`: only those that differ from `tokens`. */
  dark: z.strictObject({ tokens: ThemeTokensSchema }).optional(),
  /** Cleaned CSS: no `@import`, `url()` only for files inside the folder, no remote fonts or images (§5.5). */
  css: Path.optional(),
  fonts: z.array(z.strictObject({
    family: z.string().min(1).max(100).regex(/^[A-Za-z0-9 _-]+$/),
    src: Path,
    weight: z.string().max(16).optional(),
    style: z.enum(["normal", "italic"]).optional(),
  })).max(64).optional(),
  icons: z.record(z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9.-]*$/), Path).optional(),
});
export type Theme = z.infer<typeof ThemeSchema>;

export type Appearance = "light" | "dark";

/** A theme's values in one appearance, or `undefined` when it doesn't apply there. Unsafe values are dropped. */
export function themeTokensFor(theme: Pick<Theme, "appearance" | "tokens" | "dark">, appearance: Appearance): Record<string, TokenValue> | undefined {
  const applies = theme.appearance ?? "both";
  if (applies !== "both" && applies !== appearance) return undefined;
  const merged: Record<string, TokenValue> = { ...theme.tokens };
  if (applies === "both" && appearance === "dark") Object.assign(merged, theme.dark?.tokens ?? {});
  for (const [name, value] of Object.entries(merged)) if (!isSafeTokenValue(value)) delete merged[name];
  return merged;
}

/** One part's token values in one appearance: the catalog's defaults, then each layer's values over them, `layers`
 *  given lowest first (base theme, global theme, the bot's theme, the dressing plugins from the outermost part in,
 *  the user's overrides). */
export function resolveTokens(appearance: Appearance, layers: readonly Pick<Theme, "appearance" | "tokens" | "dark">[]): Record<string, TokenValue> {
  const out: Record<string, TokenValue> = {};
  for (const t of TOKENS) out[t.name] = appearance === "dark" && t.dark !== undefined ? t.dark : t.default;
  for (const layer of layers) Object.assign(out, themeTokensFor(layer, appearance) ?? {});
  return out;
}
