// Theme format 1 (spec §5.5, §5.9): `{ theme: 1, name, appearance?, tokens, dark?, css?, fonts?, icons? }`. A theme is
// data: design tokens first, then CSS that the app's cleaner keeps to its part (lane E). A `ui` entry's `style` file
// is in this format too, and restyles one part in place.
//
// Its paths (`css`, `fonts[].src`, `icons`) are relative to the plugin folder, as every `Path` is (§5.9), wherever the
// theme file sits: `tab/theme.json` names `tab/theme.css`. A CSS file's own `url()`s are relative to that CSS file, as
// in any stylesheet, and stay inside the folder.
import { z } from "zod";
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
