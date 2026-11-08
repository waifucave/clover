// The app's side of plugins with UI (spec §5.5; lane E's runtime): `plugin.ui`, the views the app mounts components
// from; `plugin_ui_changed`, a nudge to read them again; and `plugin.layer.api`, a component's plugin API call, which
// the app makes for it.
//
// * A view is a running plugin's (on, and running or waiting) that has components, `ui` entries, themes, locales or a
//   bot. Its files are its folder's (`assetBase`: for a bundled plugin, the private copy of its verified bytes). Its
//   `clientEntry` is the manifest's `client.entry` when that is a built module (`.js`/`.mjs`); a TypeScript entry gets
//   none until the registry's load-time build lands. Everything under `clover` shares the `clover` layer; any other
//   plugin's layer is its id with `/` written `--`. `ui`, `themes`, `locales` and the bot are its active entries.
// * `plugin.layer.api` runs as the user (`client: app`), from the `ui` side of the capability gate: only the calls a
//   component may make, each needing what the plugin's OK granted. `pluginId` is the one the app bound the mount to,
//   never anything a component said. `args` are the method's parameters in order (the SDK's `ApiCallSignatures`):
//   `host.call`'s are the handler's name, its args and options, and it runs that host handler for the session.
// * A host half's `ui.send(event, value)` becomes `plugin_ui_message`, which the app relays to its components' `host.on`.
import { PLUGINS_EVENTS, PLUGINS_METHODS, type UiPluginView } from "@waifucave/clover-protocol";
import type { Clock, TimerHandle } from "../contracts/clock";
import { ContractError } from "../contracts/common";
import type { ApiRouter } from "../contracts/plugin-host";
import type { PluginRecord, PluginRegistry } from "../contracts/plugin-registry";
import { handler, MethodError, toMethodError, type MethodHandler } from "../rpc/handler";

/** The registry states whose plugins show UI: on and running, or waiting for a point. */
const SHOWN = new Set(["running", "waiting"]);

/** The layer a plugin's documents load in: `clover` for the whole bundled tree, otherwise its id with `/` as `--`. */
export function layerOf(pluginId: string): string {
  return pluginId === "clover" || pluginId.startsWith("clover/") ? "clover" : pluginId.replace(/\//g, "--");
}

type Entries = Pick<PluginRegistry, "entries">;

function activeValues<T>(registry: Entries, point: string, pluginId: string): T[] {
  return registry.entries(point).filter((c) => c.pluginId === pluginId && c.state === "active").map((c) => c.value as T);
}

/** One plugin's view, or undefined when it shows no UI. */
export function uiViewOf(registry: Entries, r: PluginRecord): UiPluginView | undefined {
  const m = r.manifest;
  if (m === undefined || !r.enabled || !SHOWN.has(r.state) || r.treeHash === undefined) return undefined;
  const ui = activeValues<Record<string, unknown>>(registry, "ui", r.id);
  const themes = activeValues<{ id: string; file: string }>(registry, "themes", r.id).map((t) => ({ id: t.id, file: t.file }));
  const locales = activeValues<{ lang: string; file: string }>(registry, "locales", r.id).map((l) => ({ lang: l.lang, file: l.file }));
  const bot = activeValues<{ name: string; theme?: string; layout?: string }>(registry, "bot", r.id)[0];
  const client = m.client;
  if (client === undefined && ui.length === 0 && themes.length === 0 && locales.length === 0 && bot === undefined) return undefined;
  const networkHosts = r.granted.filter((c) => c.startsWith("network:")).map((c) => c.slice("network:".length)).filter((h) => h !== "");
  return {
    pluginId: r.id,
    name: r.name,
    treeHash: r.treeHash,
    source: r.source,
    capabilities: [...r.granted],
    ...(client?.css !== undefined && client.css.length > 0 ? { css: [...client.css] } : {}),
    ...(networkHosts.length > 0 ? { networkHosts } : {}),
    ...(bot !== undefined ? { bot: { name: bot.name, ...(bot.theme !== undefined ? { theme: bot.theme } : {}), ...(bot.layout !== undefined ? { layout: bot.layout } : {}) } } : {}),
    layer: layerOf(r.id),
    assetBase: r.folder,
    ...(client !== undefined && /\.m?js$/.test(client.entry) ? { clientEntry: client.entry } : {}),
    ui,
    themes,
    locales,
    bots: "all",
  };
}

export function uiPluginViews(registry: Pick<PluginRegistry, "list" | "entries">): UiPluginView[] {
  const out: UiPluginView[] = [];
  for (const r of registry.list()) {
    const v = uiViewOf(registry, r);
    if (v !== undefined) out.push(v);
  }
  return out;
}

export interface PluginUiOptions {
  registry: Pick<PluginRegistry, "list" | "entries" | "watch">;
  /** The capability gate with no process check (`createApiRouter`'s): a component's call comes from the `ui` side. */
  router: ApiRouter;
  /** Sends a core event to the app (the Clover server's `coreEvent`). */
  emit(event: { type: string; [key: string]: unknown }): void;
  clock?: Pick<Clock, "setTimeout" | "clearTimeout">;
}

/** The methods `plugin.ui` and `plugin.layer.api`, and the registry watch that nudges the app. */
export function pluginUi(o: PluginUiOptions): { methods: Record<string, MethodHandler>; close(): void } {
  const M = PLUGINS_METHODS;
  // A burst of registry changes (a reload, a folder's settle) is one nudge, naming each plugin once.
  const pending = new Set<string>();
  let timer: TimerHandle | ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (pending.size === 0) return;
    const pluginIds = [...pending].sort();
    pending.clear();
    o.emit({ type: PLUGINS_EVENTS.pluginUiChanged.type, pluginIds });
  };
  const nudge = (ids: readonly string[]) => {
    for (const id of ids) pending.add(id);
    if (timer !== undefined) return;
    timer = o.clock !== undefined ? o.clock.setTimeout(flush, 100) : setTimeout(flush, 100);
  };
  // Opened: one nudge naming every plugin, so an app that read the empty list while the registry opened reads again.
  nudge(o.registry.list().map((r) => r.id));
  const stop = o.registry.watch((c) => {
    if (c.type === "plugin" || c.type === "removed") nudge([c.id]);
    else if (["ui", "themes", "locales", "bot"].includes(c.point)) nudge(o.registry.entries(c.point).map((e) => e.pluginId));
  });
  return {
    methods: {
      [M.pluginUi.name]: handler(M.pluginUi, () => ({ plugins: uiPluginViews(o.registry) })),
      // A failure names the plugin and the call (never a mount: the app maps them to its own parts).
      [M.pluginLayerApi.name]: handler(M.pluginLayerApi, async (p) => {
        try {
          return { result: await o.router({ pluginId: p.pluginId, process: "ui", path: p.call, args: p.args, caller: { kind: "user", client: "app" }, ...(p.session !== undefined ? { session: p.session } : {}) }) };
        } catch (err) {
          const e = toMethodError(err instanceof ContractError || err instanceof MethodError ? err : new ContractError("failed", err instanceof Error ? err.message : String(err)));
          throw new MethodError(e.code, e.message, { ...(typeof e.data === "object" && e.data !== null ? e.data : {}), pluginId: p.pluginId, call: p.call });
        }
      }),
    },
    close() {
      stop();
      if (timer !== undefined) {
        if (o.clock !== undefined) o.clock.clearTimeout(timer as TimerHandle);
        else clearTimeout(timer as ReturnType<typeof setTimeout>);
      }
      pending.clear();
    },
  };
}
