// Locale format 1 (spec §5.5 "Translations", §5.9): `{ locale: 1, lang, strings: { <key>: string | { one?, other, … } } }`.
// Keys start with their plugin's id and a dot, and the core's and `clover`'s with `clover.`; a child's keys start with
// its top-level plugin's id. Strings use `{name}` placeholders, and a key may hold plural forms by the language's
// rules (CLDR's categories, `other` required). A missing string falls back from a regional language to its base
// (`pt-BR` to `pt`), then to English, then to any language its plugin has.
import { z } from "zod";
import { utf16 } from "@waifucave/clover-protocol";
import { LangTag } from "../manifest/fields";

export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;

export const LocaleStringSchema = z.union([
  utf16(20_000),
  z.strictObject({
    zero: utf16(20_000).optional(),
    one: utf16(20_000).optional(),
    two: utf16(20_000).optional(),
    few: utf16(20_000).optional(),
    many: utf16(20_000).optional(),
    other: utf16(20_000),
  }),
]);

export const LOCALE_KEY_RE = /^[a-z][a-z0-9-]*(\.[A-Za-z0-9_-]+)+$/;

export const LocaleSchema = z.strictObject({
  $schema: utf16(2048).optional(),
  locale: z.literal(1),
  lang: LangTag,
  strings: z.record(utf16(256, 3).regex(LOCALE_KEY_RE), LocaleStringSchema),
});
export type Locale = z.infer<typeof LocaleSchema>;

/** The plugin a key belongs to: its first segment (`luna.greeting` → `luna`; `clover.…` → the core and `clover`). */
export function localeKeyOwner(key: string): string {
  return key.split(".")[0]!;
}

/** The languages a lookup tries, in order (§5.5): the language, its base, then English. The plugin's own other
 *  languages come last, at the app's choice. */
export function localeFallbacks(lang: string): string[] {
  const out: string[] = [];
  const parts = lang.split("-");
  for (let i = parts.length; i >= 1; i--) out.push(parts.slice(0, i).join("-"));
  if (!out.includes("en")) out.push("en");
  return out;
}

/** The `{name}` placeholders a string uses. */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
}
