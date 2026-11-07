// The island and the manifest check fold names the same way (lane B's `foldTitle`), and that fold refuses everything
// the island's own fold refused before #264 (frozen in `fixtures/old-island-fold.ts` as the oracle), except old folds
// that were too loose, each an accident of the old order:
// - Greek eta and its accented forms as "n" (it reads as an "n" only in some faces);
// - the lunate capital sigma (U+03F9) as "o" (reached through NFKC's capital sigma; it reads as "C");
// - an accented capital upsilon as "u" (reached through its small form; it reads as "Y", as the bare capital does).
// And one old entry is corrected, not dropped: o with an ogonek (U+01EB) folds as "o", where the old table said "q".
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldTitle, reservedTitles } from "@waifucave/clover-plugin-sdk";
import { isReservedPluginName, isReservedTab } from "../src/model/tabs";
import { nameSkeleton, readsAs } from "../src/model/names";
import * as old from "./fixtures/old-island-fold";

/** The old folds left out on purpose: \u03B7 and every precomposed form of it (it folds to "\u03B7" under NFKD), and \u03F9. */
/** The old folds left out on purpose (above). */
const LOOSE = (ch: string) => {
  const base = ch.normalize("NFKD").replace(/\p{M}/gu, "");
  return base.toLowerCase() === "\u03B7" || ch === "\u03F9" || (ch !== base && (base === "\u03A5" || base === "\u03D2"));
};
/** Old entries corrected: the letter now folds as the right one. */
const CORRECTED: Readonly<Record<string, string>> = { "\u01EB": "o" };

const NAMES = [
  "Needs you", "Needs\u200B you", "Needs\u200Byou", "Needsyou", "Needs-you", "N\u00ADeeds you", "\u202ENeeds you",
  "Needs y\u043Eu", "N\u0435\u0435ds you", "\u039Deeds you", "\u0274\u1D07\u1D07\u1D05\uA731 \u028F\u1D0F\u1D1C", "\u{1D40D}\u{1D41E}\u{1D41E}\u{1D41D}\u{1D42C} \u{1D432}\u{1D428}\u{1D42E}", "\uFF2E\uFF45\uFF45\uFF44\uFF53\u3000\uFF59\uFF4F\uFF55", "N\u00E9\u00E9ds yo\u00FC",
  "Needs\u3164you", "NEEDS YOU", "Needs y0u", "Needs you\uFE0F", "Needs", "Needs you now", "Feeds you", "Devices", "Usage",
  "Clover", "CLOVER", "Cl\u043Ever", "C1over", "dover", "Homelab",
];

/** The review's rows (#264): lookalikes B's first fold let through. */
const REVIEW_TITLES = ["Needs y\u0585u", "Needs y\u03C3u", "N\u0451eds you", "NEEDS Y\u13EBU", "NEEDS Y\u0555U", "NEEDS YO\u054D", "NEED\u054F YOU"];
const REVIEW_NAMES = ["CL\u13EBVER", "CL\u0555VER", "C\u0407over", "\u03C2lover", "C\u13A5over"];

describe("the island's names agree with the manifest check's", () => {
  test("the island's skeleton is foldTitle", () => {
    for (const name of NAMES) expect(nameSkeleton(name)).toBe(foldTitle(name));
    expect(readsAs("Luna", "Lu\u200Bna")).toBe(foldTitle("Luna") === foldTitle("Lu\u200Bna"));
  });

  test("a title the manifest reserves is one the island refuses, and only those", () => {
    const reserved = reservedTitles();
    for (const title of [...NAMES, ...REVIEW_TITLES]) expect([title, isReservedTab({ id: "x", title })]).toEqual([title, reserved.has(foldTitle(title))]);
  });

  test("the review's rows are all refused", () => {
    for (const title of REVIEW_TITLES) expect([title, isReservedTab({ id: "x", title })]).toEqual([title, true]);
    for (const name of REVIEW_NAMES) expect([name, isReservedPluginName(name)]).toEqual([name, true]);
  });
});

describe("foldTitle refuses everything the island's old fold refused", () => {
  test("every entry of the old tables folds as its Latin letter, inside a word", () => {
    const src = readFileSync(join(import.meta.dir, "fixtures", "old-island-fold.ts"), "utf8");
    const tables = src
      .slice(src.indexOf("const CAPITALS"), src.indexOf("/** Pairs a UI font draws as one letter. */"))
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*\*|\*)/.test(line))
      .join("\n");
    const entries = [...tables.matchAll(/(?:^|[ {,])(?:"([^"]+)"|([^\s":,{}]+)): "([^"]+)"/gmu)].map((m) => [m[1] ?? m[2], m[3]] as [string, string]);
    expect(entries.length).toBeGreaterThan(140);
    const missed = entries
      .map(([k, v]) => [k, CORRECTED[k] ?? v] as const)
      .filter(([k, v]) => !LOOSE(k) && foldTitle(`x${k}x`) !== foldTitle(`x${v}x`))
      .map(([k, v]) => `${k} (U+${k.codePointAt(0)!.toString(16)}) as ${v}`);
    expect(missed).toEqual([]);
  });

  test("no single-letter swap of \"Needs you\" or \"Clover\" the old fold refused passes, nor an invisible character it ignored", () => {
    const letters: string[] = [];
    for (let c = 0x21; c < 0x30000; c++) if (c < 0xd800 || c > 0xdfff) letters.push(String.fromCodePoint(c));
    const passed: string[] = [];
    for (const base of ["Needs you", "Clover"]) {
      const target = foldTitle(base);
      for (let i = 0; i < base.length; i++) {
        if (base[i] === " ") continue;
        for (const ch of letters) {
          if (LOOSE(ch)) continue;
          const t = base.slice(0, i) + ch + base.slice(i + 1);
          if (old.readsAs(t, base) && foldTitle(t) !== target) passed.push(`U+${ch.codePointAt(0)!.toString(16)} for "${base[i]}" in ${base}`);
        }
      }
    }
    const target = foldTitle("Needs you");
    for (let c = 0x20; c < 0x30000; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      const ch = String.fromCodePoint(c);
      for (const t of [`Needs${ch}you`, `Ne${ch}eds you`, `Needs you${ch}`]) {
        if (old.readsAs(t, "Needs you") && foldTitle(t) !== target) {
          passed.push(`U+${c.toString(16)} inserted in ${JSON.stringify(t)}`);
          break;
        }
      }
    }
    expect(passed).toEqual([]);
  }, 60_000);
});

describe("the island's client bundle", () => {
  test("imports the fold from the SDK's dependency-free subpath, never its root (which brings zod and the catalogs)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "model", "names.ts"), "utf8");
    expect(src).toContain('from "@waifucave/clover-plugin-sdk/fold"');
    for (const dir of ["src", "client"]) {
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : /\.tsx?$/.test(n) ? [join(d, n)] : []));
      for (const file of walk(join(import.meta.dir, "..", dir))) expect([file, /from "@waifucave\/clover-plugin-sdk"/.test(readFileSync(file, "utf8"))]).toEqual([file, false]);
    }
  });
});
