// Each part's tokens (spec §5.5, decision 77: "each frame themed by its tab"). E-M1 resolves the stack's data layers
// that already exist — the catalog's defaults, the base theme (`clover`'s, or the user's pick), the user's global
// theme, the bot's theme in its tab, the style-only entries that dress the part, and the user's overrides — with the
// OS accent and appearance, through lane B's `resolveTokens`. E-M2 adds the CSS half: each theme's CSS, cleaned
// (`css.ts`), its fonts and icons, as one sheet per place it dresses (`themeSheet`). The frame's variables
// (`frame.*`) come from the window, never a theme. Pure apart from reading theme files.
import { readFileSync } from "node:fs";
import { TOKENS, ThemeSchema, resolveTokens, type Appearance, type Theme, type TokenLayer, type TokenValue } from "@waifucave/clover-plugin-sdk";
import type { UiPlugin } from "./model";
import { pluginFile } from "./files";
import { cleanCss, namePrefix, renameFontValue } from "./css";

/** The tokens whose values are font families: a theme's own fonts rename them. */
const FONT_TOKENS = new Set(TOKENS.filter((t) => t.type === "fontFamily").map((t) => t.name));

/** The core's URL for a file of a plugin's, as every layer serves it (`/_t/<plugin id>/<path>`: images and fonts). */
export function themeAssetUrl(pluginId: string, path: string): string {
  return `/_t/${encodeURIComponent(pluginId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Where a sheet applies: the part's root, and the parts inside it where it stops. */
export interface SheetScope {
  root: string;
  limit?: string;
}

/** The selector for a mount's root element in its document. */
export function partSelector(mount: string): string {
  return `[data-clover-part="${mount}"]`;
}

export interface ThemeChoices {
  baseTheme?: string;
  globalTheme?: string;
  /** The user's own overrides: tokens, and CSS the cleaner keeps to the app (it may load nothing). */
  overrides?: { tokens?: Readonly<Record<string, string | number>>; css?: string };
}

export interface FrameMetrics {
  /** The title bar's height, in px. */
  top: number;
  /** The room the window's own controls take at the title bar's start and end, in px. */
  start: number;
  end: number;
}

/** What the window's own controls take before the page measures them (macOS: the traffic lights at the start;
 *  Windows and Linux: the caption buttons at the end, 3 × 46 px). */
export function defaultFrameMetrics(platform: NodeJS.Platform, titleBarHeight = 45): FrameMetrics {
  return platform === "darwin" ? { top: titleBarHeight, start: 80, end: 0 } : { top: titleBarHeight, start: 0, end: 138 };
}

/** The frame's variables as tokens (`--clover-frame-inset-top`…). `frame.window.controls.end` is asked of lane B. */
export function frameTokens(m: FrameMetrics): Record<string, TokenValue> {
  return { "frame.inset.top": `${m.top}px`, "frame.window.controls": `${m.start}px`, "frame.window.controls.end": `${m.end}px` };
}

export class ThemeStore {
  private readonly cache = new Map<string, Theme | null>();
  private readonly sheets = new Map<string, string>();

  constructor(private readonly log: (line: string) => void = () => {}) {}

  clear(): void {
    this.cache.clear();
    this.sheets.clear();
  }

  /** A theme's tokens with its own fonts' names prefixed, as its cleaned CSS names them. */
  prepared(plugin: UiPlugin, theme: Theme): Theme {
    const fonts = new Set((theme.fonts ?? []).map((f) => f.family));
    if (fonts.size === 0) return theme;
    const rename = (tokens: Record<string, string | number>) => Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, FONT_TOKENS.has(k) && typeof v === "string" ? renameFontValue(v, plugin.id, fonts) : v]));
    return { ...theme, tokens: rename(theme.tokens), ...(theme.dark !== undefined ? { dark: { tokens: rename(theme.dark.tokens) } } : {}) };
  }

  /** A theme's sheet for one place: its fonts (`@font-face`, prefixed), its icons (`--clover-icon-<name>` on the part)
   *  and its CSS, cleaned and scoped to the place. Cached per theme, so the cleaner runs once per file. */
  themeSheet(plugin: UiPlugin, theme: Theme, scope: SheetScope): string {
    const ROOT = "\u0000root\u0000";
    const LIMIT = "\u0000limit\u0000";
    const key = `${plugin.id}\0${plugin.treeHash}\0${JSON.stringify([theme.css, theme.fonts, theme.icons])}\0${scope.limit !== undefined}`;
    let template = this.sheets.get(key);
    if (template === undefined) {
      const parts: string[] = [];
      const p = namePrefix(plugin.id);
      for (const f of theme.fonts ?? []) {
        parts.push(`@font-face{font-family:"${p}${f.family}";src:url("${themeAssetUrl(plugin.id, f.src)}");font-display:swap${f.weight !== undefined ? `;font-weight:${f.weight}` : ""}${f.style !== undefined ? `;font-style:${f.style}` : ""}}`);
      }
      const icons = Object.entries(theme.icons ?? {}).map(([name, path]) => `--clover-icon-${name.replace(/\./g, "-")}:url("${themeAssetUrl(plugin.id, path)}")`);
      if (icons.length > 0) parts.push(`@scope (${ROOT})${scope.limit !== undefined ? ` to (${LIMIT})` : ""}{:scope{${icons.join(";")}}}`);
      if (theme.css !== undefined) {
        try {
          const raw = readFileSync(pluginFile(plugin, theme.css), "utf8");
          const cleaned = cleanCss(raw, {
            pluginId: plugin.id,
            file: theme.css,
            assetUrl: (path) => themeAssetUrl(plugin.id, path),
            scope: { root: ROOT, ...(scope.limit !== undefined ? { limit: LIMIT } : {}) },
            fontFamilies: (theme.fonts ?? []).map((f) => f.family),
          });
          if (cleaned.dropped.length > 0) this.log(`theme: ${plugin.id}/${theme.css}: dropped ${[...new Set(cleaned.dropped)].slice(0, 12).join("; ")}`);
          parts.push(cleaned.css);
        } catch (err) {
          this.log(`theme: ${plugin.id}/${theme.css} could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      template = parts.join("\n");
      this.sheets.set(key, template);
    }
    return template.split(ROOT).join(scope.root).split(LIMIT).join(scope.limit ?? "");
  }

  /** A theme file of a plugin, parsed and checked; null when it is missing or invalid (logged once). */
  read(plugin: UiPlugin, file: string): Theme | null {
    const key = `${plugin.id}\0${plugin.treeHash}\0${file}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let theme: Theme | null = null;
    try {
      const path = pluginFile(plugin, file);
      const parsed = ThemeSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) theme = parsed.data;
      else this.log(`theme: ${plugin.id}/${file} is not a valid theme`);
    } catch (err) {
      this.log(`theme: ${plugin.id}/${file} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.cache.set(key, theme);
    return theme;
  }

  /** A theme by reference, `<plugin-id>#<theme-id>`. */
  byRef(plugins: readonly UiPlugin[], ref: string | undefined): Theme | null {
    if (ref === undefined) return null;
    const hash = ref.indexOf("#");
    if (hash < 0) return null;
    const plugin = plugins.find((p) => p.id === ref.slice(0, hash));
    const entry = plugin?.themes.find((t) => t.id === ref.slice(hash + 1));
    return plugin !== undefined && entry !== undefined ? this.read(plugin, entry.file) : null;
  }

  /** `clover`'s base theme: the theme `clover` in the `clover` tree. */
  cloverBase(plugins: readonly UiPlugin[]): Theme | null {
    for (const p of plugins) {
      if (p.topId !== "clover") continue;
      const t = p.themes.find((x) => x.id === "clover");
      if (t !== undefined) return this.read(p, t.file);
    }
    return null;
  }
}

export interface PartTheme {
  plugins: readonly UiPlugin[];
  choices: ThemeChoices;
  /** The tab's bot, if the part is in one. */
  bot?: string;
  /** Style-only entries that dress the part, in the order they apply. */
  styles: readonly { plugin: UiPlugin; file: string }[];
  appearance: Appearance;
  systemAccent?: string;
  frame: FrameMetrics;
  /** The user's text size (the settings plugin's own vocabulary until lane B's UiSettings carries it, F-M3). */
  textSize: TextSize;
}

/** The user's text size: the settings plugin's own three steps, which F-M3 moves into the core's UiSettings. */
export type TextSize = "small" | "default" | "large";

/** The text size as a token (`--clover-text-scale`): the standard steps around the default size, which a part
 *  multiplies its type by. The runtime holds the choice; F-M3 drives it from UiSettings. */
export function textTokens(textSize: TextSize): Record<string, TokenValue> {
  return { "text.scale": textSize === "small" ? 0.875 : textSize === "large" ? 1.125 : 1 };
}

/** The stack, lowest first (§5.5): base theme, global theme (the base until the user picks one), the bot's theme, the
 *  dressing plugins, the user's overrides. */
export function tokenLayers(store: ThemeStore, input: PartTheme): TokenLayer[] {
  const layers: TokenLayer[] = [];
  for (const t of stackThemes(store, input)) layers.push(store.prepared(t.plugin, t.theme));
  const overrides = input.choices.overrides?.tokens;
  if (overrides !== undefined) layers.push({ tokens: { ...overrides } });
  return layers;
}

/** The stack's theme layers for a part, lowest first, with the plugin each comes from (the user's overrides aside). */
export function stackThemes(store: ThemeStore, input: PartTheme): { kind: "base" | "global" | "bot" | "style"; plugin: UiPlugin; theme: Theme }[] {
  const out: { kind: "base" | "global" | "bot" | "style"; plugin: UiPlugin; theme: Theme }[] = [];
  const base = themeByRef(store, input.plugins, input.choices.baseTheme) ?? cloverBaseTheme(store, input.plugins);
  if (base !== undefined) out.push({ kind: "base", ...base });
  const global = themeByRef(store, input.plugins, input.choices.globalTheme);
  if (global !== undefined) out.push({ kind: "global", ...global });
  if (input.bot !== undefined) {
    const b = botTheme(store, input.plugins, input.bot);
    if (b !== undefined) out.push({ kind: "bot", ...b });
  }
  for (const s of input.styles) {
    const theme = store.read(s.plugin, s.file);
    if (theme !== null) out.push({ kind: "style", plugin: s.plugin, theme });
  }
  return out;
}

function themeByRef(store: ThemeStore, plugins: readonly UiPlugin[], ref: string | undefined): { plugin: UiPlugin; theme: Theme } | undefined {
  if (ref === undefined) return undefined;
  const hash = ref.indexOf("#");
  const plugin = hash < 0 ? undefined : plugins.find((p) => p.id === ref.slice(0, hash));
  const entry = plugin?.themes.find((t) => t.id === ref.slice(hash + 1));
  const theme = plugin !== undefined && entry !== undefined ? store.read(plugin, entry.file) : null;
  return theme === null || plugin === undefined ? undefined : { plugin, theme };
}

function cloverBaseTheme(store: ThemeStore, plugins: readonly UiPlugin[]): { plugin: UiPlugin; theme: Theme } | undefined {
  for (const p of plugins) {
    if (p.topId !== "clover") continue;
    const t = p.themes.find((x) => x.id === "clover");
    const theme = t === undefined ? null : store.read(p, t.file);
    if (theme !== null) return { plugin: p, theme };
  }
  return undefined;
}

/** A bot's own theme, for its tab. */
export function botTheme(store: ThemeStore, plugins: readonly UiPlugin[], bot: string): { plugin: UiPlugin; theme: Theme } | undefined {
  const plugin = plugins.find((p) => p.isBot && p.id === bot);
  const entry = plugin?.themes.find((t) => t.id === plugin.botTheme) ?? (plugin !== undefined && plugin.themes.length === 1 ? plugin.themes[0] : undefined);
  const theme = plugin !== undefined && entry !== undefined ? store.read(plugin, entry.file) : null;
  return theme === null || plugin === undefined ? undefined : { plugin, theme };
}

export function partTokens(store: ThemeStore, input: PartTheme): Record<string, TokenValue> {
  const tokens = resolveTokens(input.appearance, tokenLayers(store, input), input.systemAccent !== undefined ? { systemAccent: input.systemAccent } : {});
  return { ...tokens, ...frameTokens(input.frame), ...textTokens(input.textSize) };
}
