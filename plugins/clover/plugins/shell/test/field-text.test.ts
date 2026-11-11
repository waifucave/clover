// A spot entry's title, as the shell's own places show it (the sidebar's app rows, the title bar, Settings' sections):
// `fieldText` is their one door, and it hands back what the SDK's plain-text cleaner leaves.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FIELD_TEXT_MAX, fieldText } from "../runtime/views";

describe("fieldText", () => {
  test("a string or words by language, cleaned to one plain line, bounded; anything else is no title", () => {
    expect(fieldText("Notes")).toBe("Notes");
    expect(fieldText({ en: "Notes", ja: "ノート" }, "ja")).toBe("ノート");
    expect(fieldText({ en: "Notes", ja: "ノート" }, "fr")).toBe("Notes");
    // Bidi overrides, zero-width characters, line breaks and controls never reach the shell.
    expect(fieldText("Not\u202eseton\u200b\nApp\u0007")).toBe("Notseton App");
    expect(fieldText({ en: "  Sp\u2066ot  \u2028" })).toBe("Spot");
    expect(fieldText("x".repeat(500))?.length).toBe(FIELD_TEXT_MAX);
    for (const v of [undefined, null, 5, ["Notes"], { ja: "ノート" }, "\u202e\u200b", { en: 3 }]) expect([v, fieldText(v)]).toEqual([v, undefined]);
  });

  test("no client of the clover tree reads a spot entry's title but through fieldText", () => {
    const root = join(import.meta.dir, "..", "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "test" || name === "gallery") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && /fields\??\.title\b/.test(readFileSync(p, "utf8").replace(/fieldText\(\w+\??\.fields\??\.title\)/g, ""))) hits.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
