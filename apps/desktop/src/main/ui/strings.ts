// Each document's strings (spec §5.5 "Translations", the `locales` point). Pure apart from reading locale files.
//
// A document reads its plugin's keys: `<top-level id>.…`, and `clover.…` for the `clover` layer and the core root. For
// each key the table takes the first string it finds, trying the user's language, its base (`pt-BR` → `pt`), English,
// then any language the key's own plugin has; in each language the plugin's own tables first (the core's built-in
// English for `clover.` keys among them), then packs: the one the user chose for that language, then the first
// enabled. A pack is any plugin's table for keys that aren't its own, except a bot's: a bot's plugin translates only
// its own keys (a pack for the rest can be a child in its folder). The strings of sealed cards and the OK (`clover.card.…`,
// `clover.ok.…`) come only from the built-in tables, the `clover` tree's own and packs whose tree hash matches the
// official index, so a pack a bot edits can't relabel them; without one they read in English.
import { readFileSync } from "node:fs";
import { LocaleSchema, localeFallbacks, type Locale } from "@waifucave/clover-plugin-sdk";
import type { LocaleValue, StringTable } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { pluginFile } from "./files";
import type { UiPlugin } from "./model";

/** The keys only trusted tables may translate (sealed cards, the OK). */
export const TRUSTED_PREFIXES: readonly string[] = ["clover.card.", "clover.ok."];

export function isTrustedKey(key: string): boolean {
  return TRUSTED_PREFIXES.some((p) => key.startsWith(p));
}

/** A language tag as tables are keyed: its language lower-case, the rest as written (`pt-BR`). */
export function normalizeLang(lang: string): string {
  const parts = lang.replace(/_/g, "-").split("-").filter((p) => p !== "");
  if (parts.length === 0) return "en";
  return [parts[0]!.toLowerCase(), ...parts.slice(1)].join("-");
}

export interface StringsInput {
  plugins: readonly UiPlugin[];
  /** The user's language (Settings), else the system's. */
  lang: string;
  /** The pack the user chose for a language, by language (`UiSettings.packs`). */
  packs?: Readonly<Record<string, string>>;
  /** The core's own tables, by language: English at least. */
  builtIn: Readonly<Record<string, Readonly<Record<string, LocaleValue>>>>;
  /** Whether a plugin's tree hash matches the official index's (lane B's registry says so). */
  official?: (plugin: UiPlugin) => boolean;
}

interface Table {
  lang: string;
  strings: Readonly<Record<string, LocaleValue>>;
  /** The core's, a `clover` table, or the plugin whose key it is. */
  own: boolean;
  trusted: boolean;
  /** For packs: the user's choice first, then the first enabled. */
  rank: number;
}

/** Locale files, read once per plugin version. */
export class StringStore {
  private readonly cache = new Map<string, Locale | null>();

  constructor(private readonly log: (line: string) => void = () => {}) {}

  read(plugin: UiPlugin, file: string): Locale | null {
    const key = `${plugin.id}\0${plugin.treeHash}\0${file}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let locale: Locale | null = null;
    try {
      const parsed = LocaleSchema.safeParse(JSON.parse(readFileSync(pluginFile(plugin, file), "utf8")));
      if (parsed.success) locale = parsed.data;
      else this.log(`strings: ${plugin.id}/${file} is not a valid locale`);
    } catch (err) {
      this.log(`strings: ${plugin.id}/${file} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.cache.set(key, locale);
    return locale;
  }

  clear(): void {
    this.cache.clear();
  }
}

function tablesFor(store: StringStore, input: StringsInput, owner: string): Table[] {
  const out: Table[] = [];
  if (owner === "clover") {
    for (const [lang, strings] of Object.entries(input.builtIn)) out.push({ lang: normalizeLang(lang), strings, own: true, trusted: true, rank: -1 });
  }
  const packs = [...input.plugins].sort((a, b) => a.enabledAt - b.enabledAt || a.id.localeCompare(b.id));
  for (const [index, p] of packs.entries()) {
    const own = p.topId === owner;
    // A bot's plugin translates only its own keys.
    if (!own && p.isBot) continue;
    for (const l of p.locales) {
      const locale = store.read(p, l.file);
      if (locale === null) continue;
      const lang = normalizeLang(locale.lang);
      const chosen = input.packs?.[lang] === p.id || input.packs?.[locale.lang] === p.id;
      out.push({ lang, strings: locale.strings, own, trusted: p.topId === "clover" || (input.official?.(p) ?? false), rank: chosen ? -1 : index });
    }
  }
  return out;
}

/** The strings a document of `owner`'s (a top-level plugin id; `clover` for the core and the `clover` layer) reads. */
export function stringTable(store: StringStore, input: StringsInput, owner: string): StringTable {
  const lang = normalizeLang(input.lang);
  const prefix = `${owner}.`;
  const tables = tablesFor(store, input, owner);
  const chain = localeFallbacks(lang).map(normalizeLang);
  // Then any language the key's own plugin has, in a stable order.
  const others = [...new Set(tables.filter((t) => t.own && !chain.includes(t.lang)).map((t) => t.lang))].sort();
  const strings: Record<string, LocaleValue> = {};
  const fallback: Record<string, string> = {};
  for (const l of [...chain, ...others]) {
    const inLang = tables.filter((t) => t.lang === l && (t.own || !others.includes(l))).sort((a, b) => Number(b.own) - Number(a.own) || a.rank - b.rank);
    for (const t of inLang) {
      for (const [key, value] of Object.entries(t.strings)) {
        if (!key.startsWith(prefix) || strings[key] !== undefined) continue;
        if (isTrustedKey(key) && !t.trusted) continue;
        strings[key] = value;
        if (l !== lang) fallback[key] = l;
      }
    }
  }
  return { lang, strings, ...(Object.keys(fallback).length > 0 ? { fallback } : {}) };
}

/** A manifest `Text` (a string, or translations inline with `en`) in a language, falling back as tables do. */
export function textIn(text: unknown, lang: string): string {
  if (typeof text === "string") return text;
  if (text === null || typeof text !== "object") return "";
  const map = text as Record<string, unknown>;
  for (const l of localeFallbacks(normalizeLang(lang))) {
    const hit = Object.entries(map).find(([k]) => normalizeLang(k) === normalizeLang(l));
    if (typeof hit?.[1] === "string") return hit[1];
  }
  return typeof map.en === "string" ? map.en : "";
}
