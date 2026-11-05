// Each part's tokens (spec §5.5, decision 77: "each frame themed by its tab"). E-M1 resolves the stack's data layers
// that already exist — the catalog's defaults, the base theme (`clover`'s, or the user's pick), the user's global
// theme, the bot's theme in its tab, the style-only entries that dress the part, and the user's overrides — with the
// OS accent and appearance, through lane B's `resolveTokens`. The CSS half of themes (the cleaner, `@scope`) is E-M2.
// The frame's variables (`frame.*`) come from the window, never a theme. Pure apart from reading theme files.
import { readFileSync } from "node:fs";
import { ThemeSchema, resolveTokens, type Appearance, type Theme, type TokenLayer, type TokenValue } from "@waifucave/clover-plugin-sdk";
import type { UiPlugin } from "./model";
import { pluginFile } from "./files";

export interface ThemeChoices {
  baseTheme?: string;
  globalTheme?: string;
  overrides?: { tokens?: Readonly<Record<string, string | number>> };
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

  constructor(private readonly log: (line: string) => void = () => {}) {}

  clear(): void {
    this.cache.clear();
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
}

/** The stack, lowest first (§5.5): base theme, global theme (the base until the user picks one), the bot's theme, the
 *  dressing plugins, the user's overrides. */
export function tokenLayers(store: ThemeStore, input: PartTheme): TokenLayer[] {
  const layers: TokenLayer[] = [];
  const base = store.byRef(input.plugins, input.choices.baseTheme) ?? store.cloverBase(input.plugins);
  if (base !== null) layers.push(base);
  const global = store.byRef(input.plugins, input.choices.globalTheme);
  if (global !== null) layers.push(global);
  if (input.bot !== undefined) {
    const bot = input.plugins.find((p) => p.isBot && p.id === input.bot);
    const entry = bot?.themes.find((t) => t.id === bot.botTheme) ?? (bot !== undefined && bot.themes.length === 1 ? bot.themes[0] : undefined);
    const theme = bot !== undefined && entry !== undefined ? store.read(bot, entry.file) : null;
    if (theme !== null) layers.push(theme);
  }
  for (const s of input.styles) {
    const theme = store.read(s.plugin, s.file);
    if (theme !== null) layers.push(theme);
  }
  const overrides = input.choices.overrides?.tokens;
  if (overrides !== undefined) layers.push({ tokens: { ...overrides } });
  return layers;
}

export function partTokens(store: ThemeStore, input: PartTheme): Record<string, TokenValue> {
  const tokens = resolveTokens(input.appearance, tokenLayers(store, input), input.systemAccent !== undefined ? { systemAccent: input.systemAccent } : {});
  return { ...tokens, ...frameTokens(input.frame) };
}
