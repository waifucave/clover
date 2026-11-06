// The plugin's words as a translation pack sees them (spec §5.5 "Translations"): the English table is a valid locale
// file the manifest declares, every key the code asks for is in it, and an installed translator wins over English
// except for a key it lacks.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LocaleSchema, placeholdersOf } from "../../../../../packages/plugin-sdk/src/formats/locale";
import { EN, english, setTranslator, t } from "../src/strings";
import en from "../locales/en.json" with { type: "json" };
import manifest from "../clover.json" with { type: "json" };

const root = join(import.meta.dir, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "test") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

afterEach(() => setTranslator(null));

describe("the plugin's words", () => {
  test("locales/en.json is locale format 1, English, and the manifest declares it", () => {
    expect(LocaleSchema.safeParse(en).success).toBe(true);
    expect(en.lang).toBe("en");
    expect((manifest.contributes as { locales?: unknown }).locales).toEqual([{ lang: "en", file: "locales/en.json" }]);
    for (const key of Object.keys(EN)) expect(key.startsWith("clover.")).toBe(true);
  });

  test("every key the code asks for by name is in the English table, and plural forms keep their placeholders", () => {
    const missing: string[] = [];
    for (const file of sources(root)) {
      for (const [, key] of readFileSync(file, "utf8").matchAll(/\bt\(\s*"(clover\.[A-Za-z0-9_.-]+)"/g)) if (!(key! in EN)) missing.push(`${file.slice(root.length + 1)}: ${key}`);
    }
    expect(missing).toEqual([]);
    for (const value of Object.values(EN)) {
      if (typeof value === "string") continue;
      const other = placeholdersOf(value.other).sort();
      for (const form of Object.values(value)) for (const name of placeholdersOf(form!)) expect(other.includes(name) || name === "count").toBe(true);
    }
  });

  test("an installed translator's words win; a key it lacks reads in English; none installed, English", () => {
    const key = Object.keys(EN)[0]!;
    setTranslator((k) => (k === key ? "«traduit»" : k));
    expect(t(key)).toBe("«traduit»");
    const other = Object.keys(EN)[1]!;
    expect(t(other, { name: "Alpha", count: 2 })).toBe(english(other, { name: "Alpha", count: 2 }));
    setTranslator(null);
    expect(t(key)).toBe(english(key));
    expect(t("clover.no.such.key")).toBe("clover.no.such.key");
  });

  test("numbers and dates take the user's language; English keeps the forms the plugin was drawn with", async () => {
    const { compactCount, formatCost } = await import("../src/model/usage");
    const { setLanguage } = await import("../src/strings");
    try {
      setLanguage("de");
      expect(formatCost(1234.4)).toBe(new Intl.NumberFormat("de", { style: "currency", currency: "USD", maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(1234));
      expect(formatCost(12.3)).toContain("12,30");
      expect(formatCost(0.004).startsWith("<")).toBe(true);
      setLanguage("ja");
      expect(compactCount(34_567)).toBe(new Intl.NumberFormat("ja", { notation: "compact", maximumFractionDigits: 1, roundingMode: "trunc" }).format(34_567));
      setLanguage(undefined);
      expect([compactCount(1234), formatCost(12.3), formatCost(1234.4)]).toEqual(["1.2k", "$12.30", "$1,234"]);
    } finally {
      setLanguage(undefined);
    }
  });
});
