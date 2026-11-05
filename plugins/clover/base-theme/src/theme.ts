// Theme format 1 (spec §5.9): read, check, resolve for an appearance, stack, and turn into CSS custom
// properties. The app's theme engine (lane E) owns the real stack; this is the small stand-in the
// parts we ship use for their tests and their gallery, written against the spec's format:
//
//   { theme: 1, name, appearance?: "light" | "dark" | "both", tokens: {…}, dark?: { tokens },
//     css?: Path, fonts?: [{ family, src: Path }], icons?: { <name>: Path } }
//
// Assumed until lane B pins the format: `tokens` is a flat map from a dotted token name to a value
// (a string, or a number for weights and unitless numbers); `dark.tokens` overrides `tokens` in the
// dark appearance, and a token it leaves out keeps its `tokens` value.
//
// Every value goes into a CSS custom property, so every value — a catalog token's or a plugin's own —
// is held to lane B's rule first: nothing that could break out of the property (`unsafeValue`).

import { isHexColor } from "./contrast";
import { cssProperty, isPluginTokenName, isTokenName, PLUGIN_TOKEN_GROUP, PLUGIN_TOKEN_NAME_RE, tokenSpec, type TokenType } from "./catalog";

export type Text = string | ({ en: string } & Record<string, string>);
export type TokenValue = string | number;
export type Tokens = Readonly<Record<string, TokenValue>>;
export type Appearance = "light" | "dark";

export interface ThemeFile {
  theme: 1;
  name: Text;
  appearance?: "light" | "dark" | "both";
  tokens: Record<string, TokenValue>;
  dark?: { tokens: Record<string, TokenValue> };
  css?: string;
  fonts?: { family: string; src: string }[];
  icons?: Record<string, string>;
}

const THEME_KEYS = new Set(["theme", "name", "appearance", "tokens", "dark", "css", "fonts", "icons"]);

/** A path inside a plugin folder: relative, no `..` segment, no scheme, no backslash. */
export function isPluginPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/") || path.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return path.split("/").every((segment) => segment !== ".." && segment !== "");
}

// Lane B's `isSafeTokenValue` (packages/plugin-sdk/src/catalogs/tokens.ts): a finite number, or a string of at
// most 300 characters on one line, with no `;`, braces, angle brackets, `@`, backslash, comment, open quote or
// `!important`, and no `url(`, `src(`, `image(`, `image-set`, `cross-fade`, `element(` or `expression(`.
const UNSAFE = /[;{}\\@<>\n\r\f\0]|\/\*|url\s*\(|src\s*\(|expression\s*\(|image-set|image\s*\(|element\s*\(|cross-fade|!\s*important/i;
const MAX_VALUE = 300;

/** Why a value could never sit in a CSS custom property, or null when it can. */
export function unsafeValue(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : "is not a finite number";
  if (typeof value !== "string") return "is neither a string nor a number";
  if (value.length > MAX_VALUE) return `is longer than ${MAX_VALUE} characters`;
  if (UNSAFE.test(value)) return "holds what a token may not (a line break, ;, braces, @, <, >, a backslash, a comment, !important, url(, src(, image(, image-set, cross-fade, element(, expression()";
  // A quote left open would run on past the value.
  if ((value.match(/"/g)?.length ?? 0) % 2 !== 0 || (value.match(/'/g)?.length ?? 0) % 2 !== 0) return "leaves a quote open";
  return null;
}

const DIMENSION = /^(0|-?\d+(\.\d+)?px)$/;
const DURATION = /^\d+(\.\d+)?ms$/;
const EASING = /^(linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\(\s*-?[\d.]+(\s*,\s*-?[\d.]+){3}\s*\)|linear\([\d.,%\s-]+\))$/;
const GRADIENT = /^(repeating-)?(linear|radial|conic)-gradient\([#\w\s.,%()-]+\)$/;

/** What is wrong with `value` as a token of `type` (empty when nothing is). */
export function checkValue(type: TokenType, value: TokenValue): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "is not a finite number";
    if (type === "fontWeight") return value >= 100 && value <= 1000 ? null : "is not a font weight (100–1000)";
    if (type === "number") return null;
    return `is a number; a ${type} is a string`;
  }
  const unsafe = unsafeValue(value);
  if (unsafe) return unsafe;
  switch (type) {
    case "color":
      return isHexColor(value) ? null : "is not a #RGB, #RRGGBB or #RRGGBBAA colour";
    case "dimension":
      return DIMENSION.test(value) ? null : "is not a length in px";
    case "duration":
      return DURATION.test(value) ? null : "is not a duration in ms";
    case "easing":
      return EASING.test(value) ? null : "is not an easing";
    case "paint":
      return isHexColor(value) || GRADIENT.test(value) ? null : "is not a colour or a gradient";
    case "fontFamily":
      return value.trim().length > 0 ? null : "is empty";
    case "shadow":
      return value.trim().length > 0 ? null : "is empty";
    case "fontWeight":
    case "number":
      return `is a string; a ${type} is a number`;
  }
}

export interface CheckThemeOptions {
  /** Refuse tokens the catalog does not list: how the themes we ship are held to it. */
  strict?: boolean;
  /** The theme's plugin's top-level id: its own tokens are `plugin.<id>.<name>` (lane B's `isPluginTokenName`).
   *  Without it, a non-strict check takes any plugin's own token name. */
  plugin?: string;
}

/** A plugin's own token when the plugin is not known: `plugin.<id>.<name>`. */
function isAnyPluginToken(name: string): boolean {
  return name.length <= 128 && PLUGIN_TOKEN_NAME_RE.test(name);
}

function checkTokens(where: string, tokens: unknown, problems: string[], options: CheckThemeOptions): void {
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
    problems.push(`${where} is not an object`);
    return;
  }
  for (const [name, value] of Object.entries(tokens)) {
    const spec = tokenSpec(name);
    const own = !spec && (options.plugin !== undefined ? isPluginTokenName(name, options.plugin) : isAnyPluginToken(name));
    // The `plugin` group holds plugins' own tokens only; anything else must read as a catalog name.
    const reserved = name === PLUGIN_TOKEN_GROUP || name.startsWith(`${PLUGIN_TOKEN_GROUP}.`);
    if (!spec && !own && (reserved || !isTokenName(name))) {
      problems.push(`${where}: "${name}" is not a token name`);
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      problems.push(`${where}: ${name} is neither a string nor a number`);
      continue;
    }
    if (spec) {
      const wrong = checkValue(spec.type, value);
      if (wrong) problems.push(`${where}: ${name} = ${JSON.stringify(value)} ${wrong}`);
      continue;
    }
    // Strict: the catalog's tokens, and the plugin's own when it is named.
    if (options.strict && !(own && options.plugin !== undefined)) problems.push(`${where}: ${name} is not in the token catalog`);
    // A token the catalog does not type is still a CSS value: held to what any value may hold.
    const unsafe = unsafeValue(value);
    if (unsafe) problems.push(`${where}: ${name} = ${JSON.stringify(value)} ${unsafe}`);
  }
}

/**
 * Every problem with a theme file, as plain sentences (empty when there is none). `strict` also refuses
 * tokens the catalog does not list, which is how the themes we ship are held to it.
 */
export function checkTheme(json: unknown, options: CheckThemeOptions = {}): string[] {
  const problems: string[] = [];
  if (typeof json !== "object" || json === null || Array.isArray(json)) return ["the theme is not an object"];
  const theme = json as Record<string, unknown>;
  for (const key of Object.keys(theme)) if (!THEME_KEYS.has(key)) problems.push(`unknown key "${key}"`);
  if (theme.theme !== 1) problems.push(`"theme" must be 1 (this app reads format 1)`);
  const name = theme.name;
  const nameOk =
    (typeof name === "string" && name.trim().length > 0) ||
    (typeof name === "object" && name !== null && typeof (name as { en?: unknown }).en === "string");
  if (!nameOk) problems.push(`"name" must be a string or { en, … }`);
  if (theme.appearance !== undefined && !["light", "dark", "both"].includes(theme.appearance as string)) {
    problems.push(`"appearance" must be light, dark or both`);
  }
  checkTokens("tokens", theme.tokens, problems, options);
  if (theme.dark !== undefined) {
    const dark = theme.dark as { tokens?: unknown } | null;
    if (typeof dark !== "object" || dark === null) problems.push(`"dark" must be { tokens }`);
    else checkTokens("dark.tokens", dark.tokens, problems, options);
  }
  if (theme.css !== undefined && !isPluginPath(theme.css)) problems.push(`"css" must be a path inside the plugin`);
  if (theme.fonts !== undefined) {
    if (!Array.isArray(theme.fonts)) problems.push(`"fonts" must be a list`);
    else
      for (const font of theme.fonts as { family?: unknown; src?: unknown }[]) {
        if (typeof font?.family !== "string" || !isPluginPath(font?.src)) problems.push(`a font needs a family and a src inside the plugin`);
      }
  }
  if (theme.icons !== undefined) {
    if (typeof theme.icons !== "object" || theme.icons === null) problems.push(`"icons" must be an object`);
    else for (const [icon, path] of Object.entries(theme.icons)) if (!isPluginPath(path)) problems.push(`icon ${icon} is not a path inside the plugin`);
  }
  return problems;
}

/** Throws with every problem at once; returns the theme typed. */
export function readTheme(json: unknown, options: CheckThemeOptions = {}): ThemeFile {
  const problems = checkTheme(json, options);
  if (problems.length > 0) throw new Error(`invalid theme:\n  ${problems.join("\n  ")}`);
  return json as ThemeFile;
}

/** The tokens a theme gives in one appearance: none in an appearance it does not name (lane B: a light-only theme
 *  does nothing in dark), and in dark its `dark.tokens` over its `tokens`. */
export function tokensFor(theme: ThemeFile, appearance: Appearance): Tokens {
  const names = theme.appearance ?? "both";
  if (names !== "both" && names !== appearance) return {};
  return appearance === "dark" ? { ...theme.tokens, ...(theme.dark?.tokens ?? {}) } : { ...theme.tokens };
}

/** Layers, lowest first (spec §5.5's stack): a later layer's token wins. */
export function stack(...layers: readonly Tokens[]): Tokens {
  return Object.assign({}, ...layers) as Tokens;
}

/** The custom properties for a set of tokens, as a style object (`{ "--clover-color-text": "#1C1B22" }`). A value that
 *  could break out of its property throws, whatever checked it before. */
export function cssVariables(tokens: Tokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(tokens)) {
    const unsafe = unsafeValue(value);
    if (unsafe) throw new Error(`token ${name} ${unsafe}`);
    out[cssProperty(name)] = String(value);
  }
  return out;
}

/** The same as one CSS rule, for a stylesheet. */
export function cssRule(selector: string, tokens: Tokens): string {
  const lines = Object.entries(cssVariables(tokens)).map(([property, value]) => `  ${property}: ${value};`);
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}
