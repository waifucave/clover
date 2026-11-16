// Testing a plugin's parts (`@waifucave/clover-plugin-sdk/ui/testing`): the SDK's own UI runtime, set up on a fake layer
// bridge that answers from a description the test gives (which spots exist, which entries fill them, what the core and the
// plugin API answer), so a part renders and behaves as it does in Clover: its `<Spot>`s resolve and mount their entries
// inline, `useCore`, `usePluginApi`, `useUserSend`, `useComposerHost`, `useApprovals`, `useT` and `useTokens` are the
// SDK's, and what reaches the bridge is what would reach the app. Any plugin's tests and galleries may use it; it names
// no plugin. Rendering is the test's own (`@testing-library/react` or a gallery's root).
import { useMemo, type ReactNode } from "react";
import type { BotView, CardMeta, ComputerView, DeviceView, PluginDetail, PluginSummary, SessionView } from "../views";
import type { TokenValue } from "../catalogs/tokens";
import { spotInfo, STOCK_PANEL_KEYS } from "../catalogs/spots";
import type { EntryProps, UiComponent } from "../api/ui-api";
import type { PluginApi, PointEntry, Unsubscribe } from "../api/plugin-api";
import { configureLayer, LayerRoot, type ClientModule } from "./index";
import type { LayerBridge, LayerMessage, MountContext, MountInfo, SpotEntryView, SpotItem, SpotView, UserSendTarget } from "./bridge";
import type { StringTable } from "./strings";

// ---- What a test describes ----------------------------------------------------------------------------------------

export type SpotShape = "single" | "list" | "keyed";

/** A spot's declaration: its shape, and the keys it keeps (a pick of nothing doesn't hide them). */
export interface TestSpot {
  shape: SpotShape;
  keep?: readonly string[];
}

/** A `ui` entry as a manifest declares it, with where it came from (for the one-at-a-time rules). */
export interface TestEntry {
  pluginId: string;
  /** The entry's `id` (its spot when the manifest gives none). */
  id: string;
  spot: string;
  key?: string;
  order?: number;
  when?: { bot?: string | readonly string[]; session?: string | readonly string[]; os?: readonly string[]; surface?: string | readonly string[] };
  hide?: boolean;
  component?: string;
  fields?: Record<string, unknown>;
  /** Shipped with the app, or installed by the user (an installed one wins a tie). */
  source?: "bundled" | "installed";
  /** When its plugin was last switched on (the later wins a tie). */
  enabledAt?: number;
  /** The bot whose plugin this entry comes from: it counts as limited to that bot. */
  botPlugin?: string;
  pluginName?: string;
}

/** The user's picks and list orders (Clover's `ui.settings`), for the one-at-a-time and list spots. */
export interface TestUiSettings {
  picks: readonly { spot: string; key?: string | null; bot?: string; entry: string | null }[];
  lists: readonly { spot: string; bot?: string; order?: readonly string[]; hidden?: readonly string[] }[];
}

/** A core client as a part sees it (`useCore`): a fake answers from a table (`fakeCore`). */
export interface TestCore {
  call(method: string, params?: unknown): Promise<unknown>;
}

/** The composer spot's host (`useComposerHost`), each member optional. */
export type TestComposerHost = Partial<Record<"models" | "setModel" | "interrupt" | "stop" | "commands" | "runCommand" | "listenStatus" | "listenStart" | "listenStop", (...args: any[]) => Promise<unknown>>>;

/** Everything the fake layer answers from. Every member but `spot`, `entries` and `component` is optional. */
export interface TestRuntime {
  spot(name: string): TestSpot | undefined;
  readonly entries: readonly TestEntry[];
  /** The component an entry names, by its plugin and name. */
  component(pluginId: string, name: string): UiComponent<EntryProps<any>> | undefined;
  uiSettings?(): TestUiSettings;
  /** A session's kind, for `when.session`. */
  sessionKind?(session: string): string | undefined;
  /** The plugin API of a plugin's parts (`usePluginApi`): its members, called by path (`files.list`, `settings.get`…). */
  api?(pluginId: string): object | undefined;
  /** The core as a plugin's parts reach it (`useCore`, and the wire calls `usePluginApi` makes by name). */
  core?(pluginId: string): TestCore | undefined;
  /** The user's own words (`useUserSend`). */
  userSend?(pluginId: string): ((to: UserSendTarget, message: { text: string }) => Promise<unknown> | unknown) | undefined;
  composerHost?(pluginId: string): TestComposerHost | undefined;
  tokens?(): Readonly<Record<string, TokenValue>>;
  /** A plugin's strings (`useT`): the text for a key, before `{name}` placeholders are filled. */
  t?(pluginId: string, key: string, params?: Record<string, string | number>): string;
  /** The pending cards (`useApprovals`): read now, and told when they change. */
  approvals?: { cards(): readonly CardMeta[]; subscribe(listener: () => void): Unsubscribe };
  /** What a card's sealed element says (a field's words, a button's label), as the app's sealed page would: each sealed
   *  frame then shows a page with that text (a `data:` URL; `sealedTextOf` reads it back). Undefined: an empty page. */
  sealedText?(cardId: string, element: string): string | undefined;
  /** The host's OS, for `when.os` and the mount context. */
  os?: string;
  /** The rest of the mount context a part reads (`useMountContext`): the bot, the surface… */
  context?: Partial<MountContext>;
}

/** A well-known spot's declaration, from the SDK's spot catalog (its shape and the keys it keeps); undefined for a name
 *  the catalog doesn't know (a plugin's own spot is the test's to declare). */
export function catalogSpot(name: string): TestSpot | undefined {
  const info = spotInfo(name);
  return info === undefined ? undefined : { shape: info.shape, ...(info.keep !== undefined ? { keep: info.keep } : {}) };
}

/** A runtime with only some members: no spots, no entries, no components, unless given. */
export function runtimeWith(partial: Partial<TestRuntime>): TestRuntime {
  return { spot: () => undefined, entries: [], component: () => undefined, ...partial };
}

// ---- Fakes --------------------------------------------------------------------------------------------------------

export interface FakeCore extends TestCore {
  /** Every call, in order. */
  readonly calls: { method: string; params: unknown }[];
  /** A core event (`card_pending`, `session_changed`…) to every part listening with `useCore().on`. */
  emit(event: string, payload: Record<string, unknown>): void;
  on(event: string, listener: (e: Record<string, unknown>) => void): Unsubscribe;
}

/** A core client answering from `handlers`; a method with no handler fails as the core does for an unknown one. Its
 *  `emit` reaches the parts of the test layer it serves, as the core's events do. */
export function fakeCore(handlers: Record<string, (params: any) => unknown> = {}): FakeCore {
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Map<string, Set<(e: Record<string, unknown>) => void>>();
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) throw new Error(`no such method: ${method}`);
      return handler(params);
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (set === undefined) listeners.set(event, (set = new Set()));
      set.add(listener);
      return () => void set!.delete(listener);
    },
    emit(event, payload) {
      for (const l of listeners.get(event) ?? []) l({ type: event, ...payload });
      emitCoreEvent({ type: event, ...payload });
    },
  };
}

/** The pending cards, changed by the test (`set` the whole list, `raise` one, `resolve` one). */
export function fakeApprovals(initial: readonly CardMeta[] = []) {
  let cards = [...initial];
  const listeners = new Set<() => void>();
  const tell = () => { for (const l of listeners) l(); };
  return {
    cards: () => cards,
    subscribe(listener: () => void): Unsubscribe { listeners.add(listener); return () => void listeners.delete(listener); },
    set(next: readonly CardMeta[]) { cards = [...next]; tell(); },
    raise(card: CardMeta) { cards = [...cards.filter((c) => c.id !== card.id), card]; tell(); },
    resolve(id: string) { cards = cards.filter((c) => c.id !== id); tell(); },
  };
}

/** A plugin API with the members given, settings in memory (`stored`), points from a table, and every other member a
 *  stub that fails, naming what it lacks. `pluginId` names the plugin it answers as. */
export function fakeApi(
  members: Partial<Omit<PluginApi, "plugin" | "t" | "settings" | "points">> & { pluginId?: string; computer?: string; settings?: Record<string, unknown>; points?: Record<string, PointEntry[]> } = {},
): PluginApi & { readonly stored: Map<string, unknown> } {
  const { pluginId = "test.plugin", computer = "Studio", settings = {}, points = {}, ...rest } = members;
  const stored = new Map<string, unknown>(Object.entries(settings));
  const none = (what: string) => async () => {
    throw new Error(`the fake API has no ${what}`);
  };
  const api = {
    plugin: { id: pluginId, namespace: pluginId.split(/[/.]/)[0]!, version: "0.0.0", computer },
    t: (key: string) => key,
    settings: {
      get: async <T,>(key: string) => stored.get(key) as T | undefined,
      set: async (key: string, value: unknown) => void stored.set(key, value),
      watch: () => () => undefined,
    },
    commands: { run: none("commands.run"), list: async () => [] },
    memory: { list: none("memory.list"), read: none("memory.read") },
    routines: { list: none("routines.list"), runs: none("routines.runs"), fire: none("routines.fire") },
    logs: { read: none("logs.read"), follow: () => () => undefined },
    turns: { take: none("turns.take"), done: none("turns.done"), extend: none("turns.extend"), state: none("turns.state"), watch: () => () => undefined },
    streams: { open: none("streams.open"), accept: () => Object.assign(() => undefined, { opened: Promise.resolve() }), write: none("streams.write"), end: none("streams.end"), cancel: none("streams.cancel"), ack: none("streams.ack") },
    points: {
      entries: async <T,>(point: string) => (points[point] ?? []) as PointEntry<T>[],
      watch: () => () => undefined,
      call: none("point handlers"),
      stream: none("point handlers' streams"),
      active: async () => undefined,
      onActive: () => () => undefined,
    },
    host: { call: none("host half"), on: () => () => undefined },
    ui: { send: () => undefined },
    storage: { synced: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [], watch: () => () => undefined } },
    net: { fetch: none("network") },
    confirm: async () => false,
    stored,
    ...rest,
  };
  return api as unknown as PluginApi & { readonly stored: Map<string, unknown> };
}

/** The `files` member from the calls a test gives; the rest fail. */
export function fakeFiles(members: Partial<NonNullable<PluginApi["files"]>>): NonNullable<PluginApi["files"]> {
  const no = async () => {
    throw new Error("the fake files API has no such call");
  };
  return { stat: no, readText: no, readBytes: no, write: no, list: no, remove: no, move: no, glob: no, grep: no, ...members } as NonNullable<PluginApi["files"]>;
}

// The core's views with every field, for fixtures: what a test cares about, over plain defaults.
export const botView = (id: string, name: string, extra: Partial<BotView> = {}): BotView => ({ id, name, model: "openai/gpt-6", userLayer: [], state: "idle", mainSession: `s_${id}`, ...extra });
export const sessionView = (id: string, extra: Partial<SessionView> = {}): SessionView =>
  ({ id, kind: "agent", computer: "Studio", status: "idle", startedAt: 0, updatedAt: 0, ...extra }) as SessionView;
export const computerView = (name: string, extra: Partial<ComputerView> = {}): ComputerView =>
  ({ name, aliases: [], device: `d-${name}`, os: "macos", hasDisplay: true, agents: [], level: "ask", state: "online", isMain: false, ...extra }) as ComputerView;
export const deviceView = (id: string, name: string, extra: Partial<DeviceView> = {}): DeviceView =>
  ({ id, name, kind: "desktop", runsCore: true, online: true, isThis: false, isMain: false, addedAt: 0, ...extra }) as DeviceView;
export const pluginSummary = (id: string, name: string, extra: Partial<PluginSummary> = {}): PluginSummary =>
  ({ id, name, version: "1.0.0", state: "running", enabled: true, source: "bundled", class: "code", namespace: id.split("/")[0]!, scope: "both", adult: false, children: [], dev: false, ...extra }) as PluginSummary;
export const pluginDetail = (summary: PluginSummary, extra: Partial<PluginDetail> = {}): PluginDetail =>
  ({ ...summary, manifest: {}, provenance: { by: "user-app", at: 0 }, capabilities: [], networkHosts: [], helperPermissions: [], issues: [], logTail: [], pinned: false, ...extra }) as PluginDetail;
/** A card as a plugin hears of it. */
export const card = (id: string, extra: Partial<CardMeta> = {}): CardMeta => ({
  id, kind: "change", computer: "Studio", origin: "user", issuedAt: 0, expiresAt: null,
  options: [{ id: "approve", kind: "approve" }, { id: "deny", kind: "deny" }], ...extra,
} as CardMeta);

/** The text a test layer's sealed frame shows (its `sealedText`), read back from the frame's address; undefined for a
 *  frame with none. */
export function sealedTextOf(frame: Element): string | undefined {
  const src = frame.getAttribute("src") ?? "";
  if (!src.startsWith("data:text/html")) return undefined;
  const html = decodeURIComponent(src.slice(src.indexOf(",") + 1));
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
  return body.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)));
}

/** Lets the promises a render started settle (a few rounds of the microtask queue). */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

// ---- Resolution (the app's rules for a spot, on the test's entries) ----------------------------------------------

interface Ctx { bot?: string; sessionKind?: string; os?: string; surface?: string }

const asList = <T,>(v: T | readonly T[] | undefined): readonly T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? (v as readonly T[]) : [v as T]);
export const entryRef = (e: Pick<TestEntry, "pluginId" | "id">) => `${e.pluginId}#${e.id}`;

/** Whether an entry's `when` holds in a context. A condition the context can't answer doesn't hold. */
export function applies(e: TestEntry, ctx: Ctx): boolean {
  const bots = asList(e.when?.bot) ?? (e.botPlugin !== undefined ? [e.botPlugin] : undefined);
  if (bots && (ctx.bot === undefined || !bots.includes(ctx.bot))) return false;
  const sessions = asList(e.when?.session);
  if (sessions && (ctx.sessionKind === undefined || !sessions.includes(ctx.sessionKind))) return false;
  if (e.when?.os && (ctx.os === undefined || !e.when.os.includes(ctx.os))) return false;
  const surfaces = asList(e.when?.surface);
  if (surfaces && (ctx.surface === undefined || !surfaces.includes(ctx.surface))) return false;
  return true;
}

/** How well an entry's key covers a key: 3 exact, 2 a `*` pattern, 1 no key, 0 not at all. */
export function keyFit(entryKey: string | undefined, key: string): number {
  if (entryKey === undefined) return 1;
  if (entryKey.endsWith("*")) return key.startsWith(entryKey.slice(0, -1)) ? 2 : 0;
  return entryKey === key ? 3 : 0;
}

function botSpecificity(e: TestEntry): number {
  const bots = asList(e.when?.bot) ?? (e.botPlugin !== undefined ? [e.botPlugin] : undefined);
  return bots === undefined ? 1 : bots.length === 1 ? 3 : 2;
}

/** The entries a spot shows in a context, by the app's rules (a list's order and hiding; one-at-a-time picks, then the
 *  most specific, an installed one, the latest switched on), and whether a tie was left (a conflict). */
export function resolveSpot(spot: string, decl: TestSpot, all: readonly TestEntry[], ctx: Ctx, key?: string, settings?: TestUiSettings): { entries: TestEntry[]; conflict: boolean } {
  const here = all.filter((e) => e.spot === spot && applies(e, ctx));
  const order = (a: TestEntry, b: TestEntry) => (a.order ?? 500) - (b.order ?? 500) || a.pluginId.localeCompare(b.pluginId) || a.id.localeCompare(b.id);
  if (decl.shape === "list") {
    const list = settings?.lists.find((l) => l.spot === spot && l.bot === ctx.bot) ?? settings?.lists.find((l) => l.spot === spot && l.bot === undefined);
    const hidden = new Set(list?.hidden ?? []);
    const shown = here.filter((e) => !e.hide && !hidden.has(entryRef(e)));
    const placed = new Map((list?.order ?? []).map((ref, i) => [ref, i] as const));
    shown.sort((a, b) => {
      const pa = placed.get(entryRef(a));
      const pb = placed.get(entryRef(b));
      if (pa !== undefined || pb !== undefined) return (pa ?? Number.MAX_SAFE_INTEGER) - (pb ?? Number.MAX_SAFE_INTEGER);
      return order(a, b);
    });
    return { entries: shown, conflict: false };
  }
  if (spot === "panel" && key === "*") {
    return { entries: here.filter((e) => !e.hide && e.key !== undefined && !STOCK_PANEL_KEYS.includes(e.key) && !e.key.endsWith("*")).sort(order), conflict: false };
  }
  const kept = key !== undefined && (decl.keep ?? []).includes(key);
  let candidates = here.filter((e) => !(kept && e.hide));
  if (decl.shape === "keyed") {
    if (key === undefined) return { entries: [], conflict: false };
    const best = Math.max(0, ...candidates.map((e) => keyFit(e.key, key)));
    candidates = best === 0 ? [] : candidates.filter((e) => keyFit(e.key, key) === best);
  }
  if (candidates.length === 0) return { entries: [], conflict: false };
  const pickFor = (bot: string | undefined) => settings?.picks.find((p) => p.spot === spot && (p.key ?? undefined) === key && p.bot === bot);
  const pick = (ctx.bot !== undefined ? pickFor(ctx.bot) : undefined) ?? pickFor(undefined);
  if (pick) {
    if (pick.entry === null && !kept) return { entries: [], conflict: false };
    const picked = candidates.find((e) => entryRef(e) === pick.entry);
    if (picked) return { entries: picked.hide ? [] : [picked], conflict: false };
  }
  const ranked = [...candidates].sort((a, b) => botSpecificity(b) - botSpecificity(a) || Number(b.source === "installed") - Number(a.source === "installed") || (b.enabledAt ?? 0) - (a.enabledAt ?? 0));
  const [first, second] = ranked;
  const conflict = second !== undefined && botSpecificity(first!) === botSpecificity(second) && (first!.source ?? "bundled") === (second.source ?? "bundled");
  return { entries: first!.hide ? [] : [first!], conflict };
}

// ---- The fake layer bridge ----------------------------------------------------------------------------------------

/** What a test can see of the bridge: each call that reached it, in order, by kind. */
export interface TestLayerLog {
  readonly calls: { kind: string; mount: string; pluginId: string; args: unknown[] }[];
}

let current: { emit(m: LayerMessage): void; pluginIds(): readonly string[]; log: TestLayerLog } | undefined;

/** What reached the current test layer's bridge, in order (of one `kind` when given: `viewFrame`, `open`, `menu`,
 *  `windowDrag`, `userSend`, `api`…), each with the part's mount and plugin and the call's arguments. */
export function bridgeCalls(kind?: string): TestLayerLog["calls"] {
  const all = current?.log.calls ?? [];
  return kind === undefined ? all : all.filter((c) => c.kind === kind);
}

/** A layer message to the current test layer's parts (an app command, `respot`, a core event as `api-event`). */
export function emitLayerMessage(m: LayerMessage): void {
  current?.emit(m);
}

function emitCoreEvent(e: Record<string, unknown>): void {
  if (current === undefined) return;
  for (const pluginId of current.pluginIds()) current.emit({ type: "api-event", pluginId, method: "core.event", params: e });
}

const OS = (os: string | undefined): MountContext["os"] => (os === "windows" || os === "linux" ? os : "macos");

/** Sets up the SDK's runtime on a fake bridge answering from `runtime`. `TestLayer` does this for its children; a gallery
 *  that renders several roots calls it once. */
export function setUpTestLayer(runtime: TestRuntime, root: { pluginId: string; entryId: string; spot: string; key?: string }): { info: MountInfo; log: TestLayerLog } {
  const mounts = new Map<string, { pluginId: string; context: MountContext }>();
  const listeners = new Set<(m: LayerMessage) => void>();
  const log: TestLayerLog = { calls: [] };
  let n = 0;
  const baseContext: MountContext = { os: OS(runtime.os), material: "none", safeMode: false, window: { narrow: false }, ...runtime.context };
  const rootMount = "test-root";
  mounts.set(rootMount, { pluginId: root.pluginId, context: baseContext });
  const pluginOf = (mount: string) => mounts.get(mount)?.pluginId ?? root.pluginId;
  const note = (kind: string, mount: string, args: unknown[]) => log.calls.push({ kind, mount, pluginId: pluginOf(mount), args });
  const pluginIds = () => [...new Set([root.pluginId, ...runtime.entries.map((e) => e.pluginId)])];
  const modules: Record<string, ClientModule> = {};
  for (const id of pluginIds()) {
    modules[id] = new Proxy({}, { get: (_t, name) => (name === TEST_ROOT && id === root.pluginId ? RootChildren : typeof name === "string" ? runtime.component(id, name) : undefined) }) as ClientModule;
  }
  const strings = (pluginId: string): StringTable => ({
    lang: "en",
    strings: new Proxy({} as Record<string, string>, { get: (_t, key) => (typeof key === "string" && runtime.t !== undefined ? runtime.t(pluginId, key) : undefined) }),
  } as StringTable);
  const ctxOf = (mount: string, hints?: { session?: string; bot?: string }): Ctx => {
    const c = mounts.get(mount)?.context ?? baseContext;
    const session = hints?.session ?? c.session;
    const kind = session === undefined ? undefined : runtime.sessionKind?.(session) ?? session;
    return { bot: hints?.bot ?? c.bot, sessionKind: kind, os: runtime.os ?? c.os, surface: c.surface };
  };
  let cardsSeen = new Map<string, CardMeta>();
  const emit = (m: LayerMessage) => { for (const l of [...listeners]) l(m); };
  runtime.approvals?.subscribe(() => {
    const now = new Map(runtime.approvals!.cards().map((c) => [c.id, c] as const));
    for (const id of pluginIds()) {
      for (const [cid, c] of now) if (!cardsSeen.has(cid)) emit({ type: "api-event", pluginId: id, method: "core.event", params: { type: "card_pending", card: c } });
      for (const cid of cardsSeen.keys()) if (!now.has(cid)) emit({ type: "api-event", pluginId: id, method: "core.event", params: { type: "card_resolved", id: cid } });
    }
    cardsSeen = now;
  });
  const callPath = (target: object | undefined, path: string, args: unknown[]): unknown => {
    let host: any = target;
    const parts = path.split(".");
    for (const p of parts.slice(0, -1)) host = host?.[p];
    const fn = host?.[parts.at(-1)!];
    if (typeof fn !== "function") throw new Error(`the test's plugin API has no ${path}`);
    return fn.apply(host, args);
  };
  const bridge: LayerBridge = {
    token: undefined,
    describe: async () => info,
    async resolve(mount, spot, key, hints) {
      note("resolve", mount, [spot, key, hints]);
      const decl = runtime.spot(spot);
      if (decl === undefined) return { spot, ...(key !== undefined ? { key } : {}), shape: "single", items: [], hidden: false, conflict: false, undeclared: true } satisfies SpotView;
      const ctx = ctxOf(mount, hints);
      let { entries, conflict } = resolveSpot(spot, decl, runtime.entries, ctx, key, runtime.uiSettings?.());
      if (hints?.entry !== undefined) entries = entries.filter((e) => entryRef(e) === hints.entry);
      const parent = mounts.get(mount)?.context ?? baseContext;
      const items: SpotItem[] = entries.filter((e) => e.component !== undefined && runtime.component(e.pluginId, e.component) !== undefined).map((e) => {
        const child = `test-m${++n}`;
        const context: MountContext = { ...parent, ...(ctx.bot !== undefined ? { bot: ctx.bot } : {}), ...(hints?.session !== undefined ? { session: hints.session } : {}) };
        mounts.set(child, { pluginId: e.pluginId, context });
        return { kind: "inline", mount: child, ref: entryRef(e), pluginId: e.pluginId, entryId: e.id, component: e.component!, context, ...(runtime.tokens !== undefined ? { tokens: runtime.tokens() } : {}) };
      });
      return { spot, ...(key !== undefined ? { key } : {}), shape: decl.shape, items, hidden: false, conflict };
    },
    async entries(mount, spot, key, bot, session): Promise<readonly SpotEntryView[]> {
      note("entries", mount, [spot, key, bot, session]);
      const decl = runtime.spot(spot);
      if (decl === undefined) return [];
      const { entries } = resolveSpot(spot, decl, runtime.entries, ctxOf(mount, { ...(bot !== undefined ? { bot } : {}), ...(session !== undefined ? { session } : {}) }), key, runtime.uiSettings?.());
      return entries.map((e) => ({ ref: entryRef(e), id: e.id, pluginId: e.pluginId, pluginName: e.pluginName ?? e.pluginId, bundled: (e.source ?? "bundled") === "bundled", ...(e.key !== undefined ? { key: e.key } : {}), fields: e.fields ?? {} }));
    },
    setProps: (child, props) => note("setProps", child, [props]),
    speech: (child, m) => note("speech", child, [m]),
    avatar: (child, m) => note("avatar", child, [m]),
    avatarUp: (m) => note("avatarUp", rootMount, [m]),
    callback: (id, args) => note("callback", rootMount, [id, args]),
    reportSize: () => undefined,
    release: (gone) => { for (const m of gone) mounts.delete(m); },
    reload: async () => undefined,
    sleep: () => undefined,
    wake: async () => undefined,
    rectReply: () => undefined,
    menu: async (mount, items, x, y) => { note("menu", mount, [items, x, y]); return null; },
    surface: (request) => note("surface", rootMount, [request]),
    surfaceEnvironment: async () => undefined,
    open: async (mount, target) => void note("open", mount, [target]),
    viewFrame: (mount, name, rect, used) => note("viewFrame", mount, [name, rect, used]),
    webFrame: (mount, rect) => note("webFrame", mount, [rect]),
    activeSession: (mount, session) => note("activeSession", mount, [session]),
    windowDrag: (mount) => note("windowDrag", mount, []),
    async composer(mount, op, args) {
      note("composer", mount, [op, args]);
      const host = runtime.composerHost?.(pluginOf(mount));
      const fn = host?.[op];
      if (fn === undefined) throw new Error(`the test's composer host has no ${op}`);
      const a = args as Record<string, unknown> | undefined;
      if (op === "setModel") return fn(a?.model, a?.effort);
      if (op === "runCommand") return fn(a?.name, a?.args);
      return fn();
    },
    async shell(mount, method, args) {
      note("shell", mount, [method, args]);
      const answer = await runtime.core?.(pluginOf(mount))?.call(`shell.${method}`, args ?? {}).catch(() => undefined);
      return answer;
    },
    shellReport: (mount, report) => note("shellReport", mount, [report]),
    async api(mount, method, params) {
      note("api", mount, [method, params]);
      const pluginId = pluginOf(mount);
      if (method === "events.subscribe") return {};
      // The pending cards are the layer's (the test's `approvals`, none when it gives none), never a core call of the part's.
      if (method === "card.pending") return { cards: runtime.approvals?.cards() ?? [] };
      if (method === "plugin.layer.call") {
        const p = params as { call: string; args?: unknown[] };
        return { result: await callPath(runtime.api?.(pluginId), p.call, p.args ?? []) };
      }
      const core = runtime.core?.(pluginId);
      if (core === undefined) throw new Error(`the test gives ${pluginId} no core (${method})`);
      return core.call(method, params);
    },
    terminalInput: async (mount, terminalId, input) => void note("terminalInput", mount, [terminalId, input]),
    async userSend(mount, to, message) {
      note("userSend", mount, [to, message]);
      const send = runtime.userSend?.(pluginOf(mount));
      if (send === undefined) throw new Error("the test gives no userSend");
      await send(to, { text: message.text });
      return {};
    },
    dragOffer: async () => ({ error: "no drags in a test layer" }),
    dragClaim: async () => ({ error: "no drags in a test layer" }),
    sealedFrame: async (mount, cardId, element, look) => {
      note("sealedFrame", mount, [cardId, element, look]);
      const text = runtime.sealedText?.(cardId, element);
      return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><body style="margin:0;font:14px system-ui">${(text ?? "").replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</body>`)}`;
    },
    onMessage(listener) { listeners.add(listener); return () => void listeners.delete(listener); },
  };
  const info: MountInfo = {
    mount: rootMount,
    pluginId: root.pluginId,
    entryId: root.entryId,
    component: TEST_ROOT,
    spot: root.spot,
    ...(root.key !== undefined ? { key: root.key } : {}),
    props: {},
    tokens: runtime.tokens?.() ?? {},
    context: baseContext,
    css: [],
    strings: strings(root.pluginId),
  };
  configureLayer({ bridge, modules, ...(runtime.api !== undefined ? { testApi: (pluginId: string) => runtime.api!(pluginId) as PluginApi | undefined } : {}) });
  if (runtime.approvals !== undefined) cardsSeen = new Map(runtime.approvals.cards().map((c) => [c.id, c] as const));
  current = { emit, pluginIds, log };
  return { info, log };
}

const TEST_ROOT = "__testRoot";
let rootChildren: ReactNode = null;

/** Renders `children` as a part of `pluginId` (the entry `entry`, in the spot `spot`) on a test layer set up from
 *  `runtime`: every SDK hook in them is the real one, answered by the fake bridge. */
export function TestLayer({ runtime, pluginId = "test.plugin", entry, spot = "main", spotKey, children }: { runtime: TestRuntime; pluginId?: string; entry?: string; spot?: string; spotKey?: string; children?: ReactNode }) {
  const info = useMemo(() => {
    return setUpTestLayer(runtime, { pluginId, entryId: entry ?? spot, spot, ...(spotKey !== undefined ? { key: spotKey } : {}) }).info;
  }, [runtime, pluginId, entry, spot, spotKey]);
  rootChildren = children;
  return <LayerRoot info={info} />;
}

function RootChildren(): ReactNode {
  return rootChildren;
}
