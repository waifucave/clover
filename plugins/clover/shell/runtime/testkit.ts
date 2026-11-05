// Fakes for the parts' tests and the gallery: a core client that answers from a table and records each call, and a
// plugin API built from the members a test gives. No React here, so every part can use it with its own React.
import type { CardMeta, CoreClient, CoreMethods, PluginApi, PointEntry, Unsubscribe } from "./types";

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

/** A plugin API with the members given, and in-memory settings. */
export function fakeApi(
  members: Partial<Omit<PluginApi, "plugin" | "t" | "settings" | "points">> & { pluginId?: string; computer?: string; settings?: Record<string, unknown>; points?: Record<string, PointEntry[]> } = {},
): PluginApi & { readonly stored: Map<string, unknown> } {
  const { pluginId = "clover", computer = "Studio", settings = {}, points = {}, ...rest } = members;
  const stored = new Map<string, unknown>(Object.entries(settings));
  return {
    plugin: { id: pluginId, computer },
    t: (key) => key,
    settings: {
      get: async <T,>(key: string) => stored.get(key) as T | undefined,
      set: async (key, value) => void stored.set(key, value),
      watch: () => () => undefined,
    },
    commands: {
      run: async () => {
        throw new Error("no commands");
      },
    },
    points: {
      entries: async <T,>(point: string) => (points[point] ?? []) as PointEntry<T>[],
      watch: () => () => undefined,
    },
    stored,
    ...rest,
  };
}

/** The pending cards a runtime hands its parts, settable by a test. */
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
export const card = (id: string, extra: Partial<CardMeta> = {}): CardMeta => ({ id, kind: "change", computer: "Studio", options: [{ id: "approve", kind: "approve" }, { id: "deny", kind: "deny" }], ...extra });

/** Lets pending promises and the effects they start settle. */
export const settle = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};
