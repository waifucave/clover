// The app's side of plugins with UI (spec §5.5; lane E's runtime): `plugin.ui`, the views the app mounts components
// from; `plugin_ui_changed`, a nudge to read them again; and `plugin.layer.api`, a component's plugin API call, which
// the app makes for it.
//
// * A view is a running plugin's (on, and running or waiting) that has components, `ui` entries, themes, locales or a
//   bot. Its files are its folder's (`assetBase`: for a bundled plugin, the private copy of its verified bytes). Its
//   `clientEntry` is the manifest's `client.entry` when that is a built module (`.js`/`.mjs`); a TypeScript entry gets
//   `clientBuild` once the registry's load-time build (`registry/client-builds.ts`) lands, and its parts mount then. Everything under `clover` shares the `clover` layer; any other
//   plugin's layer is its id with `/` written `--`. `ui`, `themes`, `locales` and the bot are its active entries.
// * `plugin.layer.api` runs as the user (`client: app`), from the `ui` side of the capability gate: only the calls a
//   component may make, each needing what the plugin's OK granted. `pluginId` is the one the app bound the mount to,
//   never anything a component said. `args` are the method's parameters in order (the SDK's `ApiCallSignatures`):
//   `host.call`'s are the handler's name, its args and options, and it runs that host handler for the session.
// * A host half's `ui.send(event, value)` becomes `plugin_ui_message`, which the app relays to its components' `host.on`.
// * A component reaches every member the SDK's catalog gives components (`COMPONENT_CALLS`), on its own layer
//   connection (`plugin.layer.call`) or the app's (`plugin.layer.api`): the same router, so the same capability, fence
//   and limits as its host half's call, from the `ui` side as the plugin. What only a host half's process could ask is
//   held the same way here: the account token (`net.fetch` with `auth: "waifucave"`) only for the bundled `clover`
//   tree's own components; `secrets.get` never (the router: own process only); a `net.fetch` key placed by the core and
//   masked out of what comes back, so the page never sees it. A member that takes a listener is a watch
//   (`plugin.layer.watch`): the core's listener sits in its place and each value goes back as `plugin_api_event` to
//   that connection alone, until it is unwatched, the connection closes, or the plugin stops, is turned off, removed or
//   loses the capability (`ended`, with why).
import {
  API_CALLS, apiCallAllowed, clampAvatarCap, isComponentCall, listenerArgOf, fromLayerWire, responseToLayerWire, toLayerWire,
  type ApiCallInfo, type AvatarFormatEntry,
} from "@waifucave/clover-plugin-sdk";
import { randomUUID } from "node:crypto";
import { PLUGINS_EVENTS, PLUGINS_METHODS, topPluginIdOf, type UiPluginView } from "@waifucave/clover-protocol";
import type { Clock, TimerHandle } from "../contracts/clock";
import { ContractError } from "../contracts/common";
import { cloverProcessOnly, type ApiRouter } from "../contracts/plugin-host";
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
/** Only a path inside its own folder that a view can hold (UiPluginView's icon): never one that would fail the list. */
const inFolder = (p: unknown): p is string => typeof p === "string" && p !== "" && p.length <= 4096 && !p.startsWith("/") && !p.includes("\\") && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.split("/").some((s) => s === ".." || s === "." || s === "");

/** A manifest's own `icon`, when it is a path inside its folder. */
export function manifestIconOf(m: unknown): string | undefined {
  const icon = (m as { icon?: unknown } | null | undefined)?.icon;
  return inFolder(icon) ? icon : undefined;
}

export function iconOf(m: unknown): string | undefined {
  const x = m as { icon?: unknown; contributes?: { bot?: { avatar?: { portrait?: unknown } } } };
  const own = manifestIconOf(m);
  if (own !== undefined) return own;
  const portrait = x.contributes?.bot?.avatar?.portrait;
  return inFolder(portrait) ? portrait : undefined;
}

/** One plugin's view, or undefined when it shows no UI. */
/** The registry's load-time client builds, as the view reads them (`ClientBuilds`). */
export interface ClientBuildLookup {
  get(id: string, treeHash: string): { base: string; file: string; sha256: string } | undefined;
  watch(fn: (id: string) => void): () => void;
}

/** The user's own layout for a bot (its user layer's `layout`, a layout file's JSON: whole, or a patch that extends the
 *  bot's own), which the app draws over the bot's. */
export type UserLayoutOf = (botId: string) => string | undefined;

export function uiViewOf(registry: Entries, r: PluginRecord, builds?: Pick<ClientBuildLookup, "get">, userLayout?: UserLayoutOf): UiPluginView | undefined {
  const m = r.manifest;
  if (m === undefined || !r.enabled || !SHOWN.has(r.state) || r.treeHash === undefined) return undefined;
  const ui = activeValues<Record<string, unknown>>(registry, "ui", r.id);
  const themes = activeValues<{ id: string; file: string }>(registry, "themes", r.id).map((t) => ({ id: t.id, file: t.file }));
  const locales = activeValues<{ lang: string; file: string }>(registry, "locales", r.id).map((l) => ({ lang: l.lang, file: l.file }));
  const bot = activeValues<{ name: string; theme?: string; layout?: string; avatar?: { file?: unknown; format?: unknown } }>(registry, "bot", r.id)[0];
  const avatarFormats = activeValues<AvatarFormatEntry>(registry, "avatar.formats", r.id).map((f) => ({
    format: f.format,
    extensions: [...f.entry.extensions],
    kinds: f.files.kinds.map((k) => ({ ext: [...k.ext], type: k.type, maxBytes: clampAvatarCap(k.type, k.maxBytes) })),
    find: f.files.find,
    ...(f.files.maxFiles !== undefined ? { maxFiles: f.files.maxFiles } : {}),
  }));
  const client = m.client;
  if (client === undefined && ui.length === 0 && themes.length === 0 && locales.length === 0 && bot === undefined && avatarFormats.length === 0) return undefined;
  const networkHosts = r.granted.filter((c) => c.startsWith("network:")).map((c) => c.slice("network:".length)).filter((h) => h !== "");
  return {
    pluginId: r.id,
    name: r.name,
    treeHash: r.treeHash,
    source: r.source,
    capabilities: [...r.granted],
    ...(client?.css !== undefined && client.css.length > 0 ? { css: [...client.css] } : {}),
    ...(networkHosts.length > 0 ? { networkHosts } : {}),
    ...(avatarFormats.length > 0 ? { avatarFormats } : {}),
    ...(bot !== undefined ? { bot: { name: bot.name, ...(bot.theme !== undefined ? { theme: bot.theme } : {}), ...(bot.layout !== undefined ? { layout: bot.layout } : {}), ...(userLayout?.(r.id) !== undefined ? { userLayout: userLayout(r.id)! } : {}), ...(typeof bot.avatar?.file === "string" && bot.avatar.file !== "" && bot.avatar.file.length <= 4096 && typeof bot.avatar.format === "string" && bot.avatar.format !== "" && bot.avatar.format.length <= 32 ? { avatar: { file: bot.avatar.file, format: bot.avatar.format } } : {}) } } : {}),
    layer: layerOf(r.id),
    ...(iconOf(m) !== undefined ? { icon: iconOf(m) } : {}),
    assetBase: r.folder,
    ...(client !== undefined && /\.m?js$/.test(client.entry) ? { clientEntry: client.entry } : {}),
    ...(client?.isolated === true ? { isolated: true as const } : {}),
    ...(client !== undefined && builds?.get(r.id, r.treeHash) !== undefined ? { clientBuild: { ...builds.get(r.id, r.treeHash)! } } : {}),
    ui,
    themes,
    locales,
    bots: "all",
  };
}

export function uiPluginViews(registry: Pick<PluginRegistry, "list" | "entries">, builds?: Pick<ClientBuildLookup, "get">, userLayout?: UserLayoutOf): UiPluginView[] {
  const out: UiPluginView[] = [];
  for (const r of registry.list()) {
    const v = uiViewOf(registry, r, builds, userLayout);
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
  /** Sends a core event to the one connection whose follows these are (a component's watch value): the Clover server's
   *  `coreEvent` with `to: (conn) => conn.follows === follows`. Absent: a watch is refused. */
  emitTo?(follows: Map<string, () => void>, event: { type: string; [key: string]: unknown }): void;
  clock?: Pick<Clock, "setTimeout" | "clearTimeout">;
  /** The load-time client builds: a view names its plugin's once it lands, and its landing nudges the app. */
  builds?: ClientBuildLookup;
  /** The user's own layout for a bot (its user layer's `layout`); `userLayoutChanged` nudges the app when it changes. */
  userLayout?: UserLayoutOf;
  log?: (line: string) => void;
}

/** `plugin.layer.call`'s limits: its args serialized, and calls per plugin per second (a watch opened counts as one). */
export const LAYER_CALL_MAX_BYTES = 64 * 1024;
export const LAYER_CALLS_PER_SECOND = 20;
/** The members whose args carry bytes (a clip, a file), and how many serialized bytes they may take: under the app's
 *  own cap on a layer's call (`LAYER_CALL_MAX` in the app's layer-links.ts, 2,000,000 characters). */
const BIG_ARGS: ReadonlySet<string> = new Set(["audio.play", "files.write"]);
export const LAYER_CALL_BIG_MAX_BYTES = 1_500_000;
/** An answer handed to a component, serialized, at most: one line well under the connection's 4 MiB send buffer
 *  (`ConnWriter`), so a big answer is refused with why rather than cutting the page's connection. */
export const LAYER_RESULT_MAX_BYTES = 3 * 1024 * 1024;
/** A `net.fetch` body handed to a component, at most (base64 in its answer, under LAYER_RESULT_MAX_BYTES); its fetches
 *  open at once, per plugin; a request's header pairs (the host half's own limits, `FETCH_LIMITS`, scaled to a page's:
 *  its body is the call's args, capped above). */
export const LAYER_FETCH_BODY_MAX = 2 * 1024 * 1024;
export const LAYER_FETCHES_PER_PLUGIN = 8;
const LAYER_FETCH_HEADER_PAIRS = 256;
/** Watches one layer connection, and one plugin's connections together, may hold open. */
export const LAYER_WATCHES_PER_CONNECTION = 32;
export const LAYER_WATCHES_PER_PLUGIN = 64;
/** A watch's value as sent, at most; a larger one is sent as `{ $tooLarge: <bytes> }` in its place, so the page knows
 *  it missed one. */
export const LAYER_WATCH_VALUE_MAX_BYTES = 256 * 1024;

/** Why a component can't make `call` through the layer path, or undefined when it can (the SDK catalog's
 *  `COMPONENT_CALLS`, less the members that take a listener, which are watches). `settings.*` and `host.call` are among
 *  them. */
export function layerCallRefusal(call: string, watch = false): string | undefined {
  if (!Object.hasOwn(API_CALLS, call)) return `${call} isn't a call of the plugin API`;
  const info = (API_CALLS as Record<string, ApiCallInfo>)[call]!;
  if (info.notYet !== undefined) return `${call} isn't available yet: ${info.notYet}`;
  if (!isComponentCall(call)) return `${call} exists only in a plugin's host code`;
  const listens = listenerArgOf(call) !== undefined;
  if (listens && !watch) return `${call} takes a listener: a component watches it (plugin.layer.watch)`;
  if (!listens && watch) return `${call} takes no listener: a component calls it (plugin.layer.call)`;
  return undefined;
}

const isBundledClover = (r: Pick<PluginRecord, "id" | "source"> | undefined): boolean => r !== undefined && r.source === "bundled" && topPluginIdOf(r.id) === "clover";

/** The serialized size of a value, or undefined when it isn't JSON. */
function jsonBytes(v: unknown): number | undefined {
  try {
    const text = JSON.stringify(v);
    return text === undefined ? 0 : new TextEncoder().encode(text).length;
  } catch {
    return undefined;
  }
}
/** At most this many settings changes from a top-level plugin's layers a minute (`settings.set`; its children's pages
 *  share its budget), on top of the calls' own cap: a page can't thrash the settings file, nor what a change wakes. */
export const LAYER_SETTING_WRITES_PER_MINUTE = 30;

/** The methods `plugin.ui`, `plugin.layer.api` and `plugin.layer.call`, and the registry watch that nudges the app. */
export function pluginUi(o: PluginUiOptions): { methods: Record<string, MethodHandler>; close(): void; userLayoutChanged(botId?: string): void; watchCount(): number } {
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
  const stopRegistry = o.registry.watch((c) => {
    if (c.type === "plugin" || c.type === "removed") {
      nudge([c.id]);
      recheckWatches(c.id);
    } else if (["ui", "themes", "locales", "bot"].includes(c.point)) nudge(o.registry.entries(c.point).map((e) => e.pluginId));
  });
  const stopBuilds = o.builds?.watch((id) => nudge([id]));
  // The user layouts the app was last told of, by bot.
  const userLayouts = new Map<string, string>();
  for (const r of o.registry.list()) {
    const l = o.userLayout?.(r.id);
    if (l !== undefined) userLayouts.set(r.id, l);
  }
  const stop = () => {
    stopRegistry();
    stopBuilds?.();
  };
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
    // One budget per top-level plugin: its children's pages share it.
    const top = topPluginIdOf(pluginId);
    const now = Date.now();
    const recent = (settingWrites.get(top) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= LAYER_SETTING_WRITES_PER_MINUTE) throw new ContractError("refused", `${top}'s pages changed its settings ${LAYER_SETTING_WRITES_PER_MINUTE} times this minute; try again in a moment`);
    o.settings.layerSet(pluginId, key as string, args[1]);
    recent.push(now);
    settingWrites.set(top, recent);
    return null;
  };
  // ---- a component's calls of the catalog's members ----
  /** The per-plugin rate, shared by calls and watches. */
  const rated = (pluginId: string) => {
    const now = Date.now();
    const w = layerWindows.get(pluginId);
    if (w === undefined || now - w.start >= 1000) layerWindows.set(pluginId, { start: now, n: 1 });
    else if (++w.n > LAYER_CALLS_PER_SECOND) throw new ContractError("refused", `${pluginId}'s UI made more than ${LAYER_CALLS_PER_SECOND} calls this second`);
  };
  const sized = (method: string, call: string, args: readonly unknown[]) => {
    const size = jsonBytes(args);
    if (size === undefined) throw new ContractError("invalid", `${method} takes JSON args`);
    const max = BIG_ARGS.has(call) ? LAYER_CALL_BIG_MAX_BYTES : LAYER_CALL_MAX_BYTES;
    if (size > max) throw new ContractError("invalid", `${method}'s args are ${size} bytes; at most ${max}`);
  };
  /** What only a host half's own process could ask is held here the same way: the account token only for the bundled
   *  `clover` tree's own components (`guardApiRouter`'s rule for its `clover` process). */
  const processRule = (pluginId: string, call: string, args: readonly unknown[]) => {
    if (cloverProcessOnly(call, args) && !isBundledClover(o.registry.get?.(pluginId))) throw new ContractError("refused", `${call} is honoured only from the bundled clover tree`);
  };
  const failed = (err: unknown, pluginId: string, call: string): never => {
    const e = toMethodError(err instanceof ContractError || err instanceof MethodError ? err : new ContractError("failed", err instanceof Error ? err.message : String(err)));
    throw new MethodError(e.code, e.message, { ...(typeof e.data === "object" && e.data !== null ? e.data : {}), pluginId, call });
  };
  /** A component's call of a member, through the router as the plugin from the `ui` side; its args read from the wire
   *  (bytes) and its answer made fit for it (bytes, a `net.fetch` response read whole and capped). `host.call`'s args
   *  are its host half's own, passed as they came. */
  const componentCall = async (pluginId: string, call: string, args: unknown[], session?: string): Promise<unknown> => {
    const refusal = layerCallRefusal(call);
    if (refusal !== undefined) throw new ContractError("refused", refusal, { call });
    processRule(pluginId, call, args);
    const input = call === "host.call" ? args : (fromLayerWire(args, { responses: false }) as unknown[]);
    if (call !== "net.fetch") {
      const out = await o.router({ pluginId, process: "ui", path: call, args: input, caller: { kind: "plugin", pluginId }, ...(session !== undefined ? { session } : {}) });
      return call === "host.call" ? out : handed(call, toLayerWire(out));
    }
    const headers = (input[1] as { headers?: unknown } | null | undefined)?.headers;
    if (Array.isArray(headers) && headers.length > LAYER_FETCH_HEADER_PAIRS) throw new ContractError("invalid", `a fetch takes at most ${LAYER_FETCH_HEADER_PAIRS} headers`);
    const top = topPluginIdOf(pluginId);
    const open = fetchesOpen.get(top) ?? 0;
    if (open >= LAYER_FETCHES_PER_PLUGIN) throw new ContractError("refused", `${top}'s pages have ${LAYER_FETCHES_PER_PLUGIN} fetches open, the most a plugin's pages may`);
    fetchesOpen.set(top, open + 1);
    try {
      const out = await o.router({ pluginId, process: "ui", path: call, args: input, caller: { kind: "plugin", pluginId }, ...(session !== undefined ? { session } : {}) });
      if (!(out instanceof Response)) return handed(call, toLayerWire(out));
      try {
        return handed(call, await responseToLayerWire(out, LAYER_FETCH_BODY_MAX));
      } catch (err) {
        throw new ContractError("refused", err instanceof Error ? err.message : String(err), { call });
      }
    } finally {
      const left = (fetchesOpen.get(top) ?? 1) - 1;
      if (left <= 0) fetchesOpen.delete(top);
      else fetchesOpen.set(top, left);
    }
  };
  /** An answer as handed to a component, refused with why past LAYER_RESULT_MAX_BYTES. */
  const handed = (call: string, wire: unknown): unknown => {
    const size = jsonBytes(wire);
    if (size !== undefined && size > LAYER_RESULT_MAX_BYTES) throw new ContractError("refused", `${call}'s answer is ${size} bytes; a component is handed at most ${LAYER_RESULT_MAX_BYTES}`, { call });
    return wire;
  };
  /** A plugin's pages' fetches open now, by top-level plugin. */
  const fetchesOpen = new Map<string, number>();

  /** The watches components hold, by id: whose, on which connection, of what, and how to end it. */
  const watches = new Map<string, { pluginId: string; follows: Map<string, () => void>; call: string; granted: string; end(reason?: string): void }>();
  /** A plugin's grants as one comparable string. */
  const grantsKey = (r: Pick<PluginRecord, "granted"> | undefined): string => JSON.stringify([...(r?.granted ?? [])].sort());
  function recheckWatches(pluginId: string): void {
    const record = o.registry.get?.(pluginId);
    for (const w of [...watches.values()]) {
      if (w.pluginId !== pluginId) continue;
      if (record === undefined) w.end(`${pluginId} was removed`);
      else if (!record.enabled) w.end(`${pluginId} was turned off`);
      else if (!RUNNING_STATES.has(record.state)) w.end(`${pluginId} is ${record.state}`);
      else if (!apiCallAllowed(w.call, "ui", record.granted)) w.end(`${pluginId}'s OK no longer lists what ${w.call} needs`);
      // Any change to its grants ends its watches too: some are judged per source when they open (`logs.follow` of
      // another plugin's log needs `logs.read`, a bot's memory `memory.read`), which the catalog's line can't say.
      else if (grantsKey(record) !== w.granted) w.end(`${pluginId}'s OK changed; watch again`);
    }
  };
  const openWatch = async (pluginId: string, call: string, args: unknown[], follows: Map<string, () => void>): Promise<string> => {
    const refusal = layerCallRefusal(call, true);
    if (refusal !== undefined) throw new ContractError("refused", refusal, { call });
    if (o.emitTo === undefined) throw new ContractError("refused", "this computer's core doesn't serve a component's watches");
    const mine = [...watches.values()];
    if (mine.filter((w) => w.follows === follows).length >= LAYER_WATCHES_PER_CONNECTION) throw new ContractError("refused", `this page has ${LAYER_WATCHES_PER_CONNECTION} watches open; close one first`);
    if (mine.filter((w) => w.pluginId === pluginId).length >= LAYER_WATCHES_PER_PLUGIN) throw new ContractError("refused", `${pluginId}'s pages have ${LAYER_WATCHES_PER_PLUGIN} watches open; close one first`);
    const at = listenerArgOf(call)!.at;
    const id = `w_${randomUUID()}`;
    const emitTo = o.emitTo;
    let open = true;
    const send = (value: unknown) => {
      if (!open) return;
      let wire = toLayerWire(value);
      const size = jsonBytes(wire);
      if (size === undefined || size > LAYER_WATCH_VALUE_MAX_BYTES) wire = { $tooLarge: size ?? -1 };
      emitTo(follows, { type: PLUGINS_EVENTS.pluginApiEvent.type, pluginId, watch: id, ...(wire === undefined ? {} : { value: wire }) });
    };
    const input = fromLayerWire(args, { responses: false }) as unknown[];
    while (input.length < at) input.push(undefined);
    input[at] = send;
    let stop: (() => void) | undefined;
    const end = (reason?: string) => {
      if (!open) return;
      open = false;
      watches.delete(id);
      follows.delete(`plugin.layer.watch:${id}`);
      try {
        stop?.();
      } catch {
        // the source is gone
      }
      // The page hears why its watch ended, unless it ended it itself or its connection closed.
      if (reason !== undefined) emitTo(follows, { type: PLUGINS_EVENTS.pluginApiEvent.type, pluginId, watch: id, ended: { reason: reason.slice(0, 500) } });
    };
    // Held before the source opens, so the caps count it and a close meanwhile ends it.
    watches.set(id, { pluginId, follows, call, granted: grantsKey(o.registry.get?.(pluginId)), end });
    follows.set(`plugin.layer.watch:${id}`, () => end());
    try {
      processRule(pluginId, call, input);
      const got = await o.router({ pluginId, process: "ui", path: call, args: input, caller: { kind: "plugin", pluginId } });
      if (typeof got !== "function") throw new ContractError("failed", `${call} gave no way to end its watch`);
      stop = got as () => void;
    } catch (err) {
      open = false;
      watches.delete(id);
      follows.delete(`plugin.layer.watch:${id}`);
      throw err;
    }
    // The connection closed (or the plugin went) while the source opened: end it now.
    if (!open) {
      try {
        stop();
      } catch {
        // gone
      }
    }
    return id;
  };

  return {
    methods: {
      [M.pluginUi.name]: handler(M.pluginUi, () => ({ plugins: uiPluginViews(o.registry, o.builds, o.userLayout) })),
      // A plugin's own UI layer, on its own connection, reaching its own plugin: its host half's handler (`host.call`),
      // a read of its synced store, or a read of its own settings (`settings.get`, `ownSettings` above). The plugin is
      // the connection's (its token's), never a parameter; the call goes through the capability gate from the `ui` side
      // as the plugin, never as the user, with no session (a layer's word about one isn't taken). Capped in size and
      // rate per plugin.
      [M.pluginLayerCall.name]: handler(M.pluginLayerCall, async (p, ctx) => {
        if (ctx.caller.kind !== "plugin") throw new ContractError("refused", "only a plugin's UI layer calls its plugin this way");
        const pluginId = ctx.caller.pluginId;
        sized("plugin.layer.call", p.call, p.args);
        rated(pluginId);
        if (p.call === "settings.get" || p.call === "settings.set") return { result: await ownSettings(pluginId, p.call, p.args) };
        try {
          return { result: await componentCall(pluginId, p.call, p.args) };
        } catch (err) {
          return failed(err, pluginId, p.call);
        }
      }),
      // A component's watch, on its own layer connection: the connection's plugin, its values to that connection alone
      // (its follows, which its close ends).
      [M.pluginLayerWatch.name]: handler(M.pluginLayerWatch, async (p, ctx) => {
        if (ctx.caller.kind !== "plugin" || ctx.stream === undefined) throw new ContractError("refused", "only a plugin's UI layer watches its plugin's API this way");
        const pluginId = ctx.caller.pluginId;
        sized("plugin.layer.watch", p.call, p.args);
        rated(pluginId);
        try {
          return { watch: await openWatch(pluginId, p.call, p.args, ctx.stream.follows) };
        } catch (err) {
          return failed(err, pluginId, p.call);
        }
      }),
      [M.pluginLayerUnwatch.name]: handler(M.pluginLayerUnwatch, (p, ctx) => {
        if (ctx.caller.kind !== "plugin" || ctx.stream === undefined) throw new ContractError("refused", "only a plugin's UI layer ends its watches this way");
        const w = watches.get(p.watch);
        if (w !== undefined && w.follows === ctx.stream.follows) w.end();
        return {};
      }),
      // A failure names the plugin and the call (never a mount: the app maps them to its own parts).
      [M.pluginLayerApi.name]: handler(M.pluginLayerApi, async (p) => {
        try {
          // A component acts as its plugin, never as the user (the coordinator's ruling on #333): `commands.run`,
          // `host.call` and every area see the plugin. The user's own gesture counts only on the app's explicit path
          // (`pill.send` inside a real key press or click, carried by the app's main process).
          return { result: await componentCall(p.pluginId, p.call, p.args, p.session) };
        } catch (err) {
          return failed(err, p.pluginId, p.call);
        }
      }),
    },
    close() {
      stop();
      for (const w of [...watches.values()]) w.end("Clover's plugins closed");
      if (timer !== undefined) {
        if (o.clock !== undefined) o.clock.clearTimeout(timer as TimerHandle);
        else clearTimeout(timer as ReturnType<typeof setTimeout>);
      }
      pending.clear();
    },
    watchCount: () => watches.size,
    // A bot changed (its user layer, or anything else; no id: every plugin, as when the bot side starts): the app reads
    // a bot's view again only when its own layout did.
    userLayoutChanged(botId?: string) {
      for (const id of botId !== undefined ? [botId] : o.registry.list().map((r) => r.id)) {
        const now = o.userLayout?.(id);
        if (userLayouts.get(id) === now) continue;
        if (now === undefined) userLayouts.delete(id);
        else userLayouts.set(id, now);
        o.log?.(`ui: ${id}'s own layout (its user layer) ${now === undefined ? "cleared" : "changed"}; the app draws its tab again`);
        nudge([id]);
      }
    },
  };
}
