// The words of lane F's parts (spec §5.5 "Translations"): every user-visible string is a `clover.<part>.` key, its
// English in the part's `locales/en.json` (which its manifest declares, so the app has it and a language pack can
// translate every key). A part's `S` reads each key through `translator(en)`: the app's translator first, the table
// the core resolved for the `clover` layer in the user's language (lane E's `useT()`, installed by the shell with
// `setTranslator`), then the part's own English. `{name}` placeholders take the call's values, and a key with plural
// forms picks one by `count` under the language's rules.

/** A string, or its plural forms (locale format 1: `other` always). */
export type LocaleValue = string | { readonly zero?: string; readonly one?: string; readonly two?: string; readonly few?: string; readonly many?: string; readonly other: string };

/** The app's translator for `clover.` keys; a key it has no string for reads as itself. */
export type Translator = (key: string, params?: Record<string, string | number>) => string;

let installed: Translator | null = null;

/** Installs the app's translator (null: the parts' own English). The shell installs lane E's `useT()`. */
export function setTranslator(t: Translator | null): void {
  installed = t;
}

const englishPlurals = new Intl.PluralRules("en");
const englishNumbers = new Intl.NumberFormat("en");

/** A value with its placeholders filled; a plural value's form chosen by `count` (English rules). */
export function formatEnglish(value: LocaleValue, params?: Record<string, string | number>): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    const n = typeof params?.count === "number" ? params.count : Number(params?.count);
    text = value[Number.isFinite(n) ? (englishPlurals.select(n) as keyof typeof value) : "other"] ?? value.other;
  }
  if (!params) return text;
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : typeof v === "number" ? englishNumbers.format(v) : v;
  });
}

/** A part's `t`: the app's string for a key when it has one, else the part's English. */
export function translator(en: Readonly<Record<string, LocaleValue>>): Translator {
  return (key, params) => {
    if (installed) {
      const text = installed(key, params);
      if (text !== key) return text;
    }
    const value = en[key];
    return value === undefined ? key : formatEnglish(value, params);
  };
}
