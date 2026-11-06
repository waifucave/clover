// The Dispatch pill's words. The English table is `locales/en.json` (locale format 1, spec §5.5 "Translations"), which the manifest
// declares, so the app has it to fall back to and a language pack can translate every key. `t` asks the translator the
// app installs (`setTranslator`: lane E's `useT()` in a part, the plugin API's `t` in a host half) and falls back to
// English for a key it doesn't know. Keys start with `clover.`; strings use `{name}` placeholders, and a key may hold
// plural forms, chosen by `count`.

import en from "../locales/en.json" with { type: "json" };

type Entry = string | { readonly zero?: string; readonly one?: string; readonly two?: string; readonly few?: string; readonly many?: string; readonly other: string };

/** The app's translator for this plugin's keys, in the user's language: a key it has no string for reads as itself. */
export type Translator = (key: string, params?: Record<string, string | number>) => string;

/** The English table, as `locales/en.json` holds it. */
export const EN: Readonly<Record<string, Entry>> = en.strings;

let installed: Translator | null = null;

/** Installs the app's translator (null: English only). Calling it again with the same one changes nothing. */
export function setTranslator(translator: Translator | null): void {
  installed = translator;
}

const englishPlurals = new Intl.PluralRules("en");

/** A key's English string, its placeholders filled and its plural form chosen by `count`. */
export function english(key: string, vars: Record<string, string | number> = {}): string {
  const entry = EN[key];
  if (entry === undefined) return key;
  let text: string;
  if (typeof entry === "string") text = entry;
  else {
    const n = typeof vars.count === "number" ? vars.count : Number(vars.count);
    const form = Number.isFinite(n) ? englishPlurals.select(n) : "other";
    text = entry[form] ?? entry.other;
  }
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  if (installed) {
    const text = installed(key, vars);
    if (text !== key) return text;
  }
  return english(key, vars);
}
