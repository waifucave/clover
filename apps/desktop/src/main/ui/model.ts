// The app's plugin runtime's view of plugins with UI (spec §5.5): what the daemon's `plugin.ui` hands over
// (`UiPluginView`, lane B's protocol), read into the entries the spot resolver ranks. Pure: no Electron import, so it
// is unit-tested under Bun.
//
// Three fields the resolver needs are not in `UiPluginView` yet (asked of lane B): `source` (rule 5, "a plugin the
// user installed, over a bundled one"), `enabledAt` (rule 6, "the most recently enabled") and `capabilities` (`needs`).
// Until they are, `readUiPlugins` takes them from `plugin.list` and the plugin's detail when given, and otherwise
// falls back to: bundled for the `clover` tree and `alpha`, the order the daemon listed them in, and no capabilities.
import type { UiPluginView } from "@waifucave/clover-protocol";

/** Where a plugin came from, as the resolver's rule 5 sees it. */
export type UiSource = "bundled" | "installed" | "dev";

export interface PointDeclaration {
  shape: "single" | "list" | "keyed";
  needs?: readonly string[];
  keep?: readonly string[];
  context?: readonly string[];
  /** Open only to the declaring plugin's own tree. */
  private?: boolean;
}

export interface UiWhen {
  bot?: string | readonly string[];
  surface?: string | readonly string[];
  os?: readonly string[];
  session?: string | readonly string[];
  setting?: Readonly<Record<string, unknown>>;
}

/** One `ui` entry of one plugin, as the runtime mounts it. */
export interface UiEntry {
  /** The plugin it belongs to: a child counts as its own plugin (`clover/composer`). */
  pluginId: string;
  /** `<id defaults to the spot>`. */
  id: string;
  spot: string;
  key?: string;
  order?: number;
  when?: UiWhen;
  /** What the entry is: a component, a web page, style only, or a hide. */
  kind: "component" | "web" | "style" | "hide";
  component?: string;
  /** A theme-format file, relative to the plugin's folder. */
  style?: string;
  web?: Readonly<Record<string, unknown>>;
  window?: { type: "overlay" | "window"; alwaysOnTop?: boolean; transparent?: boolean; placement?: Readonly<Record<string, string>> };
  declares: Readonly<Record<string, PointDeclaration>>;
  /** The spot's own fields (title, icon, opens…). */
  fields: Readonly<Record<string, unknown>>;
}

export interface UiPlugin {
  id: string;
  /** Its top-level plugin: `clover` for `clover/composer`. */
  topId: string;
  /** The layer it renders in: its origin label (§5.5). */
  layer: string;
  treeHash: string;
  /** Where its files are (M1: a folder on this computer). */
  assetBase: string;
  clientEntry?: string;
  /** Its client CSS files, relative to its folder (the manifest's `client.css`). */
  css: readonly string[];
  source: UiSource;
  /** When it was last switched on; the resolver's rule 6. */
  enabledAt: number;
  capabilities: ReadonlySet<string>;
  /** Bots whose tabs it dresses (`when.bot`, or the user's ticks); `all` includes bots added later. */
  bots: "all" | readonly string[];
  /** It is a bot's plugin: the bot's id is the plugin's id, and its entries count as limited to that bot. */
  isBot: boolean;
  /** For a bot: the theme its tab wears (`bot.theme`), one of `themes`. */
  botTheme?: string;
  themes: readonly { id: string; file: string }[];
  locales: readonly { lang: string; file: string }[];
  entries: readonly UiEntry[];
}

/** The plugins whose UI runs in safe mode (§5.8): only the app's own. */
export const SAFE_MODE_PLUGINS: readonly string[] = ["clover", "alpha"];

export function topIdOf(pluginId: string): string {
  return pluginId.split("/")[0]!;
}

/** A plugin's layer origin label: everything under `clover` shares `clover`; any other child writes its `/` as `--`
 *  (§5.1, §5.5). */
export function layerOf(pluginId: string): string {
  return topIdOf(pluginId) === "clover" ? "clover" : pluginId.replace(/\//g, "--");
}

export interface UiPluginExtras {
  source?: UiSource;
  enabledAt?: number;
  capabilities?: readonly string[];
  isBot?: boolean;
  botTheme?: string;
  css?: readonly string[];
}

function asStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  return undefined;
}

function readDeclares(raw: unknown): Record<string, PointDeclaration> {
  const out: Record<string, PointDeclaration> = {};
  if (raw === null || typeof raw !== "object") return out;
  for (const [name, decl] of Object.entries(raw as Record<string, unknown>)) {
    if (decl === null || typeof decl !== "object") continue;
    const d = decl as Record<string, unknown>;
    const shape = d.shape === "single" || d.shape === "list" || d.shape === "keyed" ? d.shape : undefined;
    if (shape === undefined) continue;
    out[name] = {
      shape,
      ...(asStringList(d.needs) ? { needs: asStringList(d.needs)! } : {}),
      ...(asStringList(d.keep) ? { keep: asStringList(d.keep)! } : {}),
      ...(asStringList(d.context) ? { context: asStringList(d.context)! } : {}),
      ...(d.private === true ? { private: true } : {}),
    };
  }
  return out;
}

const ENTRY_KEYS = new Set(["spot", "id", "key", "order", "when", "component", "web", "style", "hide", "window", "declares"]);

/** One manifest `ui` entry, as `plugin.ui` hands it over (already validated by the daemon); undefined when it has none
 *  of component, web, style or hide. */
export function readUiEntry(pluginId: string, raw: Readonly<Record<string, unknown>>): UiEntry | undefined {
  const spot = typeof raw.spot === "string" ? raw.spot : undefined;
  if (spot === undefined) return undefined;
  const kind = raw.hide === true ? "hide" : typeof raw.component === "string" ? "component" : raw.web !== undefined ? "web" : typeof raw.style === "string" ? "style" : undefined;
  if (kind === undefined) return undefined;
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!ENTRY_KEYS.has(k)) fields[k] = v;
  const w = raw.when !== null && typeof raw.when === "object" ? (raw.when as Record<string, unknown>) : undefined;
  const when: UiWhen | undefined = w === undefined ? undefined : {
    ...(asStringList(w.bot) ? { bot: asStringList(w.bot)! } : {}),
    ...(asStringList(w.surface) ? { surface: asStringList(w.surface)! } : {}),
    ...(asStringList(w.os) ? { os: asStringList(w.os)! } : {}),
    ...(asStringList(w.session) ? { session: asStringList(w.session)! } : {}),
    ...(w.setting !== null && typeof w.setting === "object" ? { setting: w.setting as Record<string, unknown> } : {}),
  };
  return {
    pluginId,
    id: typeof raw.id === "string" ? raw.id : spot,
    spot,
    ...(typeof raw.key === "string" ? { key: raw.key } : {}),
    ...(typeof raw.order === "number" ? { order: raw.order } : {}),
    ...(when !== undefined ? { when } : {}),
    kind,
    ...(typeof raw.component === "string" ? { component: raw.component } : {}),
    ...(typeof raw.style === "string" ? { style: raw.style } : {}),
    ...(raw.web !== null && typeof raw.web === "object" ? { web: raw.web as Record<string, unknown> } : {}),
    ...(raw.window !== null && typeof raw.window === "object" ? { window: raw.window as UiEntry["window"] & object } : {}),
    declares: readDeclares(raw.declares),
    fields,
  };
}

/** The daemon's `plugin.ui` list as the runtime uses it. `extras` fills what the view lacks (see the header). */
export function readUiPlugins(views: readonly UiPluginView[], extras: Readonly<Record<string, UiPluginExtras>> = {}): UiPlugin[] {
  return views.map((view, index) => {
    const x = extras[view.pluginId] ?? {};
    const top = topIdOf(view.pluginId);
    const entries = view.ui.map((raw) => readUiEntry(view.pluginId, raw)).filter((e): e is UiEntry => e !== undefined);
    return {
      id: view.pluginId,
      topId: top,
      layer: view.layer,
      treeHash: view.treeHash,
      assetBase: view.assetBase,
      ...(view.clientEntry !== undefined ? { clientEntry: view.clientEntry } : {}),
      css: x.css ?? [],
      source: x.source ?? (SAFE_MODE_PLUGINS.includes(top) ? "bundled" : "installed"),
      enabledAt: x.enabledAt ?? index,
      capabilities: new Set(x.capabilities ?? []),
      bots: view.bots,
      isBot: x.isBot ?? false,
      ...(x.botTheme !== undefined ? { botTheme: x.botTheme } : {}),
      themes: view.themes,
      locales: view.locales,
      entries,
    };
  });
}
