// The app's plugin runtime's view of plugins with UI (spec §5.5): what the daemon's `plugin.ui` hands over
// (`UiPluginView`, lane B's protocol), read into the entries the spot resolver ranks. Pure: no Electron import, so it
// is unit-tested under Bun.
//
// Three fields the resolver needs are not in `UiPluginView` yet (asked of lane B): `source` (rule 5, "a plugin the
// user installed, over a bundled one"), `enabledAt` (rule 6, "the most recently enabled") and `capabilities` (`needs`).
// Until they are, `readUiPlugins` takes them from `plugin.list` and the plugin's detail when given, and otherwise
// falls back to: bundled for the `clover` tree and `alpha`, the order the daemon listed them in, and no capabilities.
import { UiPluginView as UiPluginViewSchema, type AvatarFormatView, type UiPluginView } from "@waifucave/clover-protocol";
import { SPOTS } from "@waifucave/clover-plugin-sdk";

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

/** A plugin's patch to bots' tabs (a `ui` entry on `bot.tab` with `layout`): never an entry the tab's cell ranks, only
 *  changes the core makes to the tabs of the bots it applies to (layout.ts), after the bot's own layout. */
export interface TabPatch {
  pluginId: string;
  id: string;
  /** Its file, relative to its plugin's folder (`LayoutContributionSchema`). */
  file: string;
  /** Its turn among the patches to one tab: lower first (default 500), then plugin id. */
  order?: number;
  when?: UiWhen;
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
  /** What the entry is: a component, a web page, style only, a hide, or data a part draws itself (a message action). */
  kind: "component" | "web" | "style" | "hide" | "data";
  /** A list spot's hide: the entry it takes out (`<plugin-id>#<entry-id>`, or `<plugin-id>` for all of that plugin's). */
  target?: string;
  component?: string;
  /** A theme-format file, relative to the plugin's folder. */
  style?: string;
  /** A bot's layout file (§5.5): the core draws it in the tab, as data; its component is `LAYOUT_COMPONENT`. */
  layout?: string;
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
  /** The core's load-time build of a TypeScript client entry: its folder, the module's name and its SHA-256 (hex),
   *  served at `/_b/` (`builtClientFile`) only while the file still has that hash. */
  clientBuild?: { base: string; file: string; sha256: string };
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
  /** Its name, for a bot's row until the plugin API's `bots` reaches layers. */
  name?: string;
  /** For a bot: the theme its tab wears (`bot.theme`), one of `themes`. */
  botTheme?: string;
  /** For a bot: the layout its tab is arranged by (`bot.layout`), a file in its folder. */
  botLayout?: string;
  /** For a bot: the user's own layout for its tab (the user layer's `layout`, a layout file's JSON), made last. */
  userLayout?: string;
  /** The model formats it draws (its `avatar.formats`), by kind of file: what the app may serve of a bot's model (`modelFileKind`). */
  avatarFormats: readonly AvatarFormatView[];
  /** For a bot: the avatar its manifest names (a file in its folder, and its format). */
  botAvatar?: { file: string; format: string };
  /** Its picture for lists (the view's `icon`): a file in its folder, served as an image only (`/_t/`). */
  icon?: string;
  themes: readonly { id: string; file: string }[];
  locales: readonly { lang: string; file: string }[];
  entries: readonly UiEntry[];
  /** Its patches to bots' tabs. */
  tabPatches?: readonly TabPatch[];
}

/** The component name a layout entry renders with: the core's own, which runs no plugin code. */
export const LAYOUT_COMPONENT = "$layout";

/** The spots a bot's tab declares (the catalog's `bot-tab` spots). */
const BOT_TAB_SPOTS: Readonly<Record<string, PointDeclaration>> = Object.fromEntries(
  SPOTS.filter((s) => s.declaredBy === "bot-tab").map((s) => [s.name, { shape: s.shape, ...(s.needs !== undefined ? { needs: [...s.needs] } : {}) }]),
);

/** A bot's layout as the entry that fills its tab: it declares the tab's spots and the bot's own, so its `{ spot }`
 *  nodes may place them. `file` "" is the stock tab (`DEFAULT_TAB_LAYOUT`), for a bot with no layout of its own that
 *  the user or another plugin rearranges. */
export function layoutEntry(pluginId: string, file: string, own: readonly UiEntry[]): UiEntry {
  const declares: Record<string, PointDeclaration> = { ...BOT_TAB_SPOTS };
  for (const e of own) for (const [name, d] of Object.entries(e.declares)) declares[name] ??= d;
  return { pluginId, id: "layout", spot: "bot.tab", kind: "component", component: LAYOUT_COMPONENT, layout: file, declares, fields: {} };
}

/** The bots a tab patch is limited to, or `all`: as an entry's (`botScope`): the user's ticks, else its `when.bot`; a
 *  bot's own plugin's, to that bot. */
export function patchScope(plugin: Pick<UiPlugin, "isBot" | "id" | "bots">, t: TabPatch): "all" | readonly string[] {
  if (plugin.isBot) return [plugin.id];
  if (plugin.bots !== "all") return plugin.bots;
  const bot = t.when?.bot;
  return bot === undefined ? "all" : typeof bot === "string" ? [bot] : bot;
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
  botLayout?: string;
  userLayout?: string;
  botAvatar?: { file: string; format: string };
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

const ENTRY_KEYS = new Set(["spot", "id", "key", "order", "when", "component", "web", "style", "hide", "target", "layout", "window", "declares"]);
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

/** A `ui` entry that is a patch to bots' tabs (`spot: "bot.tab"` with `layout`), else undefined. */
export function readTabPatch(pluginId: string, raw: Readonly<Record<string, unknown>>): TabPatch | undefined {
  if (raw.spot !== "bot.tab" || typeof raw.layout !== "string") return undefined;
  const when = readWhen(raw.when);
  return {
    pluginId,
    id: typeof raw.id === "string" ? raw.id : "bot.tab",
    file: raw.layout,
    ...(typeof raw.order === "number" ? { order: raw.order } : {}),
    ...(when !== undefined ? { when } : {}),
  };
}

/** One manifest `ui` entry, as `plugin.ui` hands it over (already validated by the daemon); undefined when it has none
 *  of component, web, style or hide. */
export function readUiEntry(pluginId: string, raw: Readonly<Record<string, unknown>>): UiEntry | undefined {
  const spot = typeof raw.spot === "string" ? raw.spot : undefined;
  if (spot === undefined) return undefined;
  // A tab patch is no entry of the tab's cell: it never fills the tab, it changes how the tab is made.
  if (raw.layout !== undefined) return undefined;
  const kind = raw.hide === true ? "hide" : typeof raw.component === "string" ? "component" : raw.web !== undefined ? "web" : typeof raw.style === "string" ? "style"
    // Data the declaring part draws itself, never mounted: a message action (`call`, validated by the daemon).
    : DATA_SPOTS.has(spot) && typeof raw.call === "string" ? "data" : undefined;
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
    declares: readDeclares(raw.declares),
    fields,
  };
}

function fromView(v: Record<string, unknown>): UiPluginExtras {
  const strings = (x: unknown) => (Array.isArray(x) && x.every((y) => typeof y === "string") ? (x as string[]) : undefined);
  // The core's source names (B-M1's enum): bundled, index, npm, local, wrapped, dev. What the runtime cares about is
  // where the plugin came from as the resolver rule 5 reads it: the bundled tree, a dev one, or installed beside them.
  const source = v.source === "bundled" ? "bundled" : v.source === "dev" ? "dev" : v.source === "index" || v.source === "npm" || v.source === "local" || v.source === "wrapped" ? "installed" : undefined;
  // The daemon's view says a bot as `bot: { name, theme?, layout? }` (plugin-host/ui.ts); the older flat names stay read.
  const bot = v.bot !== null && typeof v.bot === "object" ? (v.bot as Record<string, unknown>) : undefined;
  const botTheme = typeof bot?.theme === "string" ? bot.theme : typeof v.botTheme === "string" ? v.botTheme : undefined;
  const botLayout = typeof bot?.layout === "string" ? bot.layout : typeof v.botLayout === "string" ? v.botLayout : undefined;
  const userLayout = typeof bot?.userLayout === "string" ? bot.userLayout : undefined;
  const av = bot?.avatar !== null && typeof bot?.avatar === "object" ? (bot.avatar as Record<string, unknown>) : undefined;
  const botAvatar = typeof av?.file === "string" && typeof av.format === "string" ? { file: av.file, format: av.format } : undefined;
  return {
    ...(source !== undefined ? { source: source as UiSource } : {}),
    ...(typeof v.enabledAt === "number" ? { enabledAt: v.enabledAt } : {}),
    ...(strings(v.capabilities) ? { capabilities: strings(v.capabilities)! } : {}),
    ...(bot !== undefined ? { isBot: true } : typeof v.isBot === "boolean" ? { isBot: v.isBot } : {}),
    ...(botTheme !== undefined ? { botTheme } : {}),
    ...(botLayout !== undefined ? { botLayout } : {}),
    ...(userLayout !== undefined ? { userLayout } : {}),
    ...(botAvatar !== undefined ? { botAvatar } : {}),
    ...(typeof v.name === "string" ? { name: v.name } : {}),
    ...(strings(v.css) ? { css: strings(v.css)! } : {}),
  };
}

/** The daemon's `plugin.ui` list as the runtime uses it. `extras` fills what the view lacks (see the header). Each view
 *  is checked against lane B's schema, and its layer is the app's own reckoning (`layerOf`), never the daemon's word:
 *  a view whose label disagrees is refused, so no plugin can claim the trusted `clover` layer. */
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
    const tabPatches = view.ui.map((raw) => readTabPatch(view.pluginId, raw)).filter((t): t is TabPatch => t !== undefined);
    // A bot's layout is its tab, drawn by the core, unless the bot's own component fills the tab; the user's own layout
    // makes one too, on the stock tab when the bot has none.
    if ((x.isBot ?? false) && (x.botLayout !== undefined || x.userLayout !== undefined) && !entries.some((e) => e.spot === "bot.tab" && e.kind !== "style")) entries.push(layoutEntry(view.pluginId, x.botLayout ?? "", entries));
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
      ...(x.botLayout !== undefined ? { botLayout: x.botLayout } : {}),
      ...(x.botAvatar !== undefined ? { botAvatar: x.botAvatar } : {}),
      avatarFormats: view.avatarFormats ?? [],
      ...(typeof view.icon === "string" ? { icon: view.icon } : {}),
      themes: view.themes,
      locales: view.locales,
      entries,
      tabPatches,
      ...(x.userLayout !== undefined ? { userLayout: x.userLayout } : {}),
    };
  });
}

/** The registry as the runtime ranks it, with the tabs other plugins' patches change. A bot with no layout of its own
 *  gets one on the stock tab (`file` ""), so the patches have something to change; not when another plugin's own
 *  component may fill that tab (it stays as it ranks without them; the patches wait, said once), nor when the bot's
 *  own component does. What the patches' added nodes place, the layout declares (their plugins' own spots, never a
 *  private one). Returns new plugin objects for the bots it changes; the rest as they are. */
export function withTabPatches(plugins: readonly UiPlugin[], log: (line: string) => void = () => {}): UiPlugin[] {
  return plugins.map((bot) => {
    if (!bot.isBot) return bot;
    const patchers = plugins.filter((p) => (p.tabPatches ?? []).some((t) => { const s = patchScope(p, t); return s === "all" || s.includes(bot.id); }));
    if (patchers.length === 0) return bot;
    let layout = bot.entries.find((e) => e.spot === "bot.tab" && e.layout !== undefined);
    if (layout === undefined) {
      if (bot.entries.some((e) => e.spot === "bot.tab" && e.kind !== "style")) return bot;
      const replaced = plugins.some((p) => p.id !== bot.id && p.topId !== "clover" && p.entries.some((e) => {
        if (e.spot !== "bot.tab" || (e.kind !== "component" && e.kind !== "web")) return false;
        const scope = p.isBot ? [p.id] : p.bots !== "all" ? p.bots : e.key !== undefined ? [e.key] : e.when?.bot === undefined ? "all" : typeof e.when.bot === "string" ? [e.when.bot] : e.when.bot;
        return scope === "all" || scope.some((b) => b === bot.id || (b.endsWith("*") && bot.id.startsWith(b.slice(0, -1))));
      }));
      if (replaced) {
        log(`layers: ${bot.id}'s tab is another plugin's own component; the layout patches for it wait`);
        return bot;
      }
      layout = layoutEntry(bot.id, "", bot.entries);
    }
    const declares: Record<string, PointDeclaration> = { ...layout.declares };
    for (const p of patchers) if (p.id !== bot.id) for (const e of p.entries) for (const [name, d] of Object.entries(e.declares)) if (d.private !== true) declares[name] ??= d;
    const linked: UiEntry = { ...layout, declares };
    const had = bot.entries.includes(layout);
    return { ...bot, entries: had ? bot.entries.map((e) => (e === layout ? linked : e)) : [...bot.entries, linked] };
  });
}
