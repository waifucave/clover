// Translations (spec §5.5): each document's table in the user's language with its fallbacks, a plugin's own table over
// a pack's, the user's pick between packs, a bot translating only its own keys, the sealed cards' strings from trusted
// tables only, and the formatter's placeholders and plural forms.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatString, translate, type LocaleValue } from "@waifucave/clover-plugin-sdk/ui/bridge";
import { layerOf, readUiPlugins, type UiPlugin } from "../src/main/ui/model";
import { StringStore, normalizeLang, stringTable, textIn } from "../src/main/ui/strings";

let n = 0;
function plugin(id: string, tables: Record<string, Record<string, LocaleValue>>, extra: Record<string, unknown> = {}): UiPlugin {
  const dir = mkdtempSync(join(tmpdir(), "clover-strings-"));
  const locales = Object.entries(tables).map(([lang, strings]) => {
    writeFileSync(join(dir, `${lang}.json`), JSON.stringify({ locale: 1, lang, strings }));
    return { lang, file: `${lang}.json` };
  });
  return readUiPlugins([{ pluginId: id, name: id, treeHash: `sha256:${String(++n).padStart(64, "0")}`, layer: layerOf(id), assetBase: dir, ui: [], themes: [], locales, bots: "all", ...extra }] as never, { [id]: { enabledAt: n, ...(extra.isBot === true ? { isBot: true } : {}) } })[0]!;
}

const builtIn = { en: { "clover.core.hello": "Hello", "clover.card.approve": "Approve" } };
const table = (plugins: UiPlugin[], lang: string, owner: string, more: Partial<Parameters<typeof stringTable>[1]> = {}) => stringTable(new StringStore(), { plugins, lang, builtIn, ...more }, owner);

describe("a document's table", () => {
  test("a missing string falls back from the regional language to its base, to English, then to any language its plugin has", () => {
    const luna = plugin("luna", {
      "pt-BR": { "luna.a": "a-br" },
      pt: { "luna.a": "a-pt", "luna.b": "b-pt" },
      en: { "luna.a": "a-en", "luna.b": "b-en", "luna.c": "c-en" },
      ja: { "luna.d": "d-ja" },
    });
    const t = table([luna], "pt-BR", "luna");
    expect(t.strings).toEqual({ "luna.a": "a-br", "luna.b": "b-pt", "luna.c": "c-en", "luna.d": "d-ja" });
    expect(t.fallback).toEqual({ "luna.b": "pt", "luna.c": "en", "luna.d": "ja" });
    // Only the document's own plugin's keys.
    expect(table([luna], "en", "vega").strings).toEqual({});
  });

  test("a plugin's own table beats a pack's in a language; a pack in the user's language beats the plugin's English", () => {
    const luna = plugin("luna", { en: { "luna.a": "own-en", "luna.b": "own-en-b" }, fr: { "luna.a": "own-fr" } });
    const pack = plugin("french-pack", { fr: { "luna.a": "pack-fr", "luna.b": "pack-fr-b", "clover.core.hello": "Bonjour" } });
    const t = table([luna, pack], "fr", "luna");
    expect(t.strings).toEqual({ "luna.a": "own-fr", "luna.b": "pack-fr-b" });
    // A pack translates the core too.
    expect(table([luna, pack], "fr", "clover").strings["clover.core.hello"]).toBe("Bonjour");
  });

  test("between two packs, the user's pick for the language, else the first enabled", () => {
    const first = plugin("pack-one", { de: { "clover.core.hello": "Hallo (1)" } });
    const second = plugin("pack-two", { de: { "clover.core.hello": "Hallo (2)" } });
    expect(table([second, first], "de", "clover").strings["clover.core.hello"]).toBe("Hallo (1)");
    expect(table([first, second], "de", "clover", { packs: { de: "pack-two" } }).strings["clover.core.hello"]).toBe("Hallo (2)");
  });

  test("a bot's plugin translates only its own keys; a child in its folder can be the pack", () => {
    const bot = plugin("luna", { es: { "luna.hi": "hola", "clover.core.hello": "Hola (bot)" } }, { isBot: true });
    const child = plugin("luna/pack", { es: { "clover.core.hello": "Hola (child)" } });
    expect(table([bot], "es", "clover").strings["clover.core.hello"]).toBe("Hello");
    expect(table([bot], "es", "luna").strings["luna.hi"]).toBe("hola");
    expect(table([bot, child], "es", "clover").strings["clover.core.hello"]).toBe("Hola (child)");
  });

  test("sealed cards' strings come only from the built-in tables, the clover tree's and official packs; else English", () => {
    const pack = plugin("sneaky-pack", { it: { "clover.card.approve": "Nega", "clover.core.hello": "Ciao" } });
    const t = table([pack], "it", "clover");
    expect(t.strings["clover.card.approve"]).toBe("Approve");
    expect(t.strings["clover.core.hello"]).toBe("Ciao");
    expect(table([pack], "it", "clover", { official: (p) => p.id === "sneaky-pack" }).strings["clover.card.approve"]).toBe("Nega");
    const clover = plugin("clover/locales-it", { it: { "clover.card.approve": "Approva" } });
    expect(table([pack, clover], "it", "clover").strings["clover.card.approve"]).toBe("Approva");
  });

  test("a broken locale file is skipped", () => {
    const luna = plugin("luna", { en: { "luna.a": "a" } });
    writeFileSync(join(luna.assetBase, "en.json"), "{ not json");
    const lines: string[] = [];
    expect(stringTable(new StringStore((l) => lines.push(l)), { plugins: [luna], lang: "en", builtIn }, "luna").strings).toEqual({});
    expect(lines[0]).toContain("could not be read");
  });
});

describe("the formatter", () => {
  test("placeholders take the call's values, numbers in the language's own form", () => {
    expect(formatString("{who} has {n} files", "en", { who: "Luna", n: 1234 })).toBe("Luna has 1,234 files");
    expect(formatString("{n} Dateien", "de", { n: 1234.5 })).toBe("1.234,5 Dateien");
    expect(formatString("{missing} stays", "en", {})).toBe("{missing} stays");
  });

  test("plural forms by the language's rules, from count", () => {
    const files = { one: "{count} file", other: "{count} files" };
    expect(formatString(files, "en", { count: 1 })).toBe("1 file");
    expect(formatString(files, "en", { count: 2 })).toBe("2 files");
    const ru = { one: "{count} файл", few: "{count} файла", many: "{count} файлов", other: "{count} файла" };
    expect(formatString(ru, "ru", { count: 3 })).toBe("3 файла");
    expect(formatString(ru, "ru", { count: 5 })).toBe("5 файлов");
    expect(formatString(ru, "ru", { count: 21 })).toBe("21 файл");
    // No count: the `other` form.
    expect(formatString(files, "en")).toBe("{count} files");
  });

  test("a string that fell back follows its own language's plural rules; a missing key reads as itself", () => {
    const t = { lang: "ja", strings: { "luna.n": { one: "{count} item", other: "{count} items" } }, fallback: { "luna.n": "en" } } as const;
    expect(translate(t, "luna.n", { count: 1 })).toBe("1 item");
    expect(translate(t, "luna.unknown")).toBe("luna.unknown");
  });

  test("a manifest Text in a language, falling back like a table", () => {
    expect(textIn({ en: "Hello", "pt-BR": "Olá" }, "pt-BR")).toBe("Olá");
    expect(textIn({ en: "Hello", pt: "Olá" }, "pt-PT")).toBe("Olá");
    expect(textIn({ en: "Hello" }, "fr")).toBe("Hello");
    expect(textIn("Plain", "fr")).toBe("Plain");
    expect(normalizeLang("PT_br")).toBe("pt-br");
  });
});
