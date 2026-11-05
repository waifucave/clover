// The theme stack for the gallery's frames, standing in for the app's theme engine (lane E): tokens become
// custom properties on a frame's root, and each theme's CSS is scoped to it with `@scope`, as the engine
// scopes a theme to the part it dresses (spec §5.5).

import baseThemeJson from "../../theme.json" with { type: "json" };
import baseThemeCss from "../../theme.css" with { type: "text" };
import { cssVariables, readTheme, resolveTokens, tokensFor, type Appearance, type ThemeFile, type Tokens } from "../../src/theme";

export const BASE: ThemeFile = readTheme(baseThemeJson, { strict: true });

export interface ThemeLayer {
  id: string;
  theme: ThemeFile;
  css: string;
  /** Where the theme's plugin folder is served, so its CSS's url()s find its files (the engine's job in the app). */
  base?: string;
}

/** A theme's plugin-relative url()s, pointed at where its folder is served. */
export function rebase(css: string, base: string | undefined): string {
  if (!base) return css;
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, quote: string, path: string) =>
    /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(path) ? whole : `url(${quote || '"'}${base}${path}${quote || '"'})`,
  );
}

export const BASE_LAYER: ThemeLayer = { id: "clover", theme: BASE, css: baseThemeCss };

/** The tokens for a stack of themes, lowest first, resolved as the core resolves them with no OS accent to read (the
 *  CI machine's case): a "system" accent keeps the theme's, and "auto" inks resolve against it. */
export function stackTokens(layers: readonly ThemeLayer[], appearance: Appearance): Tokens {
  return resolveTokens(appearance, layers.map((layer) => tokensFor(layer.theme, appearance)));
}

export function themeStyle(layers: readonly ThemeLayer[], appearance: Appearance): Record<string, string> {
  return { ...cssVariables(stackTokens(layers, appearance)), colorScheme: appearance };
}

/** One stylesheet holding every layer's CSS, scoped to the frames that stack it. */
export function scopedCss(rootAttr: string, stacks: Record<string, readonly ThemeLayer[]>): string {
  const out: string[] = [];
  for (const [name, layers] of Object.entries(stacks)) {
    for (const layer of layers) out.push(`@scope ([${rootAttr}="${name}"]) {\n${rebase(layer.css, layer.base)}\n}`);
  }
  return out.join("\n");
}
