// A stand-in for lane E's `@waifucave/clover-plugin-sdk/ui` (B's `UiApi`, ui-api.ts), until E-M1 lands. Each part's
// `client/sdk.ts` builds it from its own React (`uiFor(React)`), so a part's tests use the part's own React, and the
// gallery, which bundles every part with one React, gets one instance and one set of contexts. When E's module lands,
// every `client/sdk.ts` becomes `export * from "@waifucave/clover-plugin-sdk/ui"`, and no component changes.
//
// What it does, as E's runtime will:
// - `<Spot>` mounts the entries that show in a spot (`resolve.ts`), inline, each with its spot's props, the part's
//   tokens and which entry it is. The tab's bot and the session's kind flow down to the spots inside, for `when`.
// - `usePluginApi()` is the calling entry's own plugin's API, with only the members its capabilities give.
// - `useCore()` is the core client, for the `clover` tree only (the `clover` layer's role is the app's, §5.5). It is
//   not in B's declarations: how the `clover` layer reaches the core is a question for B and E.
// - `<Card>` and `<AppView>` draw what the host's sealed renderers draw; nothing comes back out of them.
//
// Written with `createElement`, not JSX, so this file never imports a React of its own.
import type { ReactNode } from "react";
import { entryRef, resolveSpot, type Resolved, type SpotContext, type SpotDecl, type UiEntry } from "./resolve";
import type {
  AppViewProps, CardButtonProps, CardElementProps, CardFieldProps, CardMeta, CoreClient, EntryComponent, EntryRef, PluginApi, SessionKind, SpotElementProps, TokenValue, UiApi, UiSettings,
  Unsubscribe,
} from "./types";

/** The parts of React this file uses. Structural, so a part with its own copy of React's types can pass its React. */
export interface ReactLike {
  createContext<T>(value: T): any;
  createElement(type: any, props?: any, ...children: any[]): any;
  Fragment: any;
  useContext<T>(context: any): T;
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useState<S>(initial: S): [S, (next: S | ((prev: S) => S)) => void];
  useRef<T>(initial: T): { current: T };
}

/** Every sealed field a card may have, in B's order (`CARD_FIELD_NAMES`; the stand-in keeps no runtime import). */
export type SealedField = CardFieldProps["name"];
export const SEALED_FIELDS: readonly SealedField[] = ["title", "what", "command", "computer", "risk", "reason", "source", "host", "paths", "detail", "expires"];

export type { CardButtonProps };


/** What draws sealed frames and MCP Apps pages: the core's own frames in the app, a mock in the gallery. */
export interface SealedRenderers {
  Card(props: { id: string; children: ReactNode; className?: string }): ReactNode;
  CardField(props: CardFieldProps): ReactNode;
  CardApprove(props: CardButtonProps): ReactNode;
  CardDeny(props: CardButtonProps): ReactNode;
  AppView(props: AppViewProps): ReactNode;
}

/** What a host (the app's plugin runtime; here the gallery or a test) hands the parts. */
export interface UiRuntime {
  /** A spot's declaration: its shape, and the keys it keeps. Undeclared spots show nothing. */
  spot(name: string): SpotDecl | undefined;
  /** Every `ui` entry of every running plugin. */
  readonly entries: readonly UiEntry[];
  /** The component an entry names, from its plugin's client module. */
  component(pluginId: string, name: string): EntryComponent | undefined;
  /** The user's picks and list orders (`ui.settings`). */
  uiSettings?(): Pick<UiSettings, "picks" | "lists">;
  /** A session's kind, for `when.session`. */
  sessionKind?(session: string): SessionKind | undefined;
  api(pluginId: string): PluginApi;
  core?(pluginId: string): CoreClient | undefined;
  tokens?(): Readonly<Record<string, TokenValue>>;
  t?(pluginId: string, key: string, params?: Record<string, string | number>): string;
  approvals?: { cards(): readonly CardMeta[]; subscribe(listener: () => void): Unsubscribe };
  sealed?: SealedRenderers;
  /** The host's OS, for `when.os`. */
  os?: string;
  /** A menu the app draws for a part, natively (lane E's `useMenu`): resolves with the id picked, or null. */
  menu?(items: readonly MenuItem[], at: { x: number; y: number }): Promise<string | null>;
  /** The app's messages to this document (lane E's `useLayerMessage`): its commands, such as `open-settings`. */
  messages?: { subscribe(listener: (m: LayerCommand) => void): Unsubscribe };
}

/** An item of a menu the app draws for a part (lane E's `MenuItem`): data only. */
export interface MenuItem {
  id?: string;
  label?: string;
  enabled?: boolean;
  checked?: boolean;
  type?: "normal" | "separator" | "checkbox";
  submenu?: MenuItem[];
}

/** One of the app's commands to a window (lane E's `LayerMessage` of type `command`). */
export interface LayerCommand {
  type: string;
  name?: string;
  args?: Record<string, string | undefined>;
}

/** A runtime with only some members, the rest empty: a test that needs only sealed frames, say. */
export function runtimeWith(partial: Partial<UiRuntime>): UiRuntime {
  return {
    spot: () => undefined,
    entries: [],
    component: () => undefined,
    api: () => {
      throw new Error("this runtime has no plugin API");
    },
    ...partial,
  };
}

/** The plugin tree whose components may call the core directly (the `clover` layer). */
export const isCloverTree = (pluginId: string) => pluginId === "clover" || pluginId.startsWith("clover/");

const fill = (text: string, params?: Record<string, string | number>) => (params ? text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : text);

export interface Ui {
  Spot(props: SpotElementProps): ReactNode;
  Card: ((props: CardElementProps) => ReactNode) & {
    Field(props: CardFieldProps): ReactNode;
    Approve(props: CardButtonProps): ReactNode;
    Deny(props: CardButtonProps): ReactNode;
  };
  AppView(props: { call: { session: string; callId: string }; className?: string }): ReactNode;
  usePluginApi(): PluginApi;
  useCore(): CoreClient | undefined;
  useTokens(): Readonly<Record<string, TokenValue>>;
  useT(): (key: string, params?: Record<string, string | number>) => string;
  useApprovals(): { readonly cards: readonly CardMeta[]; subscribe(listener: () => void): Unsubscribe };
  /** The entry this component renders as, when it renders as one. */
  useEntry(): EntryRef | undefined;
  /** For hosts: the gallery and the tests. Not part of B's API. */
  UiRuntimeProvider(props: { runtime: UiRuntime; children?: ReactNode }): ReactNode;
  /** Which entries a spot would show here, for a part that lays them out itself (a list spot's buttons). */
  useSpotEntries(name: string, spotKey?: string, props?: Record<string, unknown>): Resolved;
  useLayerMessage(listener: (m: LayerCommand) => void): void;
  /** Shows a menu the app draws (lane E's `useMenu`); with no app around it, nothing is picked. */
  useMenu(): (items: readonly MenuItem[], at: { x: number; y: number }) => Promise<string | null>;
}

const built = new WeakMap<object, Ui>();

/** The UI API, built from the caller's React. One per React, so every part in one bundle shares its contexts. */
export function uiFor(react: ReactLike): Ui {
  const cached = built.get(react);
  if (cached) return cached;
  const { createContext, createElement, useContext, useEffect, useRef, useState } = react;

  const RuntimeContext = createContext<UiRuntime | null>(null);
  const EntryContext = createContext<{ entry: EntryRef; ctx: SpotContext } | null>(null);

  type Scope = { entry: EntryRef; ctx: SpotContext } | null;
  const useRuntime = () => useContext<UiRuntime | null>(RuntimeContext);
  const useScope = () => useContext<Scope>(EntryContext);
  const pluginOf = (scope: { entry: EntryRef } | null) => scope?.entry.pluginId ?? "clover";

  function contextFor(runtime: UiRuntime, props: Record<string, unknown>, parent: SpotContext | undefined): SpotContext {
    // A bot as a reference (`{ id, name }`), or by its id alone (the `panel` spot's `bot`).
    const bot = typeof props.bot === "string" ? props.bot : (props.bot as { id?: unknown } | undefined)?.id;
    const session = props.session;
    const kind = (props.sessionKind as SessionKind | undefined) ?? (typeof session === "string" ? runtime.sessionKind?.(session) : undefined);
    return {
      bot: typeof bot === "string" ? bot : parent?.bot,
      sessionKind: kind ?? parent?.sessionKind,
      os: runtime.os,
      surface: parent?.surface,
    };
  }

  function resolveIn(runtime: UiRuntime, name: string, spotKey: string | undefined, ctx: SpotContext): Resolved {
    const decl = runtime.spot(name);
    if (!decl) return { entries: [], conflict: false };
    return resolveSpot(name, decl, runtime.entries, ctx, spotKey, runtime.uiSettings?.());
  }

  const CONTENTS = { display: "contents" } as const;

  function Spot({ name, spotKey, props = {}, fallback, only }: SpotElementProps): ReactNode {
    const runtime = useRuntime();
    const parent = useScope();
    if (!runtime) return fallback ?? null;
    const ctx = contextFor(runtime, props, parent?.ctx);
    const resolved = resolveIn(runtime, name, spotKey, ctx).entries;
    const entries = only === undefined ? resolved : resolved.filter((e) => entryRef(e) === only);
    const mounted = entries.flatMap((e) => {
      const component = e.component ? runtime.component(e.pluginId, e.component) : undefined;
      if (!component) return [];
      const entry: EntryRef = { pluginId: e.pluginId, id: e.id, spot: name, ...(spotKey !== undefined ? { key: spotKey } : {}) };
      return [
        createElement(
          "div",
          // A plugin outside the `clover` tree draws in its own sealed frame in the app (lane E's `LayerFrame`), never in
          // the declaring part's document: marked here so a part's tests can see where it would.
          { key: entryRef(e), "data-clover-entry": entryRef(e), ...(isCloverTree(e.pluginId) ? {} : { "data-clover-frame": "" }), style: CONTENTS },
          createElement(EntryContext.Provider, { value: { entry, ctx } }, createElement(component, { props, tokens: runtime.tokens?.() ?? {}, entry })),
        ),
      ];
    });
    // The same elements lane E's `<Spot>` wraps a spot and each entry in (`display: contents`), so the parts' CSS is
    // proven here against the DOM it meets in the app (review S5).
    const at = { "data-clover-spot": name, ...(spotKey !== undefined ? { "data-clover-key": spotKey } : {}), style: CONTENTS };
    if (mounted.length === 0) return fallback === undefined ? null : createElement("div", { ...at, "data-clover-empty": "" }, fallback);
    return createElement("div", at, ...mounted);
  }

  function useSpotEntries(name: string, spotKey?: string, props: Record<string, unknown> = {}): Resolved {
    const runtime = useRuntime();
    const parent = useScope();
    if (!runtime) return { entries: [], conflict: false };
    return resolveIn(runtime, name, spotKey, contextFor(runtime, props, parent?.ctx));
  }

  const unavailable = () => createElement("div", { "data-sealed-unavailable": "" }, "This approval card can only show in Clover's own window.");

  function CardRoot(props: CardElementProps): ReactNode {
    const sealed = useRuntime()?.sealed;
    return sealed ? sealed.Card({ ...props, children: props.children as ReactNode }) : unavailable();
  }
  const Card = Object.assign(CardRoot, {
    Field: (props: CardFieldProps): ReactNode => useRuntime()?.sealed?.CardField(props) ?? null,
    Approve: (props: CardButtonProps): ReactNode => useRuntime()?.sealed?.CardApprove(props) ?? null,
    Deny: (props: CardButtonProps): ReactNode => useRuntime()?.sealed?.CardDeny(props) ?? null,
  });

  function AppView(props: { call: { session: string; callId: string }; className?: string }): ReactNode {
    return useRuntime()?.sealed?.AppView(props) ?? null;
  }

  function usePluginApi(): PluginApi {
    const runtime = useRuntime();
    const scope = useScope();
    if (!runtime) throw new Error("usePluginApi: no plugin runtime around this component");
    return runtime.api(pluginOf(scope));
  }

  function useCore(): CoreClient | undefined {
    const runtime = useRuntime();
    const id = pluginOf(useScope());
    return runtime && isCloverTree(id) ? runtime.core?.(id) : undefined;
  }

  function useTokens(): Readonly<Record<string, TokenValue>> {
    return useRuntime()?.tokens?.() ?? {};
  }

  function useT() {
    const runtime = useRuntime();
    const id = pluginOf(useScope());
    return (key: string, params?: Record<string, string | number>) => runtime?.t?.(id, key, params) ?? fill(key, params);
  }

  function useApprovals() {
    const runtime = useRuntime();
    const source = runtime?.approvals;
    const [, bump] = useState(0);
    useEffect(() => source?.subscribe(() => bump((n) => n + 1)), [source]);
    return { cards: source?.cards() ?? [], subscribe: (l: () => void) => source?.subscribe(l) ?? (() => undefined) };
  }

  function useEntry(): EntryRef | undefined {
    return useScope()?.entry;
  }

  function UiRuntimeProvider({ runtime, children }: { runtime: UiRuntime; children?: ReactNode }): ReactNode {
    return createElement(RuntimeContext.Provider, { value: runtime }, children);
  }

  /** Hears the app's messages to this document (`messages`), as lane E's hook does in the app. */
  function useLayerMessage(listener: (m: LayerCommand) => void): void {
    const runtime = useRuntime();
    const ref = useRef(listener);
    ref.current = listener;
    useEffect(() => runtime?.messages?.subscribe((m) => ref.current(m)), [runtime]);
  }

  function useMenu() {
    const runtime = useRuntime();
    return (items: readonly MenuItem[], at: { x: number; y: number }) => runtime?.menu?.(items, at) ?? Promise.resolve(null);
  }

  const ui: Ui = { Spot, Card, AppView, usePluginApi, useCore, useTokens, useT, useApprovals, useEntry, UiRuntimeProvider, useSpotEntries, useLayerMessage, useMenu };
  built.set(react, ui);
  return ui;
}

/** The stand-in is lane B's `UiApi` (checked here), with `<Spot>` taking `spotKey` for B's `key` and the extras the
 *  parts need (see `SpotElementProps`), plus `useCore`, `useEntry`, `useSpotEntries` and a provider for hosts. Its
 *  `useSpotEntries` takes the spot's props and says when there is a conflict, ahead of lane E's (E-M2), so it isn't
 *  checked against B's declaration (`{ entries, subscribe }`) until then. */
export const asUiApi = (ui: Ui): Omit<UiApi, "Spot" | "useSpotEntries"> & { Spot(props: SpotElementProps): ReactNode } => ui;
