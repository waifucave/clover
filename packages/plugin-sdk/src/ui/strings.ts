// Strings in a layer (spec §5.5 "Translations"): the table the core resolved for this document's plugin, in the user's
// language, and the one formatter both sides use. `{name}` placeholders take the call's values (numbers in the
// language's own digits and separators); a key with plural forms picks one by the language's rules (CLDR, through
// `Intl.PluralRules`), from `count`. A key the table lacks reads as itself. Pure, no DOM.

/** One string, or its plural forms (lane B's locale format: `other` always). */
export type LocaleValue = string | { readonly zero?: string; readonly one?: string; readonly two?: string; readonly few?: string; readonly many?: string; readonly other: string };

/** A document's strings: the user's language, each key's string, and the language of any that fell back to another
 *  (`pt-BR` to `pt`, then English, then any language its plugin has), whose plural rules it follows. */
export interface StringTable {
  readonly lang: string;
  readonly strings: Readonly<Record<string, LocaleValue>>;
  readonly fallback?: Readonly<Record<string, string>>;
}

export const EMPTY_STRINGS: StringTable = { lang: "en", strings: {} };

const plurals = new Map<string, Intl.PluralRules>();
const numbers = new Map<string, Intl.NumberFormat>();

function rules(lang: string): Intl.PluralRules {
  let r = plurals.get(lang);
  if (r === undefined) {
    try {
      r = new Intl.PluralRules(lang);
    } catch {
      r = new Intl.PluralRules("en");
    }
    plurals.set(lang, r);
  }
  return r;
}

function numberFormat(lang: string): Intl.NumberFormat {
  let f = numbers.get(lang);
  if (f === undefined) {
    try {
      f = new Intl.NumberFormat(lang);
    } catch {
      f = new Intl.NumberFormat("en");
    }
    numbers.set(lang, f);
  }
  return f;
}

/** A value with its placeholders filled; a plural value's form chosen by `count` under `lang`'s rules. */
export function formatString(value: LocaleValue, lang: string, params?: Readonly<Record<string, string | number>>): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    const count = params?.count;
    const n = typeof count === "number" ? count : typeof count === "string" ? Number(count) : Number.NaN;
    const form = Number.isFinite(n) ? rules(lang).select(n) : "other";
    text = value[form] ?? value.other;
  }
  if (params === undefined) return text;
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const v = params[name];
    if (v === undefined) return whole;
    return typeof v === "number" ? numberFormat(lang).format(v) : v;
  });
}

/** A key from a table, formatted; the key itself when the table lacks it. */
export function translate(table: StringTable, key: string, params?: Readonly<Record<string, string | number>>): string {
  const value = table.strings[key];
  if (value === undefined) return params === undefined ? key : formatString(key, table.lang, params);
  return formatString(value, table.fallback?.[key] ?? table.lang, params);
}
