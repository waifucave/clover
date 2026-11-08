// Fakes for the parts' tests and the gallery: a core client that answers from a table and records each call, and a
// plugin API built from the members a test gives. No React here, so every part can use it with its own React.
import type { BotView, CardMeta, ComputerView, CoreClient, CoreMethods, DeviceView, FilesWithWatch, PluginApi, PluginDetail, PluginSummary, PointEntry, SessionView, UiPluginView, Unsubscribe } from "./types";

export type CoreHandlers = { [M in keyof CoreMethods]?: (params: CoreMethods[M]["params"]) => CoreMethods[M]["result"] | Promise<CoreMethods[M]["result"]> };

export interface FakeCore extends CoreClient {
  /** Every call, in order: its method and params. */
  readonly calls: { method: string; params: unknown }[];
  /** Hands an event to every listener of its type. */
  emit(event: string, payload: Record<string, unknown>): void;
}

/** A core client answering from `handlers`; a method with no handler fails as the core would for an unknown one. */
export function fakeCore(handlers: CoreHandlers = {}): FakeCore {
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      const handler = handlers[method] as ((p: unknown) => unknown) | undefined;
      if (!handler) throw new Error(`no such method: ${method}`);
      return (await handler(params)) as never;
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
      return () => void set!.delete(listener);
    },
    emit(event, payload) {
      for (const l of listeners.get(event) ?? []) l(payload);
    },
  };
}

/** A plugin API with the members given, in-memory settings, and the rest of B's members as stubs that fail. */
export function fakeApi(
  members: Partial<Omit<PluginApi, "plugin" | "t" | "settings" | "points">> & { pluginId?: string; computer?: string; settings?: Record<string, unknown>; points?: Record<string, PointEntry[]> } = {},
): PluginApi & { readonly stored: Map<string, unknown> } {
  const { pluginId = "clover", computer = "Studio", settings = {}, points = {}, ...rest } = members;
  const stored = new Map<string, unknown>(Object.entries(settings));
  const none = (what: string) => async () => {
    throw new Error(`the fake API has no ${what}`);
  };
  const api: PluginApi & { readonly stored: Map<string, unknown> } = {
    plugin: { id: pluginId, namespace: pluginId.split("/")[0]!, version: "0.0.0", computer },
    t: (key) => key,
    settings: {
      get: async <T,>(key: string) => stored.get(key) as T | undefined,
      set: async (key, value) => void stored.set(key, value),
      watch: () => () => undefined,
    },
    commands: { run: none("commands"), list: async () => [] },
    points: {
      entries: async <T,>(point: string) => (points[point] ?? []) as PointEntry<T>[],
      watch: () => () => undefined,
      call: none("point handlers"),
    },
    host: { call: none("host half"), on: () => () => undefined },
    ui: { send: () => undefined },
    storage: { synced: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [], watch: () => () => undefined } },
    net: { fetch: none("network") },
    confirm: async () => false,
    stored,
    ...rest,
  };
  return api;
}

/** B's `files` from the members a test gives (lane J's `watch` among them); the rest fail. */
export function fakeFiles(members: Partial<FilesWithWatch>): NonNullable<PluginApi["files"]> {
  const no = async () => {
    throw new Error("the fake files API has no such call");
  };
  return { stat: no, readText: no, readBytes: no, write: no, list: no, remove: no, move: no, glob: no, grep: no, ...members } as NonNullable<PluginApi["files"]>;
}

// B's views with every field, for fixtures: what a test cares about, over plain defaults.
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

/** The pending cards a runtime hands its parts, settable by a test. */
/** A running plugin's UI as `plugin.ui` lists it: its themes and string tables, the rest left plain. */
export const uiPluginView = (pluginId: string, themes: { id: string; file: string }[] = [], locales: { lang: string; file: string }[] = []): UiPluginView =>
  ({ pluginId, name: pluginId, treeHash: "sha256-test", layer: pluginId.split("/")[0]!, assetBase: `clover-asset://${pluginId}/`, ui: [], themes, locales, bots: "all" });

export function fakeApprovals(initial: CardMeta[] = []) {
  let cards = initial;
  const listeners = new Set<() => void>();
  return {
    cards: () => cards,
    subscribe(listener: () => void): Unsubscribe {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: CardMeta[]) {
      cards = next;
      for (const l of listeners) l();
    },
  };
}

/** A card as a plugin hears of it. */
export const card = (id: string, extra: Partial<CardMeta> = {}): CardMeta => ({
  id, kind: "change", computer: "Studio", origin: "user", issuedAt: 0, expiresAt: null,
  options: [{ id: "approve", kind: "approve" }, { id: "deny", kind: "deny" }], ...extra,
});

/** Lets pending promises and the effects they start settle. */
export const settle = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};
