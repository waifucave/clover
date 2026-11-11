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
import { RUNNING_STATES, type PluginRecord, type PluginRegistry } from "../contracts/plugin-registry";
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

/** A plugin's picture: its manifest's `icon`, else its bot's avatar portrait (each a file in its folder). */
export function iconOf(m: unknown): string | undefined {
  const x = m as { icon?: unknown; contributes?: { bot?: { avatar?: { portrait?: unknown } } } };
  // Only a path inside its own folder that the view can hold (UiPluginView's icon): never one that would fail the list.
  const inFolder = (p: unknown): p is string => typeof p === "string" && p !== "" && p.length <= 4096 && !p.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.split("/").some((s) => s === ".." || s === "");
  if (inFolder(x.icon)) return x.icon;
  const portrait = x.contributes?.bot?.avatar?.portrait;
  return inFolder(portrait) ? portrait : undefined;
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
    ...(iconOf(m) !== undefined ? { icon: iconOf(m) } : {}),
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
  registry: Pick<PluginRegistry, "list" | "entries" | "watch"> & Partial<Pick<PluginRegistry, "get">>;
  /** A plugin's settings as its own layer reads and changes them (`PluginSettings.layerView`, `layerSet`). Absent: both
   *  are refused. */
  settings?: { layerView(pluginId: string, key?: string): Promise<unknown>; layerSet(pluginId: string, key: string, value: unknown): void };
  /** The capability gate with no process check (`createApiRouter`'s): a component's call comes from the `ui` side. */
  router: ApiRouter;
  /** Sends a core event to the app (the Clover server's `coreEvent`). */
  emit(event: { type: string; [key: string]: unknown }): void;
  clock?: Pick<Clock, "setTimeout" | "clearTimeout">;
}

/** `plugin.layer.call`'s limits: its args serialized, and calls per plugin per second. */
export const LAYER_CALL_MAX_BYTES = 64 * 1024;
export const LAYER_CALLS_PER_SECOND = 20;
/** At most this many of a plugin's own settings changes from its layer a minute (`settings.set`), on top of the calls'
 *  own cap: a page can't thrash the settings file, nor what a change wakes. */
export const LAYER_SETTING_WRITES_PER_MINUTE = 30;

/** The methods `plugin.ui`, `plugin.layer.api` and `plugin.layer.call`, and the registry watch that nudges the app. */
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
  const layerWindows = new Map<string, { start: number; n: number }>();
  // `settings.get` and `settings.set` from a plugin's own layer: its own settings only (the connection's plugin; a
  // child's layer is the child's, and reaches the child's own), while it is on and running (`grantsInForce`'s rule). A
  // read gives a secret only as `{ set }`; a change is `layerSet`'s (never a secret, a bot value or a setting written
  // into what the plugin runs), with no card, at most LAYER_SETTING_WRITES_PER_MINUTE a minute. No capability: they
  // are its own, as its own events are (§5.4).
  const settingWrites = new Map<string, number[]>();
  const ownSettings = async (pluginId: string, call: "settings.get" | "settings.set", args: readonly unknown[]): Promise<unknown> => {
    const key = args[0];
    const keyOk = typeof key === "string" && key.length > 0 && key.length <= 128;
    if (call === "settings.get" ? args.length > 1 || (key !== undefined && !keyOk) : args.length !== 2 || !keyOk) {
      throw new ContractError("invalid", call === "settings.get" ? "settings.get takes one of the plugin's setting keys, or nothing for every key" : "settings.set takes one of the plugin's setting keys and its value");
    }
    const record = o.registry.get?.(pluginId);
    if (record === undefined || !record.enabled || !RUNNING_STATES.has(record.state)) throw new ContractError("refused", `${pluginId} isn't running, so its page reaches none of its settings`);
    if (o.settings === undefined) throw new ContractError("refused", "this computer's plugin settings aren't open");
    if (call === "settings.get") return o.settings.layerView(pluginId, key as string | undefined);
    const now = Date.now();
    const recent = (settingWrites.get(pluginId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= LAYER_SETTING_WRITES_PER_MINUTE) throw new ContractError("refused", `${pluginId}'s page changed its settings ${LAYER_SETTING_WRITES_PER_MINUTE} times this minute; try again in a moment`);
    o.settings.layerSet(pluginId, key as string, args[1]);
    recent.push(now);
    settingWrites.set(pluginId, recent);
    return null;
  };
  return {
    methods: {
      [M.pluginUi.name]: handler(M.pluginUi, () => ({ plugins: uiPluginViews(o.registry) })),
      // A plugin's own UI layer, on its own connection, reaching its own plugin: its host half's handler (`host.call`),
      // a read of its synced store, or a read of its own settings (`settings.get`, `ownSettings` above). The plugin is
      // the connection's (its token's), never a parameter; the call goes through the capability gate from the `ui` side
      // as the plugin, never as the user, with no session (a layer's word about one isn't taken). Capped in size and
      // rate per plugin.
      [M.pluginLayerCall.name]: handler(M.pluginLayerCall, async (p, ctx) => {
        if (ctx.caller.kind !== "plugin") throw new ContractError("refused", "only a plugin's UI layer calls its plugin this way");
        const pluginId = ctx.caller.pluginId;
        let size = 0;
        try {
          size = new TextEncoder().encode(JSON.stringify(p.args)).length;
        } catch {
          throw new ContractError("invalid", "plugin.layer.call takes JSON args");
        }
        if (size > LAYER_CALL_MAX_BYTES) throw new ContractError("invalid", `plugin.layer.call's args are ${size} bytes; at most ${LAYER_CALL_MAX_BYTES}`);
        const now = Date.now();
        const w = layerWindows.get(pluginId);
        if (w === undefined || now - w.start >= 1000) layerWindows.set(pluginId, { start: now, n: 1 });
        else if (++w.n > LAYER_CALLS_PER_SECOND) throw new ContractError("refused", `${pluginId}'s UI made more than ${LAYER_CALLS_PER_SECOND} calls this second`);
        if (p.call === "settings.get" || p.call === "settings.set") return { result: await ownSettings(pluginId, p.call, p.args) };
        try {
          return { result: await o.router({ pluginId, process: "ui", path: p.call, args: p.args, caller: { kind: "plugin", pluginId } }) };
        } catch (err) {
          const e = toMethodError(err instanceof ContractError || err instanceof MethodError ? err : new ContractError("failed", err instanceof Error ? err.message : String(err)));
          throw new MethodError(e.code, e.message, { ...(typeof e.data === "object" && e.data !== null ? e.data : {}), pluginId, call: p.call });
        }
      }),
      // A failure names the plugin and the call (never a mount: the app maps them to its own parts).
      [M.pluginLayerApi.name]: handler(M.pluginLayerApi, async (p) => {
        try {
          // A component acts as its plugin, never as the user (the coordinator's ruling on #333): `commands.run`,
          // `host.call` and every area see the plugin. The user's own gesture counts only on the app's explicit path
          // (`pill.send` inside a real key press or click, carried by the app's main process).
          return { result: await o.router({ pluginId: p.pluginId, process: "ui", path: p.call, args: p.args, caller: { kind: "plugin", pluginId: p.pluginId }, ...(p.session !== undefined ? { session: p.session } : {}) }) };
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
