// Theme format 1 (spec §5.5, §5.9): `{ theme: 1, name, appearance?, tokens, dark?, css?, fonts?, icons? }`. A theme is
// data: design tokens first, then CSS that the app's cleaner keeps to its part (lane E). A `ui` entry's `style` file
// is in this format too, and restyles one part in place.
import { z } from "zod";
import { Path, Text } from "../manifest/fields";

export const ThemeTokensSchema = z.record(z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9.-]*$/), z.string().max(300));

export const ThemeSchema = z.strictObject({
  $schema: z.string().max(2048).optional(),
  theme: z.literal(1),
  name: Text,
  appearance: z.enum(["light", "dark", "both"]).optional(),
  tokens: ThemeTokensSchema,
  /** The dark appearance's token values, for a theme that is `both`. */
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
