// The app's plugin runtime's view of plugins with UI (spec §5.5): what the daemon's `plugin.ui` hands over
// (`UiPluginView`, lane B's protocol), read into the entries the spot resolver ranks. Pure: no Electron import, so it
// is unit-tested under Bun.
//
// Three fields the resolver needs are not in `UiPluginView` yet (asked of lane B): `source` (rule 6, "a plugin the
// user installed, over a bundled one"), `enabledAt` (rule 7, "the most recently enabled") and `capabilities` (`needs`).
// Until they are, `readUiPlugins` takes them from `plugin.list` and the plugin's detail when given, and otherwise
// falls back to: bundled for the `moss` tree and `alpha`, the order the daemon listed them in, and no capabilities.
import { UiPluginView as UiPluginViewSchema, type DataFilesView, type UiPluginView } from "@waifucave/moss-protocol";

/** Where a plugin came from, as the resolver's rule 6 sees it. */
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
  /** The plugin it belongs to: a child counts as its own plugin (`moss/composer`). */
  pluginId: string;
  /** `<id defaults to the spot>`. */
  id: string;
  spot: string;
  key?: string;
  order?: number;
  when?: UiWhen;
  /** What the entry is: a component, a web page, style only, a hide, or data a part draws itself (a message action). */
  kind: "component" | "web" | "style" | "hide" | "data";
  /** A list spot's hide: the entry it takes out (`<plugin-id>#<entry-id>`, or `<plugin-id>` for all of that plugin's). */
  target?: string;
  component?: string;
  /** A theme-format file, relative to the plugin's folder. */
  style?: string;
  web?: Readonly<Record<string, unknown>>;
  window?: { type: "overlay" | "window"; alwaysOnTop?: boolean; transparent?: boolean; placement?: Readonly<Record<string, string>>; front?: "stays" | "steps-aside"; cards?: boolean; summon?: readonly "tap"[] };
  declares: Readonly<Record<string, PointDeclaration>>;
  /** The spot's own fields (title, icon, opens…). */
  fields: Readonly<Record<string, unknown>>;
  /** In a plugin with a bot, a part beside the bot (§5.5): it follows the app's rules, not limited to the bot's tab. */
  app?: true;
}

export interface UiPlugin {
  id: string;
  /** Its top-level plugin: `moss` for `moss/composer`. */
  topId: string;
  /** The layer it renders in: its origin label (§5.5). */
  layer: string;
  treeHash: string;
  /** Where its files are (M1: a folder on this computer). */
  assetBase: string;
  clientEntry?: string;
  /** The core's load-time build of a TypeScript client entry: its folder, the module's name and its SHA-256 (hex),
   *  served at `/_b/` (`builtClientFile`) only while the file still has that hash. */
  clientBuild?: { base: string; file: string; sha256: string };
  /** Its client CSS files, relative to its folder (the manifest's `client.css`). */
  css: readonly string[];
  source: UiSource;
  /** When it was last switched on; the resolver's rule 7. */
  enabledAt: number;
  capabilities: ReadonlySet<string>;
  /** Bots whose tabs it dresses (`when.bot`, or the user's ticks); `all` includes bots added later. */
  bots: "all" | readonly string[];
  /** It is a bot's plugin: the bot's id is the plugin's id, and its entries count as limited to that bot. */
  isBot: boolean;
  /** Its name, for a bot's row until the plugin API's `bots` reaches layers. */
  name?: string;
  /** For a bot: the theme its tab wears (`bot.theme`), one of `themes`. */
  botTheme?: string;
  /** The files that come with its entries on points that declare them (`DataFilesView`): folders of its own whose files of
   *  the declared kinds the app serves to every layer (`dataFile`). */
  dataFiles: readonly DataFilesView[];
  /** The manifest's `client.isolated`: its layer's frames may be cross-origin isolated (SharedArrayBuffer). */
  isolated?: true;
  /** Its picture for lists (the view's `icon`): a file in its folder, served as an image only (`/_t/`). */
  icon?: string;
  themes: readonly { id: string; file: string }[];
  locales: readonly { lang: string; file: string }[];
  entries: readonly UiEntry[];
}

/** The plugins whose UI runs in safe mode (§5.8): only the app's own. */
export const SAFE_MODE_PLUGINS: readonly string[] = ["moss", "alpha"];

export function topIdOf(pluginId: string): string {
  return pluginId.split("/")[0]!;
}

/** A plugin's layer origin label: everything under `moss` shares `moss`; any other child writes its `/` as `--`
 *  (§5.1, §5.5). */
export function layerOf(pluginId: string): string {
  return topIdOf(pluginId) === "moss" ? "moss" : pluginId.replace(/\//g, "--");
}

export interface UiPluginExtras {
  source?: UiSource;
  enabledAt?: number;
  capabilities?: readonly string[];
  isBot?: boolean;
  botTheme?: string;
  name?: string;
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

const ENTRY_KEYS = new Set(["spot", "id", "key", "order", "when", "component", "web", "style", "hide", "target", "layout", "window", "declares", "app"]);
/** The spots whose entries are data their part draws (no component, never a mount). */
export const DATA_SPOTS: ReadonlySet<string> = new Set(["conversation.message.action"]);

function readWhen(raw: unknown): UiWhen | undefined {
  const w = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  return w === undefined ? undefined : {
    ...(asStringList(w.bot) ? { bot: asStringList(w.bot)! } : {}),
    ...(asStringList(w.surface) ? { surface: asStringList(w.surface)! } : {}),
    ...(asStringList(w.os) ? { os: asStringList(w.os)! } : {}),
    ...(asStringList(w.session) ? { session: asStringList(w.session)! } : {}),
    ...(w.setting !== null && typeof w.setting === "object" ? { setting: w.setting as Record<string, unknown> } : {}),
  };
}

/** One manifest `ui` entry, as `plugin.ui` hands it over (already validated by the daemon); undefined when it has none
 *  of component, web, style or hide. */
export function readUiEntry(pluginId: string, raw: Readonly<Record<string, unknown>>): UiEntry | undefined {
  const spot = typeof raw.spot === "string" ? raw.spot : undefined;
  if (spot === undefined) return undefined;
  // A bot's tab layout or a patch to one (retired with the bot tab, G8) is no entry: the daemon refuses them, and none mounts.
  if (raw.layout !== undefined) return undefined;
  const kind = raw.hide === true ? "hide" : typeof raw.component === "string" ? "component" : raw.web !== undefined ? "web" : typeof raw.style === "string" ? "style"
    // Data the declaring part draws itself, never mounted: a message action (`call`, validated by the daemon), a pill target
    // (`handler`: the Dispatch pill lists it by its `title`, and the daemon runs the handler on a send), a tray line (`toggles` or `command`).
    : (DATA_SPOTS.has(spot) && typeof raw.call === "string") || (spot === "pill.target" && typeof raw.handler === "string") || (spot === "app.tray" && (typeof raw.toggles === "string" || typeof raw.command === "string")) ? "data" : undefined;
  if (kind === undefined) return undefined;
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!ENTRY_KEYS.has(k)) fields[k] = v;
  const when = readWhen(raw.when);
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
    ...(kind === "hide" && typeof raw.target === "string" ? { target: raw.target } : {}),
    ...(raw.web !== null && typeof raw.web === "object" ? { web: raw.web as Record<string, unknown> } : {}),
    ...(raw.window !== null && typeof raw.window === "object" ? { window: raw.window as UiEntry["window"] & object } : {}),
    ...(raw.app === true ? { app: true as const } : {}),
    declares: readDeclares(raw.declares),
    fields,
  };
}

function fromView(v: Record<string, unknown>): UiPluginExtras {
  const strings = (x: unknown) => (Array.isArray(x) && x.every((y) => typeof y === "string") ? (x as string[]) : undefined);
  // The core's source names (B-M1's enum): bundled, index, npm, local, wrapped, dev. What the runtime cares about is
  // where the plugin came from as the resolver rule 6 reads it: the bundled tree, a dev one, or installed beside them.
  const source = v.source === "bundled" ? "bundled" : v.source === "dev" ? "dev" : v.source === "index" || v.source === "npm" || v.source === "local" || v.source === "wrapped" ? "installed" : undefined;
  // The daemon's view says a bot as `bot: { name, theme? }` (plugin-host/ui.ts); the older flat names stay read. A bot's tab
  // layout (`bot.layout`, the user layer's) is retired with the bot tab (G8): not read.
  const bot = v.bot !== null && typeof v.bot === "object" ? (v.bot as Record<string, unknown>) : undefined;
  const botTheme = typeof bot?.theme === "string" ? bot.theme : typeof v.botTheme === "string" ? v.botTheme : undefined;
  return {
    ...(source !== undefined ? { source: source as UiSource } : {}),
    ...(typeof v.enabledAt === "number" ? { enabledAt: v.enabledAt } : {}),
    ...(strings(v.capabilities) ? { capabilities: strings(v.capabilities)! } : {}),
    ...(bot !== undefined ? { isBot: true } : typeof v.isBot === "boolean" ? { isBot: v.isBot } : {}),
    ...(botTheme !== undefined ? { botTheme } : {}),
    ...(typeof v.name === "string" ? { name: v.name } : {}),
    ...(strings(v.css) ? { css: strings(v.css)! } : {}),
  };
}

/** The daemon's `plugin.ui` list as the runtime uses it. `extras` fills what the view lacks (see the header). Each view
 *  is checked against lane B's schema, and its layer is the app's own reckoning (`layerOf`), never the daemon's word:
 *  a view whose label disagrees is refused, so no plugin can claim the trusted `moss` layer. */
export function readUiPlugins(views: readonly unknown[], extras: Readonly<Record<string, UiPluginExtras>> = {}, log: (line: string) => void = () => {}): UiPlugin[] {
  const checked: UiPluginView[] = [];
  for (const raw of views) {
    const parsed = UiPluginViewSchema.safeParse(raw);
    if (!parsed.success) {
      log(`layers: refused a plugin view that isn't one (${parsed.error.issues[0]?.message ?? "invalid"})`);
      continue;
    }
    const view = { ...(raw as Record<string, unknown>), ...parsed.data } as UiPluginView;
    const layer = layerOf(view.pluginId);
    if (view.layer !== layer) {
      log(`layers: refused ${view.pluginId}: its layer is ${layer}, not ${view.layer}`);
      continue;
    }
    checked.push(view);
  }
  return checked.map((view, index) => {
    // Fields lane B is asked to add to `UiPluginView` are read from the view when it carries them.
    const x: UiPluginExtras = { ...fromView(view as unknown as Record<string, unknown>), ...extras[view.pluginId] };
    const top = topIdOf(view.pluginId);
    const entries = view.ui.map((raw) => readUiEntry(view.pluginId, raw)).filter((e): e is UiEntry => e !== undefined);
    return {
      id: view.pluginId,
      topId: top,
      layer: layerOf(view.pluginId),
      treeHash: view.treeHash,
      assetBase: view.assetBase,
      ...(view.clientEntry !== undefined ? { clientEntry: view.clientEntry } : {}),
      ...(view.clientBuild !== undefined ? { clientBuild: { ...view.clientBuild } } : {}),
      css: x.css ?? [],
      source: x.source ?? (SAFE_MODE_PLUGINS.includes(top) ? "bundled" : "installed"),
      enabledAt: x.enabledAt ?? index,
      capabilities: new Set(x.capabilities ?? []),
      bots: view.bots,
      isBot: x.isBot ?? false,
      ...(x.name !== undefined ? { name: x.name } : {}),
      ...(x.botTheme !== undefined ? { botTheme: x.botTheme } : {}),
      ...((view as { isolated?: unknown }).isolated === true ? { isolated: true as const } : {}),
      dataFiles: view.dataFiles ?? [],
      ...(typeof view.icon === "string" ? { icon: view.icon } : {}),
      themes: view.themes,
      locales: view.locales,
      entries,
    };
  });
}
