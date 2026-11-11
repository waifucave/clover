// Every colour pair Alpha's two themes actually paint, measured: a rule that sets `color` is checked against the
// ground it sits on (its own background, else the island it sits in, else the surface and the raised tone), in both
// appearances, 4.5:1 for text and 3:1 for large text. Computed from the theme files and their CSS, nothing listed by hand.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_THEME, readTheme, resolveTokens, tokensFor } from "../../../clover/plugins/base-theme/src/index";
import { composite, luminance, parseHex, type Rgba } from "../../../clover/plugins/base-theme/src/contrast";
import themeA from "../theme.json" with { type: "json" };

const ALPHA = join(import.meta.dir, "..", "..");
const VARIANTS = [
  { name: "meadow", theme: themeA, css: "tab/theme.css" },
] as const;

/** The custom property a token paints through (`color.text.muted` -> `--clover-color-text-muted`). */
const property = (name: string) => `--clover-${name.replace(/\./g, "-")}`;
const ratio = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** Split at top-level commas (not inside parentheses). */
function topSplit(text: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function colour(value: string, vars: Map<string, string>, ground: Rgba): Rgba | undefined {
  const v = value.trim().replace(/\s*!important$/, "");
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return parseHex(v);
  const ref = /^var\((--[a-z0-9-]+)\s*(?:,.*)?\)$/i.exec(v);
  if (ref) {
    const t = vars.get(ref[1]!);
    return t ? colour(t, vars, ground) : undefined;
  }
  const mix = /^color-mix\(in srgb,(.*)\)$/i.exec(v);
  if (mix) {
    const [a, b] = topSplit(mix[1]!);
    if (!a || !b) return undefined;
    const pa = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(a);
    const ca = colour(pa ? pa[1]! : a, vars, ground);
    const cb = colour(b, vars, ground);
    if (!ca || !cb) return undefined;
    const p = pa ? Number(pa[2]) / 100 : 0.5;
    // A transparent side contributes only its share of alpha, not a darkening of the colour.
    const aa = ca.a * p;
    const ab = cb.a * (1 - p);
    const total = aa + ab;
    if (total === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return { r: (ca.r * aa + cb.r * ab) / total, g: (ca.g * aa + cb.g * ab) / total, b: (ca.b * aa + cb.b * ab) / total, a: total };
  }
  return undefined;
}

interface Rule {
  selector: string;
  decls: Map<string, string>;
}
function rulesOf(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim();
    if (/^(from|to|\d+%)/.test(selector) || selector.includes("%,")) continue;
    const decls = new Map<string, string>();
    for (const d of topSplit(m[2]!, ";")) {
      const i = d.indexOf(":");
      if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    out.push({ selector, decls });
  }
  return out;
}

/** The colours the last (bottom) layer of a `background` paints: one, or every stop of a gradient. */
function layerColours(value: string, vars: Map<string, string>, ground: Rgba): Rgba[] {
  const layer = topSplit(value).at(-1) ?? value;
  const g = /^(?:repeating-)?linear-gradient\((.*)\)$/i.exec(layer);
  const parts = g ? topSplit(g[1]!).filter((x) => !/^(to |-?\d)/.test(x)).map((x) => x.replace(/\s+\d+(\.\d+)?(px|%)(\s+\d+(\.\d+)?(px|%))?$/, "")) : [layer];
  return parts.flatMap((x) => colour(x, vars, ground) ?? []);
}
const islandOf = (selector: string) => (selector.includes('[data-tool="write"]') ? "write" : selector.includes('[data-tool="bash"]') ? "bash" : undefined);

describe("Alpha paints legible text in both directions and both appearances", () => {
  for (const v of VARIANTS) {
    const alpha = readTheme(v.theme, { strict: true });
    const css = readFileSync(join(ALPHA, v.css), "utf8");
    const rules = rulesOf(css);
    for (const appearance of ["light", "dark"] as const) {
      const tokens = resolveTokens(appearance, [tokensFor(BASE_THEME, appearance), tokensFor(alpha, appearance)]);
      const vars = new Map(Object.entries(tokens).map(([k, val]) => [property(k), String(val)]));
      const token = (name: string) => parseHex(String(tokens[name]));
      const surface = token("color.surface");
      const grounds = [surface, token("color.raised")];

      // The islands' own grounds: the first opaque background a rule gives the card.
      const islandBg: Record<string, Rgba | undefined> = {};
      for (const kind of ["write", "bash"] as const) {
        for (const r of rules) {
          if (islandOf(r.selector) !== kind || !r.decls.has("background")) continue;
          const c = layerColours(r.decls.get("background")!, vars, surface)[0];
          if (c && c.a === 1) { islandBg[kind] = c; break; }
        }
      }

      test(`${v.name}, ${appearance}: the paper and the terminal each have a ground`, () => {
        expect(islandBg.write).toBeDefined();
        expect(islandBg.bash).toBeDefined();
      });

      let checked = 0;
      test(`${v.name}, ${appearance}: every text colour reaches 4.5:1 (3:1 large) on the ground it is drawn on`, () => {
        const failures: string[] = [];
        for (const r of rules) {
          const fgValue = r.decls.get("color");
          if (!fgValue) continue;
          const size = /^(\d+(?:\.\d+)?)px$/.exec(r.decls.get("font-size") ?? "");
          // Large text, and a decorative glyph set in a pseudo-element's `content`, need 3:1 (WCAG 1.4.11).
          const floor = (size && Number(size[1]) >= 24) || (/::(before|after)/.test(r.selector) && r.decls.has("content") && /^"[^\w"]{1,2}"$/.test(r.decls.get("content")!)) ? 3 : 4.5;
          for (const sel of topSplit(r.selector)) {
            const island = islandOf(sel);
            const base = island ? islandBg[island] : undefined;
            const ownBg = r.decls.get("background") ?? r.decls.get("background-color");
            const candidates: Rgba[] = [];
            if (base) candidates.push(base);
            else candidates.push(...grounds);
            const owns = (ownBg ? layerColours(ownBg, vars, candidates[0]!) : []).filter((c) => c.a > 0);
            const onto = owns.length > 0 ? owns.flatMap((o) => candidates.map((g) => composite(o, g))) : candidates;
            const fg = colour(fgValue, vars, onto[0]!);
            if (!fg) continue;
            for (const g of onto) {
              checked++;
              const seen = composite(fg, g);
              const got = ratio(seen, g);
              if (got < floor) failures.push(`${sel} { color: ${fgValue} } is ${got.toFixed(2)}:1 (needs ${floor})`);
            }
          }
        }
        expect(failures).toEqual([]);
        expect(checked).toBeGreaterThan(30);
      });
    }
  }
});
