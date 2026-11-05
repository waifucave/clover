// The theme stack for the gallery's frames, standing in for the app's theme engine (lane E): tokens become
// custom properties on a frame's root, and each theme's CSS is scoped to it with `@scope`, as the engine
// scopes a theme to the part it dresses (spec §5.5).

import baseThemeJson from "../../theme.json" with { type: "json" };
import baseThemeCss from "../../theme.css" with { type: "text" };
import { cssVariables, readTheme, stack, tokensFor, type Appearance, type ThemeFile, type Tokens } from "../../src/theme";

export const BASE: ThemeFile = readTheme(baseThemeJson, { strict: true });

export interface ThemeLayer {
  id: string;
  theme: ThemeFile;
  css: string;
}

export const BASE_LAYER: ThemeLayer = { id: "clover", theme: BASE, css: baseThemeCss };

/** The tokens for a stack of themes, lowest first. */
export function stackTokens(layers: readonly ThemeLayer[], appearance: Appearance): Tokens {
  return stack(...layers.map((layer) => tokensFor(layer.theme, appearance)));
}

export function themeStyle(layers: readonly ThemeLayer[], appearance: Appearance): Record<string, string> {
  return { ...cssVariables(stackTokens(layers, appearance)), colorScheme: appearance };
}

/** One stylesheet holding every layer's CSS, scoped to the frames that stack it. */
export function scopedCss(rootAttr: string, stacks: Record<string, readonly ThemeLayer[]>): string {
  const out: string[] = [];
  for (const [name, layers] of Object.entries(stacks)) {
    for (const layer of layers) out.push(`@scope ([${rootAttr}="${name}"]) {\n${layer.css}\n}`);
  }
  return out.join("\n");
}
