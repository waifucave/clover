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

import { isHexColor } from "./contrast";
import { cssProperty, isTokenName, tokenSpec, type TokenType } from "./catalog";

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

const FORBIDDEN_IN_VALUES = /url\(|expression\(|[;{}<>@\\]|\/\*/i;
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
  if (FORBIDDEN_IN_VALUES.test(value)) return "holds characters a token may not (url(, ;, braces, @, comments)";
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

function checkTokens(where: string, tokens: unknown, problems: string[], strict: boolean): void {
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
    problems.push(`${where} is not an object`);
    return;
  }
  for (const [name, value] of Object.entries(tokens)) {
    if (!isTokenName(name)) {
      problems.push(`${where}: "${name}" is not a token name`);
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      problems.push(`${where}: ${name} is neither a string nor a number`);
      continue;
    }
    const spec = tokenSpec(name);
    if (!spec) {
      if (strict) problems.push(`${where}: ${name} is not in the token catalog`);
      continue;
    }
    const wrong = checkValue(spec.type, value);
    if (wrong) problems.push(`${where}: ${name} = ${JSON.stringify(value)} ${wrong}`);
  }
}

/**
 * Every problem with a theme file, as plain sentences (empty when there is none). `strict` also refuses
 * tokens the catalog does not list, which is how the themes we ship are held to it.
 */
export function checkTheme(json: unknown, options: { strict?: boolean } = {}): string[] {
  const strict = options.strict ?? false;
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
  checkTokens("tokens", theme.tokens, problems, strict);
  if (theme.dark !== undefined) {
    const dark = theme.dark as { tokens?: unknown } | null;
    if (typeof dark !== "object" || dark === null) problems.push(`"dark" must be { tokens }`);
    else checkTokens("dark.tokens", dark.tokens, problems, strict);
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
export function readTheme(json: unknown, options: { strict?: boolean } = {}): ThemeFile {
  const problems = checkTheme(json, options);
  if (problems.length > 0) throw new Error(`invalid theme:\n  ${problems.join("\n  ")}`);
  return json as ThemeFile;
}

/** The tokens a theme gives in one appearance. */
export function tokensFor(theme: ThemeFile, appearance: Appearance): Tokens {
  return appearance === "dark" ? { ...theme.tokens, ...(theme.dark?.tokens ?? {}) } : { ...theme.tokens };
}

/** Layers, lowest first (spec §5.5's stack): a later layer's token wins. */
export function stack(...layers: readonly Tokens[]): Tokens {
  return Object.assign({}, ...layers) as Tokens;
}

/** The custom properties for a set of tokens, as a style object (`{ "--color-text": "#1C1B22" }`). */
export function cssVariables(tokens: Tokens): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(tokens)) out[cssProperty(name)] = String(value);
  return out;
}

/** The same as one CSS rule, for a stylesheet. */
export function cssRule(selector: string, tokens: Tokens): string {
  const lines = Object.entries(cssVariables(tokens)).map(([property, value]) => `  ${property}: ${value};`);
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}
