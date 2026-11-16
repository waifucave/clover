// That a stylesheet reads only catalog tokens, each with the catalog's own value as its fallback (the value the
// core resolves with no theme and no OS reading: an accent that follows the OS is the catalog's, an ink on it worked
// out against it), so a part looks right before the theme arrives and nothing names a token the catalog doesn't have.
import { cssProperty, TOKENS } from "../../catalogs/tokens";
import { resolveTokens, type Appearance } from "../../formats/theme";

const USE = /var\((--[a-z0-9-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*?))?\)/g;
const normalise = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

export interface TokenFallbackOptions {
  /** Custom properties the stylesheet sets for itself, not tokens. */
  local?: Iterable<string>;
  /** The appearance whose catalog values the fallbacks hold (light, the default). */
  appearance?: Appearance;
  /** A plugin's own `plugin.<id>.…` tokens are not the catalog's: accepted with any fallback. */
  pluginTokens?: boolean;
}

/** Each `var()` the CSS reads, as `[property, fallback]` (the fallback undefined when there is none). */
export function tokenUses(css: string): [string, string | undefined][] {
  return [...css.matchAll(USE)].map((m) => [m[1]!, m[2]]);
}

/** The catalog's values as the core resolves them with no theme layer: what a fallback holds. */
export function catalogValues(appearance: Appearance = "light"): Record<string, string | number> {
  return resolveTokens(appearance, []);
}

/** Every way the CSS breaks the rule: a property that is no catalog token, one with no fallback, one whose fallback is
 *  not the catalog's value. Empty when it keeps it. */
export function tokenFallbackProblems(css: string, options: TokenFallbackOptions = {}): string[] {
  const byProperty = new Map(TOKENS.map((t) => [cssProperty(t.name), t.name]));
  const local = new Set(options.local ?? []);
  const values = catalogValues(options.appearance ?? "light");
  const out: string[] = [];
  for (const [property, fallback] of tokenUses(css)) {
    if (local.has(property)) continue;
    if (options.pluginTokens === true && property.startsWith("--moss-plugin-")) continue;
    const token = byProperty.get(property);
    if (token === undefined) out.push(`${property} is not a catalog token`);
    else if (fallback === undefined) out.push(`${property} has no fallback`);
    else if (normalise(fallback) !== normalise(String(values[token]))) out.push(`${property}: ${fallback}, the catalog's is ${String(values[token])}`);
  }
  return out;
}
