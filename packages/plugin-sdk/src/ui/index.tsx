// `@waifucave/clover-plugin-sdk/ui`: the UI API that a plugin's React components use (spec §5.5), implementing lane
// B's declarations (`../api/ui-api.ts`). Each layer loads one copy, shared by every component in it: the app maps the
// bare specifier to the layer's own copy, beside React's.
//
// E-M1 builds `<Spot>` (inline in the same layer, a frame from the entry's own layer otherwise), the tokens hook and
// the layer's root; E-M2 the themes' sheets, strings (`useT`) and layouts. Sealed cards (`<Card>`, `useApprovals`,
// E-M3), MCP Apps (`<AppView>`, E-M3) and the plugin API in layers (`usePluginApi`, with lane B's host side) are
// placeholders that draw nothing and never fail, so components written against the declarations already run.
import { EVENT_AREAS } from "./event-areas";
import {
  Component, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ErrorInfo, type ReactNode,
} from "react";
import type { CardMeta } from "@waifucave/clover-protocol";
import type { TokenValue } from "../catalogs/tokens";
import { cssProperty } from "../catalogs/tokens";
import type { PluginApi, ShellAccount, ShellApp, ShellState, Unsubscribe } from "../api/plugin-api";
import type {
  AppViewProps, CardButtonProps, CardComponents, CardElementProps, CardFieldProps, EntryProps, SpeechFeed, SpotElementProps, UiApi, UiComponent,
} from "../api/ui-api";
import { CALLBACK_KEY, type DragOffer, type LayerBridge, type LayerMessage, type MenuItem, type MountContext, type MountInfo, type OpenTarget, type SpotItem, type SpotView, type SurfaceEnvironment, type SurfaceRequest, type ThemeSheet, type StringTable, type SpotEntryView, type PendingQuestion, type UserSendTarget, type ShellMethod } from "./bridge";
import { EMPTY_STRINGS, translate } from "./strings";
import { LayoutRoot } from "./layout";
import { ReceivedSpeech, SpeechForwarder, cleanSpeechMessage } from "./speech";
import { AvatarControlHub, cleanAvatarDown, cleanAvatarUp, type AvatarState } from "./avatar-control";
import type { AvatarBox, AvatarCatalogueNames, AvatarCue } from "../catalogs/avatar-cues";

export * from "./bridge";
export { AvatarControlHub, cleanAvatarCue, type AvatarState } from "./avatar-control";
// What a component needs of React, from the layer's own copy: a plugin that writes its components with these ships no
// React of its own (`clover plugin new`'s UI and point templates do).
export { createElement, Fragment, useEffect, useMemo, useRef, useState } from "react";
export type { AppViewProps, CardButtonProps, CardElementProps, CardFieldProps, EntryProps, SpeechFeed, SpeechFrame, UiApi, UiComponent, UiNode } from "../api/ui-api";

// -------------------------------------------------------------------------------------------------
// The layer's runtime: one per document
// -------------------------------------------------------------------------------------------------

/** A plugin's client module: its exports by name. */
export type ClientModule = Readonly<Record<string, unknown>>;

interface Runtime {
  bridge: LayerBridge;
  /** The client modules this layer holds, by plugin id. */
  modules: Map<string, ClientModule>;
  /** Loads a plugin's module on demand (a third-party layer's own). */
  load?: (pluginId: string) => Promise<ClientModule | undefined>;
  listeners: Set<(m: LayerMessage) => void>;
  /** The callbacks each child frame was handed, by child mount. */
  callbacks: Map<string, Map<string, (...args: unknown[]) => unknown>>;
  tokens: Map<string, Readonly<Record<string, TokenValue>>>;
  /** The questions waiting, as the core last sent them (to a plugin with `conversation.read`). */
  questions: readonly PendingQuestion[];
  /** The pending cards, ids and computers and options, as the core last sent them (`approve`/`deny`, §5.5). */
  cards: readonly CardMeta[];
  /** How long a frame stays away from the screen before it sleeps (§5.5). */
  sleepAfterMs: number;
}

/** A frame away from the screen this long sleeps (§5.5: "a layer hidden for a while sleeps"). */
export const SLEEP_AFTER_MS = 60_000;

let runtime: Runtime | undefined;

function rt(): Runtime {
  if (runtime === undefined) throw new Error("the Clover UI runtime isn't set up in this document");
  return runtime;
}

/** Sets the layer up (the app's layer boot calls it once, before rendering). Not for plugins. */
export function configureLayer(input: { bridge: LayerBridge; modules?: Record<string, ClientModule>; load?: Runtime["load"]; sleepAfterMs?: number }): void {
  const r: Runtime = {
    bridge: input.bridge,
    modules: new Map(Object.entries(input.modules ?? {})),
    ...(input.load ? { load: input.load } : {}),
    listeners: new Set(),
    callbacks: new Map(),
    tokens: new Map(),
    questions: [],
    cards: [],
    sleepAfterMs: input.sleepAfterMs ?? SLEEP_AFTER_MS,
  };
  runtime = r;
  input.bridge.onMessage((m) => {
    if (m.type === "callback") {
      const fn = r.callbacks.get(m.child)?.get(m.id);
      if (fn !== undefined) {
        try {
          fn(...m.args);
        } catch (err) {
          console.error("a callback a frame called failed", err);
        }
      }
    }
    if (m.type === "focus-returned") restoreFocus();
    if (m.type === "speech") {
      const speech = cleanSpeechMessage(m.speech);
      if (speech !== undefined) receivedSpeech.get(m.mount)?.accept(speech);
    }
    if (m.type === "avatar") {
      const down = cleanAvatarDown(m.message);
      if (down !== undefined) framedAvatars.get(m.mount)?.cue(down.cue);
    }
    if (m.type === "questions") r.questions = m.questions;
    if (m.type === "api-event") {
      const e = m.params as { type?: unknown; card?: CardMeta; id?: unknown; outcome?: unknown } | undefined;
      if (e?.type === "card_pending" && e.card !== undefined) {
        r.cards = [...r.cards.filter((c) => c.id !== e.card!.id), e.card];
      } else if (e?.type === "card_resolved" && typeof e.id === "string") {
        r.cards = r.cards.filter((c) => c.id !== e.id);
        // A read of the pending cards in flight must not bring it back (`useApprovals`).
        resolvedCards.add(e.id);
        if (resolvedCards.size > 512) resolvedCards.delete(resolvedCards.values().next().value!);
      }
    }
    if (m.type === "rect-query") {
      // The menu broker asks where a child frame is in this document's viewport.
      const el = typeof document === "undefined" ? undefined : Array.from(document.querySelectorAll("iframe[data-clover-mount]")).find((f) => f.getAttribute("data-clover-mount") === m.child);
      const b = el?.getBoundingClientRect();
      r.bridge.rectReply(m.id, b === undefined ? null : { x: b.x, y: b.y, width: b.width, height: b.height });
    }
    for (const l of r.listeners) l(m);
  });
  trackFocus();
}

/** Hears the core's messages to this document (app commands such as `open-settings`). For the `clover` layer's own
 *  parts; not in lane B's declarations. */
export function useLayerMessage(listener: (m: LayerMessage) => void): void {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => onLayerMessage((m) => ref.current(m)), []);
}

function onLayerMessage(listener: (m: LayerMessage) => void): () => void {
  const r = rt();
  r.listeners.add(listener);
  return () => r.listeners.delete(listener);
}

// S9: after the core's own overlay closes, the frame gets the focus back but not the element inside it, so the layer
// restores the element it last had.
let lastFocused: Element | null = null;
function trackFocus(): void {
  if (typeof document === "undefined") return;
  document.addEventListener("focusin", (e) => {
    if (e.target instanceof Element && e.target !== document.body) lastFocused = e.target;
  });
  window.addEventListener("focus", () => queueMicrotask(restoreFocus));
}
function restoreFocus(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if ((active === null || active === document.body) && lastFocused instanceof HTMLElement && lastFocused.isConnected) lastFocused.focus();
}

// -------------------------------------------------------------------------------------------------
// Props across a frame's edge: data, plus callbacks the core routes back (§5.5)
// -------------------------------------------------------------------------------------------------

const MAX_DEPTH = 32;

/** Props for a child frame: plain data, each function replaced by a marker the core routes back to it. */
export function encodeProps(props: unknown, register: (fn: (...args: unknown[]) => unknown) => string, depth = 0): unknown {
  if (typeof props === "function") return { [CALLBACK_KEY]: register(props as (...args: unknown[]) => unknown) };
  if (props === null || typeof props !== "object" || depth > MAX_DEPTH) return props;
  if (Array.isArray(props)) return props.map((p) => encodeProps(p, register, depth + 1));
  const proto = Object.getPrototypeOf(props);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    const e = encodeProps(v, register, depth + 1);
    if (e !== undefined) out[k] = e;
  }
  return out;
}

/** A frame's props as its component sees them: each marker is a function that calls back to the parent. */
export function decodeProps(props: unknown, call: (id: string, args: unknown[]) => void, depth = 0): unknown {
  if (props === null || typeof props !== "object" || depth > MAX_DEPTH) return props;
  if (Array.isArray(props)) return props.map((p) => decodeProps(p, call, depth + 1));
  const marker = (props as Record<string, unknown>)[CALLBACK_KEY];
  if (typeof marker === "string" && Object.keys(props).length === 1) {
    return (...args: unknown[]) => call(marker, args.map((a) => (typeof a === "function" ? undefined : a)));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) out[k] = decodeProps(v, call, depth + 1);
  return out;
}

/** CSS custom properties for a set of tokens (`color.text` → `--clover-color-text`). */
export function tokenStyle(tokens: Readonly<Record<string, TokenValue>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(tokens)) {
    try {
      out[cssProperty(name)] = typeof value === "number" ? String(value) : value;
    } catch {
      // Not a token name: never reaches CSS.
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// The part a component renders in
// -------------------------------------------------------------------------------------------------

interface Part {
  mount: string;
  entry: EntryProps["entry"];
  tokens: Readonly<Record<string, TokenValue>>;
  context: MountContext;
}

const PartContext = createContext<Part | null>(null);

/** The speech an `avatar` renderer lip-syncs to (`useAvatarSpeech`): the stage's own feed for a renderer in its
 *  document, or what its parent sends a renderer in a frame of its own. */
export interface AvatarSpeech {
  /** The feed: frames on the audio clock, and the clock. Undefined where the app isn't describing speech to this part. */
  readonly feed: SpeechFeed | undefined;
  /** Whether the bot is speaking now. */
  readonly speaking: boolean;
}
const NO_SPEECH: AvatarSpeech = { feed: undefined, speaking: false };
const AvatarSpeechContext = createContext<AvatarSpeech>(NO_SPEECH);

/** The receivers of this document's framed `avatar` renderers, by mount (`LayerRoot`). */
const receivedSpeech = new Map<string, ReceivedSpeech>();

/** For the stage (the `clover` layer's character part, or whatever plays the bot's speech): the feed the `avatar`
 *  spot's renderers under it lip-sync to. A renderer in this document reads it with `useAvatarSpeech`; a renderer in a
 *  frame of its own gets its frames sent on, numbers only, while the frame can be seen. Not for plugins. */
export function AvatarSpeechProvider({ feed, speaking, children }: { feed: SpeechFeed | undefined; speaking: boolean; children?: ReactNode }) {
  const value = useMemo<AvatarSpeech>(() => ({ feed, speaking }), [feed, speaking]);
  return <AvatarSpeechContext.Provider value={value}>{children}</AvatarSpeechContext.Provider>;
}

/** In an `avatar` renderer: the speech of the bot it draws, to move its mouth by. The same in the `clover` layer and in
 *  a plugin's own frame: `feed.subscribe` hands frames `{ t, rms, centroid }` (loudness 0–1 and brightness in Hz, on the
 *  audio clock, a little ahead of when they play), `feed.now()` is that clock now, and `speaking` says whether the bot
 *  speaks. Only numbers reach a plugin's frame: no audio, no text. */
export function useAvatarSpeech(): AvatarSpeech {
  return useContext(AvatarSpeechContext);
}

/** What an `avatar` renderer uses to take cues and publish its model's names and the figure's box (`useAvatarControl`). */
const AvatarControlContext = createContext<AvatarControlHub | undefined>(undefined);
/** The hubs of this document's framed `avatar` renderers, by mount (`LayerRoot`). */
const framedAvatars = new Map<string, AvatarControlHub>();

/** For the stage: the hub its `avatar` renderers take cues from and publish to. A renderer in this document reads it
 *  with `useAvatarControl`; a renderer in a frame of its own gets each cue sent on and its state read back, as plain
 *  data through main, while the frame can be seen. Not for plugins. */
export function AvatarControlProvider({ hub, children }: { hub: AvatarControlHub | undefined; children?: ReactNode }) {
  useEffect(() => {
    if (hub === undefined || typeof document === "undefined") return;
    const sync = () => hub.setVisible(!document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [hub]);
  return <AvatarControlContext.Provider value={hub}>{children}</AvatarControlContext.Provider>;
}

/** What `useAvatarControl` gives a renderer. */
export interface AvatarControl {
  /** Takes the cues for this figure (an expression, a motion, an outfit part, the pace, a look-at point). A renderer
   *  plays what its `avatar.formats` `capabilities` list; a cue it doesn't list never reaches it (the core answers the
   *  caller plainly). Returns the unsubscribe, for an effect's cleanup. */
  onCue(listener: (cue: AvatarCue) => void): () => void;
  /** Tells the app what the loaded model has, by its own names (and where each outfit part stands); undefined when
   *  nothing is loaded. Call it when a model loads or changes. */
  setCatalogue(names: AvatarCatalogueNames | undefined): void;
  /** Tells the app where the figure stands on the stage, in the stage's own pixels from its top left: its box and
   *  the anchors it knows (`headTop`, `face`, `mouth`, `chest`). Say it when a model loads and when it moves
   *  materially: it is throttled here, and nothing goes while the window is hidden. Only the canvas is enough. */
  setBox(box: AvatarBox | undefined): void;
}
const NO_CONTROL: AvatarControl = { onCue: () => () => undefined, setCatalogue: () => undefined, setBox: () => undefined };

/** In an `avatar` renderer: receive the bot plugin's cues and publish the model's catalogue and the figure's box. The
 *  same in the `clover` layer and in a plugin's own frame. Outside the stage it does nothing. */
export function useAvatarControl(): AvatarControl {
  const hub = useContext(AvatarControlContext);
  return useMemo<AvatarControl>(() => (hub === undefined ? NO_CONTROL : {
    onCue: (l) => hub.onCue(l),
    setCatalogue: (n) => hub.setNames(n),
    setBox: (b) => hub.setBox(b),
  }), [hub]);
}

/** A framed `avatar` renderer's own control: cues from its parent, its state up to it. */
function FramedAvatar({ mount, children }: { mount: string; children: ReactNode }) {
  const hub = useMemo(() => new AvatarControlHub((state: AvatarState) => {
    rt().bridge.avatarUp?.({ kind: "state", names: state.names ?? null, box: state.box ?? null });
  }), [mount]);
  useEffect(() => {
    framedAvatars.set(mount, hub);
    return () => {
      hub.close();
      if (framedAvatars.get(mount) === hub) framedAvatars.delete(mount);
    };
  }, [mount, hub]);
  return <AvatarControlProvider hub={hub}>{children}</AvatarControlProvider>;
}

/** A framed `avatar` renderer's own speech: what its parent sends, as a feed. */
function FramedSpeech({ mount, children }: { mount: string; children: ReactNode }) {
  const feed = useMemo(() => {
    const received = new ReceivedSpeech();
    receivedSpeech.set(mount, received);
    return received;
  }, [mount]);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    receivedSpeech.set(mount, feed);
    const off = feed.onSpeaking(setSpeaking);
    return () => {
      off();
      if (receivedSpeech.get(mount) === feed) receivedSpeech.delete(mount);
    };
  }, [mount, feed]);
  return <AvatarSpeechProvider feed={feed} speaking={speaking}>{children}</AvatarSpeechProvider>;
}

/** The document's strings, as the core last sent them. */
const StringsContext = createContext<StringTable>(EMPTY_STRINGS);

/** What the `clover` layer tells the core about the parts under it: the kind of session they show (`when.session`).
 *  Heard from the `clover` layer only. Not for plugins. */
export const SpotHints = createContext<{ session?: string }>({});

function usePart(): Part {
  const part = useContext(PartContext);
  if (part === null) throw new Error("a Clover UI hook ran outside a mounted entry");
  return part;
}

class PartBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`the part ${this.props.name} stopped`, error, info.componentStack);
  }
  override render(): ReactNode {
    if (this.state.failed) return <div className="clover-part-stopped" role="status" data-clover-stopped={this.props.name}>This part stopped.</div>;
    return this.props.children;
  }
}

function findComponent(mod: ClientModule | undefined, name: string): UiComponent<EntryProps<any>> | undefined {
  const c = mod?.[name];
  return typeof c === "function" ? (c as UiComponent<EntryProps<any>>) : undefined;
}

/** Renders one entry's component in its part. */
function EntryView({ part, component, props }: { part: Part; component: UiComponent<EntryProps<any>>; props: unknown }) {
  const C = component as (p: EntryProps<any>) => ReactNode;
  return (
    <PartContext.Provider value={part}>
      <PartBoundary name={`${part.entry.pluginId}#${part.entry.id}`}>
        <C props={(props ?? {}) as Record<string, unknown>} tokens={part.tokens} entry={part.entry} />
      </PartBoundary>
    </PartContext.Provider>
  );
}

/** The document's own entry: what the layer boot renders. Not for plugins. */
export function LayerRoot({ info }: { info: MountInfo }) {
  const r = rt();
  const [props, setProps] = useState<unknown>(() => decodeProps(info.props, (id, args) => r.bridge.callback(id, args)));
  const [tokens, setTokens] = useState(info.tokens);
  const [sheets, setSheets] = useState<readonly ThemeSheet[]>(info.sheets ?? []);
  const [strings, setStrings] = useState<StringTable>(info.strings ?? EMPTY_STRINGS);
  const [mod, setMod] = useState<ClientModule | undefined>(() => r.modules.get(info.pluginId));
  useEffect(() => onLayerMessage((m) => {
    if (m.type === "props" && m.mount === info.mount) setProps(decodeProps(m.props, (id, args) => r.bridge.callback(id, args)));
    if (m.type === "tokens" && m.tokens[info.mount] !== undefined) setTokens(m.tokens[info.mount]!);
    if (m.type === "sheets") setSheets(m.sheets);
    if (m.type === "strings") setStrings(m.strings);
  }), [info.mount, r]);
  useLayoutEffect(() => {
    document.documentElement.lang = strings.lang;
  }, [strings.lang]);
  useLayoutEffect(() => {
    // The document is the part: its themes' sheets are scoped to it by these marks.
    const root = document.documentElement;
    root.setAttribute("data-clover-part", info.mount);
    if (info.tab !== undefined) root.setAttribute("data-clover-tab", info.tab);
    if (info.styled === true) root.setAttribute("data-clover-styled", "");
  }, [info.mount, info.tab, info.styled]);
  useLayoutEffect(() => applySheets(sheets), [sheets]);
  useEffect(() => {
    if (mod !== undefined || r.load === undefined) return;
    void r.load(info.pluginId).then((m) => {
      if (m !== undefined) {
        r.modules.set(info.pluginId, m);
        setMod(m);
      }
    });
  }, [info.pluginId, mod, r]);
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    for (const [k, v] of Object.entries(tokenStyle(tokens))) style.setProperty(k, v);
  }, [tokens]);
  useEffect(() => {
    // The core sizes the frame: report the content's height as it changes (the bottom of the part's own elements, so
    // a part that fills its frame reports the frame, and a small one its own size).
    const host = document.getElementById("clover-root") ?? document.body;
    let frame = 0;
    let last = -1;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        let bottom = 0;
        for (const c of Array.from(host.children)) bottom = Math.max(bottom, c.getBoundingClientRect().bottom);
        const h = Math.ceil(bottom);
        if (h !== last) {
          last = h;
          r.bridge.reportSize(h);
        }
      });
    };
    const resize = new ResizeObserver(measure);
    const watch = () => {
      resize.disconnect();
      resize.observe(host);
      for (const c of Array.from(host.children)) resize.observe(c);
      measure();
    };
    const children = new MutationObserver(watch);
    children.observe(host, { childList: true });
    watch();
    return () => {
      resize.disconnect();
      children.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [r]);
  const part: Part = useMemo(() => ({
    mount: info.mount,
    entry: { pluginId: info.pluginId, id: info.entryId, spot: info.spot, ...(info.key !== undefined ? { key: info.key } : {}) },
    tokens,
    context: info.context,
  }), [info, tokens]);
  const component = info.component === undefined ? undefined : findComponent(mod, info.component);
  if (component === undefined) {
    return mod === undefined && r.load !== undefined ? null : <div className="clover-part-missing" role="status">This part has no component {info.component}.</div>;
  }
  const view = <EntryView part={part} component={component} props={props} />;
  return (
    <StringsContext.Provider value={strings}>
      {info.spot === "avatar" ? <FramedSpeech mount={info.mount}><FramedAvatar mount={info.mount}>{view}</FramedAvatar></FramedSpeech> : view}
    </StringsContext.Provider>
  );
}

/** Puts the themes' sheets in the head, after the part's own stylesheets and in the core's order (§5.5's stack: the
 *  later and the nearer win). A sheet whose text is unchanged keeps its element. */
export function applySheets(sheets: readonly ThemeSheet[], doc: Document = document): void {
  const head = doc.head;
  const old = new Map<string, HTMLStyleElement>();
  for (const el of Array.from(head.querySelectorAll<HTMLStyleElement>("style[data-clover-sheet]"))) old.set(el.getAttribute("data-clover-sheet") ?? "", el);
  for (const s of sheets) {
    let el = old.get(s.id);
    old.delete(s.id);
    if (el === undefined) {
      el = doc.createElement("style");
      el.setAttribute("data-clover-sheet", s.id);
    }
    if (el.textContent !== s.css) el.textContent = s.css;
    head.appendChild(el);
  }
  for (const el of old.values()) el.remove();
}

// -------------------------------------------------------------------------------------------------
// <Spot>
// -------------------------------------------------------------------------------------------------

function sameView(a: SpotView | undefined, b: SpotView): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** `<Spot name spotKey entry props>`'s props (lane B's `SpotElementProps`; `entry` shows one entry only, by its ref
 *  from `useSpotEntries`). */
export type SpotProps = Omit<SpotElementProps, "key" | "spotKey" | "entry"> & {
  spotKey?: string;
  entry?: string;
  /** Lane F's name for `entry`. */
  only?: string;
  /** What shows where nothing fills the spot (lane F's: a panel's placeholder). */
  fallback?: ReactNode;
  /** The bot whose tab shows, for the spots that offer `when.bot` outside a bot's tab (`sidebar`, `bar`): heard from the `clover` layer only. */
  forBot?: string;
};

/** `<Spot name spotKey props>`: shows a spot this part declares (§5.5). */
export function Spot({ name, spotKey, entry: entryRef, only, props, fallback, forBot }: SpotProps) {
  const entry = entryRef ?? only;
  const part = usePart();
  const hints = useContext(SpotHints);
  const r = rt();
  const [view, setView] = useState<SpotView | undefined>(undefined);
  const session = hints.session;
  const resolve = useCallback(() => {
    const h = { ...(session !== undefined ? { session } : {}), ...(entry !== undefined ? { entry } : {}), ...(forBot !== undefined ? { bot: forBot } : {}) };
    void r.bridge.resolve(part.mount, name, spotKey, Object.keys(h).length > 0 ? h : undefined)
      .then((v) => setView((old) => (sameView(old, v) ? old : v)), () => setView(undefined));
  }, [r, part.mount, name, spotKey, session, entry, forBot]);
  useEffect(() => {
    resolve();
    return onLayerMessage((m) => {
      if (m.type === "respot") resolve();
    });
  }, [resolve]);
  // Parts no longer shown are released, with everything under them.
  const shown = useRef<string[]>([]);
  useEffect(() => {
    const now = view?.items.map((i) => i.mount) ?? [];
    const gone = shown.current.filter((m) => !now.includes(m));
    if (gone.length > 0) r.bridge.release(gone);
    shown.current = now;
  }, [view, r]);
  useEffect(() => () => {
    if (shown.current.length > 0) r.bridge.release(shown.current);
  }, [r]);
  if (view === undefined || view.hidden || view.items.length === 0) {
    // `data-clover-pending`: not resolved yet (a host that holds a tab until it is drawn reads it, the shell's KeptTab).
    return <div data-clover-spot={name} data-clover-key={spotKey} data-clover-empty={view?.hidden ? "hidden" : view?.undeclared ? "waiting" : ""} data-clover-pending={view === undefined ? "" : undefined} style={{ display: "contents" }}>{view !== undefined && !view.hidden ? fallback : null}</div>;
  }
  return (
    <div data-clover-spot={name} data-clover-key={spotKey} data-clover-conflict={view.conflict ? "" : undefined} style={{ display: "contents" }}>
      {view.items.map((item) => <SpotItemView key={item.mount} item={item} parent={part} spot={name} spotKey={view.key} props={props} />)}
    </div>
  );
}

function SpotItemView({ item, parent, spot, spotKey, props }: { item: SpotItem; parent: Part; spot: string; spotKey: string | undefined; props: unknown }) {
  if (item.kind === "frame") return <LayerFrame item={item} props={props} spot={spot} />;
  if (item.kind === "web") return <WebPart item={item} />;
  return <InlineItem item={item} parent={parent} spot={spot} spotKey={spotKey} props={props} />;
}

/** A web page part: the core draws the page's own view over this element, in the page's own session (§5.5). */
function WebPart({ item }: { item: Extract<SpotItem, { kind: "web" }> }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (el === null) return;
    const bridge = rt().bridge;
    let last = "";
    const measure = () => {
      const b = el.getBoundingClientRect();
      const shown = b.width > 0 && b.height > 0 && document.visibilityState !== "hidden" && el.isConnected;
      const rect = shown ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
      const key = JSON.stringify(rect);
      if (key === last) return;
      last = key;
      bridge.webFrame(item.mount, rect);
    };
    return trackRect(el, measure, () => bridge.webFrame(item.mount, null));
  }, [el, item.mount]);
  return <div ref={setEl} className="clover-web-part" data-clover-entry={item.ref} data-clover-web={item.mount} style={{ display: "block", width: "100%", height: "100%", minHeight: 120 }} />;
}

/** Calls `measure` whenever an element may have moved or changed size (its resizes, the window's, any scroll, the
 *  document's visibility, and a slow poll for moves with no resize); `gone` when it stops. */
function trackRect(el: HTMLElement, measure: () => void, gone: () => void, extra?: { onUse: () => void }): () => void {
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => measure());
  resize?.observe(el);
  const onChange = () => measure();
  window.addEventListener("resize", onChange);
  document.addEventListener("scroll", onChange, true);
  document.addEventListener("visibilitychange", onChange);
  if (extra !== undefined) {
    el.addEventListener("pointerdown", extra.onUse, true);
    el.addEventListener("keydown", extra.onUse, true);
  }
  const poll = setInterval(onChange, VIEW_FRAME_POLL_MS);
  measure();
  return () => {
    resize?.disconnect();
    window.removeEventListener("resize", onChange);
    document.removeEventListener("scroll", onChange, true);
    document.removeEventListener("visibilitychange", onChange);
    if (extra !== undefined) {
      el.removeEventListener("pointerdown", extra.onUse, true);
      el.removeEventListener("keydown", extra.onUse, true);
    }
    clearInterval(poll);
    gone();
  };
}

function InlineItem({ item, parent, spot, spotKey, props }: { item: Extract<SpotItem, { kind: "inline" }>; parent: Part; spot: string; spotKey: string | undefined; props: unknown }) {
  const r = rt();
  // Its own tokens: the descriptor's, then each update the core sends for this mount; none, its parent's. A change of
  // the parent's tokens never puts the descriptor's back (a light/dark switch updates both in one message, and the
  // descriptor's are the tokens of when it was resolved: a tab drew its light ones in dark).
  const [ownTokens, setOwnTokens] = useState(item.tokens);
  useEffect(() => setOwnTokens(item.tokens), [item.tokens]);
  useEffect(() => onLayerMessage((m) => {
    if (m.type === "tokens" && m.tokens[item.mount] !== undefined) setOwnTokens(m.tokens[item.mount]!);
  }), [item.mount]);
  const tokens = ownTokens ?? parent.tokens;
  const part: Part = useMemo(() => ({
    mount: item.mount,
    entry: { pluginId: item.pluginId, id: item.entryId, spot, ...(spotKey !== undefined ? { key: spotKey } : {}) },
    tokens,
    context: item.context,
  }), [item, tokens, spot, spotKey]);
  // The `composer` spot's session and bot are the declaring document's own say, told to the core for this mount (as a
  // frame's props are): the core decides what the composer's callbacks reach from them. Data only; no callbacks go.
  // A layout effect, so it goes before the entry's own first call (its effects run later).
  const toldComposer = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (spot !== "composer") return;
    const encoded = encodeProps(props ?? {}, () => "");
    // Told when it changed, not at every render of the document that holds it: the same data again is no message.
    const key = JSON.stringify(encoded);
    if (toldComposer.current === key) return;
    toldComposer.current = key;
    r.bridge.setProps(item.mount, encoded);
  }, [spot, props, item.mount, r]);
  const own = tokens !== parent.tokens ? tokenStyle(tokens) : undefined;
  const marks = { "data-clover-entry": item.ref, "data-clover-part": item.mount, "data-clover-tab": item.tab, "data-clover-styled": item.styled === true ? "" : undefined };
  if (item.layout !== undefined) {
    // A bot's layout: data the runtime draws as the tab's part, its spots the part's own. A layout's root fills the
    // place it is in, so it gets a box of its own (the theme's `contain` reaches it). Its spots get the tab's own props (the
    // bot and the session): the conversation and the composer in it are the tab's, and read them.
    const layout = item.layout;
    return (
      <div {...marks} data-clover-layout-part="" style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, height: "100%", ...own }}>
        <PartContext.Provider value={part}>
          <PartBoundary name={item.ref}>
            <LayoutRoot layout={layout} renderSpot={(spot, key) => <Spot name={spot} props={props as Record<string, unknown> | undefined} {...(key !== undefined ? { spotKey: key } : {})} />} />
          </PartBoundary>
        </PartContext.Provider>
      </div>
    );
  }
  const component = findComponent(r.modules.get(item.pluginId), item.component);
  if (component === undefined) return <div className="clover-part-missing" role="status" data-clover-entry={item.ref}>This part has no component {item.component}.</div>;
  return (
    <div {...marks} style={{ display: "contents", ...own }}>
      <EntryView part={part} component={component} props={props} />
    </div>
  );
}

/** Whether this document shows (its window not hidden or minimized). */
function useDocumentShown(): boolean {
  const [shown, setShown] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => setShown(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  return shown;
}

/** Whether an element is near the screen: in its document's viewport or within one viewport of it, while the
 *  document itself shows (a hidden or minimized window counts as away). */
function useNear(el: Element | null): boolean {
  const [near, setNear] = useState(true);
  const [shown, setShown] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const onVisibility = () => setShown(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => {
    if (el === null || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last !== undefined) setNear(last.isIntersecting);
    }, { rootMargin: "100% 100% 100% 100%" });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return near && shown;
}

/** A part from another layer: a frame from that plugin's own origin, drawn by its own process. Away from the screen
 *  for a while, it sleeps: the core drops its document (and the layer's process with its last frame), and it wakes
 *  rebuilt from the core's state when it comes near again (§5.5). */
function LayerFrame({ item, props, spot }: { item: Extract<SpotItem, { kind: "frame" }>; props: unknown; spot: string }) {
  const r = rt();
  const [url, setUrl] = useState(item.url);
  const [asleep, setAsleep] = useState(item.asleep === true);
  const [height, setHeight] = useState<number | undefined>(undefined);
  /** The URL whose document has reported its size (drawn); a new URL (a wake, a reload) hasn't until it reports. */
  const [drawnUrl, setDrawnUrl] = useState<string | undefined>(undefined);
  const urlNow = useRef(item.url);
  const [gone, setGone] = useState<string | undefined>(undefined);
  const toldProps = useRef<string | undefined>(undefined);
  const [el, setEl] = useState<Element | null>(null);
  const near = useNear(el);
  // An `avatar` renderer in a frame of its own: the stage's speech, sent on as numbers while the frame can be seen.
  const speech = useContext(AvatarSpeechContext);
  const shown = useDocumentShown();
  const forwarder = useRef<SpeechForwarder | undefined>(undefined);
  useEffect(() => {
    if (spot !== "avatar" || speech.feed === undefined || r.bridge.speech === undefined) return;
    const send = r.bridge.speech.bind(r.bridge);
    const f = new SpeechForwarder(speech.feed, (message) => send(item.mount, message));
    forwarder.current = f;
    return () => {
      f.close();
      if (forwarder.current === f) forwarder.current = undefined;
    };
  }, [spot, speech.feed, item.mount, r]);
  useEffect(() => forwarder.current?.setOpen(shown && !asleep && gone === undefined), [shown, asleep, gone, speech.feed, item.mount]);
  useEffect(() => forwarder.current?.setSpeaking(speech.speaking), [speech.speaking, speech.feed, item.mount]);
  // The same frame's cues, sent on while it can be seen, and what it says about its model and figure, read into the stage's hub.
  const avatarHub = useContext(AvatarControlContext);
  const seen = shown && !asleep && gone === undefined;
  useEffect(() => {
    if (spot !== "avatar" || avatarHub === undefined || !seen || r.bridge.avatar === undefined) return;
    const send = r.bridge.avatar.bind(r.bridge);
    return avatarHub.onCue((cue) => send(item.mount, { kind: "cue", cue }));
  }, [spot, avatarHub, seen, item.mount, r]);
  useEffect(() => {
    if (spot !== "avatar" || avatarHub === undefined) return;
    const off = onLayerMessage((m) => {
      if (m.type !== "avatar-up" || m.child !== item.mount) return;
      const up = cleanAvatarUp(m.message);
      if (up === undefined) return;
      if (up.names !== undefined) avatarHub.setNames(up.names ?? undefined);
      if (up.box !== undefined) avatarHub.setBox(up.box ?? undefined);
    });
    return () => { off(); avatarHub.setNames(undefined); avatarHub.setBox(undefined); };
  }, [spot, avatarHub, item.mount]);
  useEffect(() => {
    if (item.url !== "") setUrl(item.url);
  }, [item.url]);
  urlNow.current = url;
  useEffect(() => onLayerMessage((m) => {
    if (m.type === "child-size" && m.child === item.mount) {
      setHeight(m.height);
      setDrawnUrl(urlNow.current);
    }
    if (m.type === "child-gone" && m.child === item.mount) setGone(m.reason);
    if (m.type === "child-reload" && m.child === item.mount) {
      setGone(undefined);
      setAsleep(false);
      setUrl(m.url);
    }
  }), [item.mount]);
  useEffect(() => {
    if (gone !== undefined) return;
    if (asleep) {
      if (!near) return;
      let live = true;
      void r.bridge.wake(item.mount).then((next) => {
        if (!live || next === undefined) return;
        setUrl(next);
        setAsleep(false);
      });
      return () => {
        live = false;
      };
    }
    if (near) return;
    const timer = setTimeout(() => {
      r.bridge.sleep(item.mount);
      setAsleep(true);
    }, r.sleepAfterMs);
    return () => clearTimeout(timer);
  }, [near, asleep, gone, item.mount, r]);
  useEffect(() => {
    const fns = new Map<string, (...args: unknown[]) => unknown>();
    let n = 0;
    const encoded = encodeProps(props ?? {}, (fn) => {
      const id = String(++n);
      fns.set(id, fn);
      return id;
    });
    r.callbacks.set(item.mount, fns);
    // The callbacks above are the newest each time; the message goes only when the data changed (a parent that draws again
    // with an equal `props` object, at every tick of a clock or a frame, would otherwise send the core one message per draw).
    // A page that loads again (a new `url`) or wakes (`asleep` changes) hears them anew.
    const key = `${asleep ? "asleep" : "awake"}|${url}|${JSON.stringify(encoded)}`;
    if (toldProps.current === key) return;
    toldProps.current = key;
    r.bridge.setProps(item.mount, encoded);
  }, [props, item.mount, r, asleep, url]);
  useEffect(() => () => {
    r.callbacks.delete(item.mount);
  }, [item.mount, r]);
  if (gone !== undefined) {
    return (
      <div className="clover-part-stopped" role="status" data-clover-entry={item.ref} data-clover-gone={gone}>
        This part stopped.{" "}
        <button type="button" onClick={() => void r.bridge.reload(item.mount).then((next) => {
          if (next !== undefined) {
            setGone(undefined);
            setAsleep(false);
            setUrl(next);
          }
        })}>Reload</button>
      </div>
    );
  }
  if (asleep) {
    // Keeps its place while it sleeps, so nothing around it moves.
    return <div ref={setEl} data-clover-entry={item.ref} data-clover-asleep="" style={{ display: "block", width: "100%", height: height === undefined ? undefined : `${height}px` }} />;
  }
  return (
    <iframe
      ref={setEl}
      key={url}
      src={url}
      title={item.ref}
      data-clover-entry={item.ref}
      data-clover-layer={item.layer}
      data-clover-mount={item.mount}
      // Its document has drawn (its first size report since this URL loaded): a host holding a tab until it is drawn reads it.
      data-clover-drawn={drawnUrl === url ? "" : undefined}
      allow={item.isolated === true ? "cross-origin-isolated" : ""}
      referrerPolicy="no-referrer"
      style={{ display: "block", border: 0, width: "100%", height: height === undefined ? undefined : `${height}px`, colorScheme: "light dark", background: "transparent" }}
    />
  );
}

// -------------------------------------------------------------------------------------------------
// Hooks and the later parts
// -------------------------------------------------------------------------------------------------

/** Where the part is (its tab's bot, the surface, the OS, the window's material, safe mode). For the `clover` layer's
 *  own parts; not in lane B's declarations. */
export function useMountContext(): MountContext {
  return usePart().context;
}

/** The part's resolved tokens, by name. */
export function useTokens(): Readonly<Record<string, TokenValue>> {
  return usePart().tokens;
}

/** Strings from the plugin's own keys (`<top-level id>.…`), in the user's language: `{name}` placeholders filled,
 *  plural forms chosen by `count` under the language's rules. A key with no string reads as itself. */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const table = useContext(StringsContext);
  return useCallback((key: string, params?: Record<string, string | number>) => translate(table, key, params), [table]);
}

/** Hears the events on this plugin's own connection to the core. */
function onApiEvent(pluginId: string, listener: (method: string, params: unknown) => void): () => void {
  return onLayerMessage((m) => {
    if (m.type === "api-event" && m.pluginId === pluginId) listener(m.method, m.params);
  });
}

/** The areas each plugin's connection already subscribed to, in this document. */
const subscribed = new Map<string, Set<string>>();
/** Cards this document heard resolved (the last 512), so a pending list read before the answer doesn't bring one back. */
const resolvedCards = new Set<string>();

function subscribe(mount: string, pluginId: string, area: string): void {
  const areas = subscribed.get(pluginId) ?? new Set<string>();
  subscribed.set(pluginId, areas);
  if (areas.has(area)) return;
  areas.add(area);
  void rt().bridge.api(mount, "events.subscribe", { areas: [area] }).catch(() => areas.delete(area));
}

/** `terminal` (components of the bundled `clover` tree): what reaches a terminal the core derives from the trusted
 *  key press or paste the part hands over; output comes as `terminal_output` on the plugin's own connection. */
function terminalApi(mount: string, pluginId: string): NonNullable<PluginApi["terminal"]> {
  const api = <T,>(method: string, params: unknown) => rt().bridge.api(mount, method, params) as Promise<T>;
  return {
    open: (opts) => api<{ terminalId: string }>("terminal.open", opts),
    input: async (terminalId, event) => {
      if (!event.isTrusted) throw new Error("only the user's own key press or paste reaches a terminal");
      if (event.type === "paste") return rt().bridge.terminalInput(mount, terminalId, { kind: "paste" });
      const key = (event as unknown as { key?: unknown }).key;
      if (typeof key !== "string") return;
      return rt().bridge.terminalInput(mount, terminalId, { kind: "key", key });
    },
    onData: (terminalId, fn) => {
      subscribe(mount, pluginId, "computers");
      return onApiEvent(pluginId, (method, params) => {
        const e = params as { type?: unknown; terminalId?: unknown; data?: unknown; exited?: { code: number | null } } | undefined;
        if (method !== "core.event" || e?.type !== "terminal_output" || e.terminalId !== terminalId) return;
        fn(typeof e.data === "string" ? e.data : "", e.exited);
      });
    },
    resize: (terminalId, cols, rows) => api<void>("terminal.resize", { terminalId, cols, rows }).then(() => undefined),
    close: (terminalId) => api<void>("terminal.close", { terminalId }).then(() => undefined),
  };
}

/** A list the core keeps, and its changes: `watch` hears each `<type>` core event of its area, for one item. */
function watcher<T>(mount: string, pluginId: string, area: string, type: string, field: string) {
  return (listener: (item: T) => void): Unsubscribe => {
    subscribe(mount, pluginId, area);
    return onApiEvent(pluginId, (method, params) => {
      const e = params as Record<string, unknown> | undefined;
      if (method === "core.event" && e?.type === type && e[field] !== undefined) listener(e[field] as T);
    });
  };
}

/** The plugin API in this layer, each call on the part's own plugin's connection, where the daemon checks it as that
 *  plugin: `plugin`, `t`, `terminal`, `bots`, `computers`, `devices`, `approvals`, `conversation`'s `list`, `get` and `answer`, and
 *  its own plugin (`host.call`, `host.on`, and `storage.synced`'s `get`, `keys` and `watch`). The rest reaches layers
 *  with lane B's host side (B-M2). */
export function usePluginApi(): PluginApi {
  const part = usePart();
  const t = useT();
  return useMemo(() => {
    const unavailable = (what: string) => () => Promise.reject(new Error(`${what} isn't available in layers yet`));
    const call = <T,>(method: string, params: unknown) => rt().bridge.api(part.mount, method, params) as Promise<T>;
    return {
      terminal: terminalApi(part.mount, part.entry.pluginId),
      shell: shellApi(part.mount),
      conversation: {
        list: (filter?: { bot?: string; kinds?: string[] }) => call<{ sessions: unknown[] }>("session.list", filter ?? {}).then((r) => r.sessions),
        get: (session: string) => call<{ session: unknown }>("session.get", { id: session }).then((r) => r.session),
        answer: (session: string, callId: string, answers: Record<string, string>) => call<unknown>("session.answer", { id: session, callId, answers }).then(() => undefined),
        history: (session: string, page: { before?: number; limit: number }) => call<{ events: Record<string, unknown>[]; hasMore: boolean }>("session.history", { id: session, ...page }),
        follow: (session: string, listener: (event: Record<string, unknown>) => void, opts?: { since?: number }): Unsubscribe => {
          // The session's live events arrive as `event` notifications on this plugin's connection once it attaches.
          const off = onApiEvent(part.entry.pluginId, (method, params) => {
            const e = params as Record<string, unknown> | undefined;
            if (method === "event" && e?.sessionId === session) listener(e);
          });
          void call<unknown>("session.attach", { id: session, ...(opts?.since !== undefined ? { since: opts.since } : {}) }).catch(() => undefined);
          return () => {
            off();
            void call<unknown>("session.detach", { id: session }).catch(() => undefined);
          };
        },
      } as unknown as PluginApi["conversation"],
      bots: {
        list: () => call<{ bots: unknown[] }>("bot.list", {}).then((r) => r.bots),
        get: (bot: string) => call<{ bot: unknown }>("bot.get", { id: bot }).then((r) => r.bot),
        watch: watcher(part.mount, part.entry.pluginId, "sessions", "bot_changed", "bot"),
      } as unknown as PluginApi["bots"],
      computers: {
        list: () => call<{ computers: unknown[] }>("computer.list", {}).then((r) => r.computers),
        get: (name: string) => call<{ computer: unknown }>("computer.get", { name }).then((r) => r.computer),
        watch: watcher(part.mount, part.entry.pluginId, "computers", "computer_changed", "computer"),
      } as unknown as PluginApi["computers"],
      devices: {
        list: () => call<{ devices: unknown[] }>("device.list", {}).then((r) => r.devices),
        watch: watcher(part.mount, part.entry.pluginId, "devices", "device_changed", "device"),
      } as unknown as PluginApi["devices"],
      approvals: {
        pending: () => call<{ cards: unknown[] }>("card.pending", {}).then((r) => r.cards),
        // The whole pending list, read again at each card raised or settled (the core sends only this plugin's bot's).
        watch: (listener: (cards: CardMeta[]) => void): Unsubscribe => {
          subscribe(part.mount, part.entry.pluginId, "approvals");
          let live = true;
          const read = (): void => { void call<{ cards: CardMeta[] }>("card.pending", {}).then((r) => { if (live) listener(r.cards); }, () => undefined); };
          const off = onApiEvent(part.entry.pluginId, (method, params) => {
            const type = (params as { type?: unknown } | undefined)?.type;
            if (method === "core.event" && (type === "card_pending" || type === "card_resolved")) read();
          });
          read();
          return () => { live = false; off(); };
        },
      } as unknown as PluginApi["approvals"],
      // The plugin's own bot's figure (`avatar.read`, `avatar.control`), through the core, which judges each cue; the stage's
      // own `report` (bundled `clover` tree only). The watch hears the core's `clover.avatar.changed` message for this plugin.
      avatar: {
        cue: (cue: unknown) => call<{ result: unknown }>("plugin.layer.call", { call: "avatar.cue", args: [cue] }).then((r) => r.result),
        catalogue: () => call<{ result: unknown }>("plugin.layer.call", { call: "avatar.catalogue", args: [] }).then((r) => r.result),
        box: () => call<{ result: unknown }>("plugin.layer.call", { call: "avatar.box", args: [] }).then((r) => r.result),
        report: (bot: string, report: unknown) => call<unknown>("plugin.layer.call", { call: "avatar.report", args: [bot, report ?? null] }).then(() => undefined),
        watch: (listener: (change: unknown) => void): Unsubscribe => {
          subscribe(part.mount, part.entry.pluginId, "plugins");
          return onApiEvent(part.entry.pluginId, (method, params) => {
            const e = params as { type?: unknown; pluginId?: unknown; event?: unknown; value?: unknown } | undefined;
            if (method === "core.event" && e?.type === "plugin_ui_message" && e.pluginId === part.entry.pluginId && e.event === "clover.avatar.changed") listener(e.value);
          });
        },
      } as unknown as PluginApi["avatar"],
      // What the user hands the page (`files.pick*`, gesture-bound, served by the app's main process, which opens its own dialog):
      // tokens for the plugin's host half (`host.call`) and the media URL below; nothing else of `files` is in a layer.
      files: {
        pickOpen: (opts?: unknown) => call<unknown>("files.pickOpen", opts ?? {}),
        pickFolder: (opts?: unknown) => call<unknown>("files.pickFolder", opts ?? {}),
        pickSave: (opts?: unknown) => call<unknown>("files.pickSave", opts ?? {}),
        onDrop: (listener: (grants: unknown[], refused?: string) => void): Unsubscribe => onLayerMessage((m) => {
          if (m.type === "files-dropped") listener([...m.grants], m.refused);
        }),
        url: (token: string) => {
          const id = /^grant:([0-9a-f-]{36})$/.exec(token)?.[1];
          if (id === undefined) throw new Error("not a file token");
          return `/_g/${id}`;
        },
      } as unknown as PluginApi["files"],
      plugin: { id: part.entry.pluginId } as PluginApi["plugin"],
      // The entries of a point the part's own tree declares (§5.4: the declarer reads them), as its host half reads them
      // (`plugin.layer.call`'s `points.entries`), and a watch that reads them again on `plugin_point_changed` (the
      // point's name only, which the core sends to this plugin's own connection). Calling an entry's handler is the
      // host half's (`points.call`): a component asks its host half with `host.call`.
      points: {
        entries: <T,>(point: string) => call<{ result: T[] }>("plugin.layer.call", { call: "points.entries", args: [point] }).then((r) => r.result),
        watch: <T,>(point: string, listener: (entries: T[]) => void): Unsubscribe => {
          subscribe(part.mount, part.entry.pluginId, "plugins");
          let live = true;
          // One read at a time; a change heard during a read reads once more after it, and a refused read (the
          // plugin's calls-per-second cap) is tried again a moment later, so the last change is never lost.
          let reading = false;
          let again = false;
          let retry: ReturnType<typeof setTimeout> | undefined;
          const read = (): void => {
            if (!live) return;
            if (reading) { again = true; return; }
            reading = true;
            again = false;
            void call<{ result: T[] }>("plugin.layer.call", { call: "points.entries", args: [point] }).then(
              (r) => { reading = false; if (live) listener(r.result); if (again) read(); },
              () => { reading = false; if (live && retry === undefined) retry = setTimeout(() => { retry = undefined; read(); }, 1_000); },
            );
          };
          const off = onApiEvent(part.entry.pluginId, (method, params) => {
            const e = params as { type?: unknown; pluginId?: unknown; point?: unknown } | undefined;
            if (method !== "core.event" || e?.type !== "plugin_point_changed" || e.pluginId !== part.entry.pluginId || e.point !== point) return;
            read();
          });
          return () => { live = false; if (retry !== undefined) clearTimeout(retry); off(); };
        },
        call: unavailable("points.call"),
      } as unknown as PluginApi["points"],
      commands: { list: unavailable("commands"), run: unavailable("commands") } as unknown as PluginApi["commands"],
      // The part's own plugin, on its own connection (`plugin.layer.call`; the core takes the plugin from the
      // connection): its host half's handlers, as the plugin, never as the user; its host half's messages
      // (`ui.send`, which only its own layer hears); and its synced store, read only (its host half writes it).
      host: {
        call: <T,>(handler: string, args?: unknown, opts?: { timeoutMs?: number }) =>
          call<{ result: T }>("plugin.layer.call", { call: "host.call", args: [handler, args ?? null, ...(opts?.timeoutMs !== undefined ? [{ timeoutMs: opts.timeoutMs }] : [])] }).then((r) => r.result),
        on: (event: string, listener: (data: unknown) => void): Unsubscribe => {
          subscribe(part.mount, part.entry.pluginId, "plugins");
          return onApiEvent(part.entry.pluginId, (method, params) => {
            const e = params as { type?: unknown; pluginId?: unknown; event?: unknown; value?: unknown } | undefined;
            if (method === "core.event" && e?.type === "plugin_ui_message" && e.pluginId === part.entry.pluginId && e.event === event) listener(e.value);
          });
        },
      } as unknown as PluginApi["host"],
      ui: { send: () => { throw new Error("ui.send is a host half's; a component calls its host half with host.call"); } } as unknown as PluginApi["ui"],
      storage: {
        synced: {
          get: <T,>(key: string) => call<{ result: T | undefined }>("plugin.layer.call", { call: "storage.synced.get", args: [key] }).then((r) => r.result),
          keys: () => call<{ result: string[] }>("plugin.layer.call", { call: "storage.synced.keys", args: [] }).then((r) => r.result),
          set: () => Promise.reject(new Error("a component doesn't write its plugin's store: its host half does (host.call)")),
          delete: () => Promise.reject(new Error("a component doesn't write its plugin's store: its host half does (host.call)")),
          watch: (listener: (key: string) => void): Unsubscribe => {
            subscribe(part.mount, part.entry.pluginId, "plugins");
            return onApiEvent(part.entry.pluginId, (method, params) => {
              const e = params as { type?: unknown; pluginId?: unknown; key?: unknown } | undefined;
              if (method === "core.event" && e?.type === "plugin_store_changed" && e.pluginId === part.entry.pluginId && typeof e.key === "string") listener(e.key);
            });
          },
        },
      } as unknown as PluginApi["storage"],
      net: { fetch: unavailable("net.fetch") } as unknown as PluginApi["net"],
      settings: {
        // Its own plugin's settings. A third-party layer reads them on its own connection (`plugin.layer.call`'s
        // `settings.get`: the value in effect, a `secret` field only as `{ set }`, and with no bot, so a `bot` field reads
        // as nothing). The bundled `clover` tree's parts share the app's own connection, where the main process lets
        // its Settings and Plugins parts read `plugin.settings.get` (tree-calls.ts).
        get: async <T,>(key: string, opts?: { bot?: string }) => {
          const pluginId = part.entry.pluginId;
          if (pluginId === "clover" || pluginId.startsWith("clover/")) {
            const r = await call<{ settings: { key: string; value?: unknown }[] }>("plugin.settings.get", { id: pluginId, ...(opts?.bot !== undefined ? { bot: opts.bot } : {}) });
            return r.settings.find((x) => x.key === key)?.value as T | undefined;
          }
          if (opts?.bot !== undefined) throw new Error("a page reads its plugin's settings with no bot: a bot's value is its host half's to read");
          return (await call<{ result: T | undefined }>("plugin.layer.call", { call: "settings.get", args: [key] })).result;
        },
        // A third-party page changes its own plain settings on its own connection, with no card (`plugin.layer.call`'s
        // `settings.set`: never a secret, a bot value or a setting written into what the plugin runs). The bundled
        // tree's parts go through `plugin.settings.set` on the app's own connection, as before.
        set: async (key: string, value: unknown, opts?: { bot?: string }) => {
          const pluginId = part.entry.pluginId;
          if (pluginId === "clover" || pluginId.startsWith("clover/")) {
            await call<unknown>("plugin.settings.set", { id: pluginId, key, value: value ?? null, ...(opts?.bot !== undefined ? { bot: opts.bot } : {}) });
            return;
          }
          if (opts?.bot !== undefined) throw new Error("a page changes its plugin's settings with no bot: a bot's value is its host half's to change");
          await call<unknown>("plugin.layer.call", { call: "settings.set", args: [key, value ?? null] });
        },
        // Its own plugin's settings only (`plugin_settings_changed`, which the core sends to that plugin's own layer):
        // the key that changed, never its value; `null` hears every key.
        watch: (key: string | null, listener: (key: string) => void): Unsubscribe => {
          subscribe(part.mount, part.entry.pluginId, "plugins");
          return onApiEvent(part.entry.pluginId, (method, params) => {
            const e = params as Record<string, unknown> | undefined;
            if (method !== "core.event" || e?.type !== "plugin_settings_changed" || e.pluginId !== part.entry.pluginId || typeof e.key !== "string") return;
            if (key === null || e.key === key) listener(e.key);
          });
        },
      } as PluginApi["settings"],
      confirm: unavailable("confirm") as unknown as PluginApi["confirm"],
      t,
    } as PluginApi;
  }, [part.entry.pluginId, part.mount, t]);
}

/** A menu the core shows for this part (it crosses the frame's edge, so the core draws it, natively): data only,
 *  at a point in this frame's viewport; resolves with the id picked, or null. Not in lane B's declarations yet. */
export function useMenu(): (items: readonly MenuItem[], at: { x: number; y: number }) => Promise<string | null> {
  const part = usePart();
  return useCallback((items: readonly MenuItem[], at: { x: number; y: number }) => rt().bridge.menu(part.mount, items, at.x, at.y), [part.mount]);
}

/** A surface's window (the island, the pill): show or hide it, size it, and say where it takes clicks. Only the part
 *  a surface window's root placed steers it. Not in lane B's declarations yet. */
export function useSurface(): (request: SurfaceRequest) => void {
  return useCallback((request: SurfaceRequest) => rt().bridge.surface(request), []);
}

/** Where this part's surface window lives (the OS, the display server, the display and its camera housing), kept
 *  current as the display changes; undefined outside a surface window, and until the core answers. Not in lane B's
 *  declarations yet. */
export function useSurfaceEnvironment(): SurfaceEnvironment | undefined {
  const [env, setEnv] = useState<SurfaceEnvironment | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void rt().bridge.surfaceEnvironment().then((e) => {
      if (live && e !== undefined) setEnv(e);
    }, () => undefined);
    const off = onLayerMessage((m) => {
      if (m.type === "surface-environment") setEnv(m.environment);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return env;
}

/** Opens a place in the main window (Settings at a section and an item, a bot's tab): for the `clover` tree's parts,
 *  such as the island's Usage and Devices tabs. Not in lane B's declarations yet. */
export function useOpen(): (target: OpenTarget) => Promise<void> {
  const part = usePart();
  return useCallback((target: OpenTarget) => rt().bridge.open(part.mount, target), [part.mount]);
}

/** How often a placed native view's frame is measured again, besides its resizes (a move with no resize). */
export const VIEW_FRAME_POLL_MS = 250;

/** Places a native view the core draws over this part (the Clover Browser's live view, `name` "browser"): the ref
 *  callback goes on the element the view should cover, and the core keeps the view on it as it moves, resizes, hides
 *  or goes. The core clips the view to this part's own frame, and only a plugin with the `browser` capability places
 *  one. With two parts placing the same view, the one the person used last has it (ruling R8). Not in lane B's
 *  declarations yet. */
export function useViewFrame(name: string): (el: HTMLElement | null) => void {
  const part = usePart();
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (el === null) return;
    const bridge = rt().bridge;
    let last = "";
    const measure = (used = false) => {
      const b = el.getBoundingClientRect();
      const shown = b.width > 0 && b.height > 0 && document.visibilityState !== "hidden" && el.isConnected;
      const rect = shown ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
      const key = JSON.stringify(rect);
      if (!used && key === last) return;
      last = key;
      bridge.viewFrame(part.mount, name, rect, used || undefined);
    };
    // Placed: the newest place gets the view until the person uses another.
    measure(true);
    return trackRect(el, () => measure(), () => bridge.viewFrame(part.mount, name, null), { onUse: () => measure(true) });
  }, [el, name, part.mount]);
  return setEl;
}

/** Drags between parts through the core (the drag broker): `offer` returns a token for the drag's
 *  `DRAG_GRANT_TYPE`, `claim` turns a dropped token into the data, if this part's plugin may hold it. Not in lane B's
 *  declarations yet. */
export function useDrag(): { offer(offer: DragOffer): Promise<string | undefined>; claim(token: string): Promise<DragOffer | undefined> } {
  const part = usePart();
  return useMemo(() => ({
    offer: async (offer: DragOffer) => {
      const r = await rt().bridge.dragOffer(part.mount, offer);
      return "token" in r ? r.token : undefined;
    },
    claim: async (token: string) => {
      const r = await rt().bridge.dragClaim(part.mount, token);
      return "error" in r ? undefined : r;
    },
  }), [part.mount]);
}

/** A spot this part declares, as its entries in the spot's order, kept current (lane B's `useSpotEntries`): for a part
 *  that draws one at a time with `<Spot entry>` (the island's tabs, the pill's targets). */
export function useSpotEntries(name: string, spotKey?: string): { readonly entries: readonly SpotEntryView[]; subscribe(listener: () => void): Unsubscribe } {
  const part = usePart();
  const [entries, setEntries] = useState<readonly SpotEntryView[]>([]);
  const listeners = useRef(new Set<() => void>());
  useEffect(() => {
    let live = true;
    const load = () => void rt().bridge.entries(part.mount, name, spotKey).then((e) => {
      if (!live) return;
      setEntries((old) => (JSON.stringify(old) === JSON.stringify(e) ? old : e));
    }, () => undefined);
    load();
    const off = onLayerMessage((m) => {
      if (m.type === "respot") load();
    });
    return () => {
      live = false;
      off();
    };
  }, [part.mount, name, spotKey]);
  useEffect(() => {
    for (const l of listeners.current) l();
  }, [entries]);
  return useMemo(() => ({
    entries,
    subscribe: (listener: () => void) => {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
  }), [entries]);
}

/** Questions waiting in any session the plugin may read, with their text (lane B's `useQuestions`; the core sends them
 *  only to a plugin with `conversation.read`). */
export function useQuestions(): { readonly questions: readonly PendingQuestion[]; subscribe(listener: () => void): Unsubscribe } {
  const [questions, setQuestions] = useState<readonly PendingQuestion[]>(() => rt().questions);
  const listeners = useRef(new Set<() => void>());
  useEffect(() => onLayerMessage((m) => {
    if (m.type === "questions") setQuestions(m.questions);
  }), []);
  useEffect(() => {
    for (const l of listeners.current) l();
  }, [questions]);
  return useMemo(() => ({
    questions,
    subscribe: (listener: () => void) => {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
  }), [questions]);
}

/** The window's own state, apps and acts (`PluginApi.shell`): each is a call to the app, which checks the plugin's capability, that one of its bots shows
 *  its tab, and, for an act, the user's own key press or click in this frame. */
function shellApi(mount: string): NonNullable<PluginApi["shell"]> {
  const ask = <T,>(method: ShellMethod, args?: unknown) => rt().bridge.shell(mount, method, args) as Promise<T>;
  const act = (method: ShellMethod, args?: unknown): Promise<void> => {
    const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
    if (activation !== undefined && !activation.isActive) return Promise.reject(new Error("a shell call goes only from inside the user's key press or click"));
    return ask<void>(method, args).then(() => undefined);
  };
  return {
    state: () => ask<ShellState>("state"),
    watch: (listener) => {
      let live = true;
      void ask<ShellState>("state").then((s) => live && listener(s), () => undefined);
      const off = onLayerMessage((m) => { if (m.type === "shell-state" && live) listener(m.state); });
      return () => { live = false; off(); };
    },
    apps: () => ask<readonly ShellApp[]>("apps"),
    account: () => ask<ShellAccount>("account"),
    openBotEditor: (bot) => act("openBotEditor", { bot }),
    openPanel: (view) => act("openPanel", { view }),
    closePanel: (view) => act("closePanel", { view }),
    togglePanel: (view) => act("togglePanel", { view }),
    setSidebar: (collapsed) => act("setSidebar", { collapsed }),
    toggleSidebar: () => act("toggleSidebar"),
    go: (target) => act("go", { target }),
    openSettings: (section) => act("openSettings", { section }),
    // The press that starts a drag is the user's own, which main saw itself (it moves the window from its own sight of the pointer): no activation is asked here.
    provide: (parts) => ask<void>("provide", { parts }).then(() => undefined),
    dragWindow: () => ask<void>("dragWindow").then(() => undefined),
  };
}

/** For the `clover` shell: tells the core where the window is, for the plugin frames that read it (`shell.state`). */
export function useShellReport(): (report: { state: ShellState; apps: readonly ShellApp[]; account?: ShellAccount }) => void {
  const part = usePart();
  return useCallback((report) => rt().bridge.shellReport(part.mount, report), [part.mount]);
}

/** The user's own words, sent from inside the key press or click that sends them (lane B's `useUserSend`; the
 *  Dispatch pill's). The entry in the `composer` spot has it (whichever plugin's), and the bundled `clover` tree's surfaces (the pill); elsewhere it is undefined. The runtime counts
 *  a send only within the frame's transient user activation, and the core only after it saw that input come to the
 *  window, one send for one press or click; any other is refused and sends nothing. */
export function useUserSend(): ((to: UserSendTarget, message: string | { text: string; images?: readonly { mediaType: "image/png" | "image/jpeg" | "image/webp"; data: Uint8Array }[] }) => Promise<void>) | undefined {
  const part = usePart();
  // The core decides again, from the mount it made: the entry in the `composer` spot (any plugin's), or a part of
  // the bundled `clover` tree. This only hides the hook from the rest.
  const allowed = part.entry.spot === "composer" || part.entry.pluginId.split("/")[0] === "clover";
  const send = useCallback(async (to: UserSendTarget, message: string | { text: string; images?: readonly { mediaType: "image/png" | "image/jpeg" | "image/webp"; data: Uint8Array }[] }) => {
    const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
    if (activation !== undefined && !activation.isActive) throw new Error("the user's words go only from inside their key press or click");
    const m = typeof message === "string" ? { text: message } : message;
    await rt().bridge.userSend(part.mount, to, m);
  }, [part.mount]);
  return allowed ? send : undefined;
}

/** What the `composer` spot hands the entry the core mounted there (spec §5.5, lane E): the models its session can
 *  switch to, a model switch, and interrupt and stop. Each acting call counts only inside the user's own key press or
 *  click. On a bot's main conversation a model switch changes a user layer: the `clover` layer's entry changes it
 *  directly, any other plugin's ends in the sealed card the core raises for it. Undefined outside that spot. */
export interface ComposerHost {
  models(): Promise<{ models: { id: string; name?: string; providerName?: string; efforts?: string[] }[]; default?: string }>;
  setModel(model: string, effort?: string): Promise<unknown>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  /** The slash menu's commands: those of plugins that are on, OK'd and running, the bot's own plugin's first. The
   *  bundled composer's only (another plugin's entry is refused). */
  commands(): Promise<{ commands: ComposerCommand[] }>;
  /** Runs `<namespace>.<name>` as the user, with `args` for that command's plugin alone, inside the user's own key
   *  press or click; the result is the handler's. The bundled composer's only. */
  runCommand(name: string, args?: unknown): Promise<{ result: unknown }>;
}

/** A command the slash menu lists (`ComposerHost.commands`). */
export interface ComposerCommand {
  /** `<namespace>.<name>`. */
  name: string;
  pluginId: string;
  pluginName: string;
  description: string;
  /** The JSON Schema of its args. */
  args?: Record<string, unknown>;
  /** The sessions its plugin serves. */
  scope?: "bots" | "agents" | "both";
  /** The bot's own plugin's. */
  own: boolean;
}

export function useComposerHost(): ComposerHost | undefined {
  const part = usePart();
  const inSpot = part.entry.spot === "composer";
  return useMemo(() => {
    if (!inSpot) return undefined;
    const ask = (op: "models" | "setModel" | "interrupt" | "stop" | "commands" | "runCommand", args?: unknown) => rt().bridge.composer(part.mount, op, args);
    return {
      models: () => ask("models") as ReturnType<ComposerHost["models"]>,
      setModel: (model, effort) => ask("setModel", { model, ...(effort !== undefined ? { effort } : {}) }),
      interrupt: () => ask("interrupt").then(() => undefined),
      stop: () => ask("stop").then(() => undefined),
      commands: () => ask("commands") as ReturnType<ComposerHost["commands"]>,
      runCommand: (name, args) => ask("runCommand", { name, ...(args !== undefined ? { args } : {}) }) as ReturnType<ComposerHost["runCommand"]>,
    };
  }, [inSpot, part.mount]);
}

/** The core client of the bundled `clover` tree's parts (lane F's `useCore`; not in lane B's declarations): any call
 *  the `layer` role makes, on the part's own plugin's connection, and the core events it subscribed to. Undefined for
 *  any other plugin's part. */
export interface CoreClient {
  call(method: string, params?: unknown): Promise<any>;
  on(event: string, listener: (event: Record<string, unknown>) => void): Unsubscribe;
}


export function useCore(): CoreClient | undefined {
  const part = usePart();
  const pluginId = part.entry.pluginId;
  const tree = pluginId === "clover" || pluginId.startsWith("clover/");
  return useMemo(() => (!tree ? undefined : {
    call: (method: string, params?: unknown) => rt().bridge.api(part.mount, method, params ?? {}),
    on: (event: string, listener: (event: Record<string, unknown>) => void) => {
      const area = EVENT_AREAS[event];
      if (area !== undefined) subscribe(part.mount, pluginId, area);
      return onApiEvent(pluginId, (method, params) => {
        const e = params as Record<string, unknown> | undefined;
        if (method === "core.event" && e?.type === event) listener(e);
      });
    },
  }), [tree, part.mount, pluginId]);
}

/** State that outlives its document's reload in this window (`useState`'s shape): the user's place, a draft. A layer's
 *  document loads again when a plugin with its own layer is installed, turned on or updated (the frames it may hold are
 *  fixed when it is served), and what a part keeps this way is there again, from the first render, so the window shows
 *  the same page with no flash of another. Only a reload: the part's unmount (the user left the page) drops it, as it
 *  drops plain state, and so does a change of `key` (another conversation's draft starts from its own). A value that
 *  can't be stored or read is plain state.
 *
 *  Where it lives: the window's session storage (never `localStorage`), per plugin and key, as JSON. Session storage is
 *  per origin, and every plugin's layer is its own origin (`clover-plugin://<layer>/`): a third-party part's `useKept`
 *  is in its layer's store and can't read the shell's or the composer's, and theirs (the clover layer's) can't be read
 *  by a third-party page. It goes when the window closes; Clover writes none of it to disk (what Chromium does with a
 *  session's storage is its own, and Clover keeps no session to restore). The `clover.kept:<plugin>:` prefix is a
 *  namespace among one layer's plugins, not a boundary: keep in it only the user's place and their own unsent words.
 *  A draft there (the composer's, keyed by its conversation's id only) may hold something pasted, a secret even: it is
 *  no more exposed than the text field it is typed in, which the same document already holds. */
export function useKept<T>(key: string, initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
  const pluginId = useContext(PartContext)?.entry.pluginId ?? "clover";
  const storeKey = `clover.kept:${pluginId}:${key}`;
  const read = (k: string): T => {
    try {
      const raw = globalThis.sessionStorage?.getItem(k);
      if (raw !== null && raw !== undefined) return JSON.parse(raw) as T;
    } catch {
      /* no storage, or not JSON: the initial value */
    }
    return typeof initial === "function" ? (initial as () => T)() : initial;
  };
  const [state, setState] = useState(() => ({ k: storeKey, v: read(storeKey) }));
  const current = state.k === storeKey ? state : { k: storeKey, v: read(storeKey) };
  if (current !== state) setState(current);
  useEffect(() => {
    try {
      if (current.v === undefined) globalThis.sessionStorage?.removeItem(current.k);
      else globalThis.sessionStorage?.setItem(current.k, JSON.stringify(current.v));
    } catch {
      /* too large, or no storage: kept for this document only */
    }
  }, [current.k, current.v]);
  // An unmount, or another key: this one goes. A document that goes away runs no cleanup, so a reload keeps it.
  useEffect(() => () => {
    try {
      globalThis.sessionStorage?.removeItem(storeKey);
    } catch {
      /* no storage */
    }
  }, [storeKey]);
  const set = useCallback((next: T | ((prev: T) => T)) => setState((s) => ({ k: s.k, v: typeof next === "function" ? (next as (prev: T) => T)(s.v) : next })), []);
  return [current.v, set];
}

/** The entry this component renders as (lane F's `useEntry`). */
export function useEntry(): EntryProps["entry"] | undefined {
  return useContext(PartContext)?.entry;
}

/** Whether a mouse press at `target` is on a title-bar area: the nearest element up the tree that declares an app
 *  region says `drag` (and not `no-drag`, which a button in the bar declares). */
export function onDragRegion(target: EventTarget | null, style: (el: Element) => string = (el) => getComputedStyle(el).getPropertyValue("-webkit-app-region")): boolean {
  for (let el = target instanceof Element ? target : null; el !== null; el = el.parentElement) {
    const v = style(el).trim();
    if (v === "drag") return true;
    if (v === "no-drag") return false;
  }
  return false;
}

/** The shell's window moves by its title areas (`-webkit-app-region: drag` in its CSS): Chromium honors the CSS only in
 *  a window's main frame, and the shell is a frame, so a press on a drag region is told to the core, which moves the
 *  window itself, from the press and the cursor it saw (window-drag.ts). The core refuses it from any other part.
 *  Not in lane B's declarations. */
export function useWindowDrag(): void {
  const part = usePart();
  useEffect(() => {
    const bridge = rt().bridge;
    const down = (e: MouseEvent) => {
      if (e.button !== 0 || e.defaultPrevented || !onDragRegion(e.target)) return;
      bridge.windowDrag(part.mount);
    };
    document.addEventListener("mousedown", down, true);
    return () => document.removeEventListener("mousedown", down, true);
  }, [part.mount]);
}

/** The session this window shows (the `clover` layer's shell says so; the core refuses it from any other layer): a
 *  desktop notification for it waits while the app is in front. Not in lane B's declarations. */
export function useActiveSession(session: string | undefined): void {
  const part = usePart();
  useEffect(() => {
    const bridge = rt().bridge;
    bridge.activeSession(part.mount, session ?? null);
    return () => bridge.activeSession(part.mount, null);
  }, [part.mount, session]);
}

/** Pending cards without their text. Sealed cards come in E-M3: none until then. */
export function useApprovals(): { readonly cards: readonly CardMeta[]; subscribe(listener: () => void): Unsubscribe } {
  // The `approvals` are here only as ids, where they are and what they ask (§5.5). The runtime routes the core's
  // `card_pending` events through the layer's connection; a card answered elsewhere goes as `card_resolved`.
  const part = usePart();
  const mount = part.mount;
  const pluginId = part.entry.pluginId;
  useEffect(() => subscribe(mount, pluginId, "approvals"), [mount, pluginId]);
  const [cards, setCards] = useState(() => rt().cards);
  // The cards already pending when this part mounts (a document loaded again, a part placed after a card was raised):
  // the events only bring what comes next. Refused without the `approvals` capability, which leaves the list as it is.
  useEffect(() => {
    let live = true;
    void rt().bridge.api(mount, "card.pending", {}).then((r) => {
      const now = (r as { cards?: unknown } | undefined)?.cards;
      if (!live || !Array.isArray(now)) return;
      const known = new Set(rt().cards.map((c) => c.id));
      const added = (now as CardMeta[]).filter((c) => typeof c?.id === "string" && !known.has(c.id) && !resolvedCards.has(c.id));
      if (added.length === 0) return;
      rt().cards = [...rt().cards, ...added];
      setCards([...rt().cards]);
    }, () => undefined);
    return () => { live = false; };
  }, [mount]);
  const listeners = useRef(new Set<() => void>());
  useEffect(() => onLayerMessage(() => setCards([...rt().cards])), []);
  useEffect(() => { for (const l of listeners.current) l(); }, [cards]);
  return useMemo(() => ({ cards, subscribe: (listener: () => void) => { listeners.current.add(listener); return () => listeners.current.delete(listener); } }), [cards]);
}

// Sealed cards (E-M3, §5.5): a part with the `approvals` capability places each card's sealed frames — its fields'
// words and its buttons' own, one frame each, from the app's sealed scheme. The part positions and styles the
// element; the frames' contents are the core's, and the plugin never reads them. `<Card id>`'s place requests the
// frames by id and element; a card answered elsewhere draws nothing, so its place is the part's own.
/** The sealed element's own frame, sized by what the core's page says about itself and nothing else. The page tells its
 *  frame a number (`postMessage`: its height, a button's width and height), never a word; until it has, the frame takes
 *  no room, so a card that is still arriving shows nothing rather than an empty box. A field's height is the page's, up
 *  to `lines` lines when the part asks for fewer (the frame then scrolls inside, so nothing sealed is cut unseen). The
 *  part's own layout still decides where the frame goes and how wide it is. */
function SealedFrame({ mount, cardId, kind, name, look, lines, size, tokens, fontPx, onReady }: { mount: string; cardId: string; kind: "field" | "button"; name?: string; look?: "label" | "check" | "cross" | "open"; lines?: number; size?: number; tokens: Readonly<Record<string, TokenValue>>; fontPx: number; onReady?: (ready: boolean) => void }) {
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [absent, setAbsent] = useState(false);
  const [box, setBox] = useState<{ width?: number; height?: number }>({});
  const [loaded, setLoaded] = useState(false);
  const frame = useRef<HTMLIFrameElement | null>(null);
  // The card's own style values (`card.*`, §5.5), by value so a new object each render doesn't ask for a new frame.
  const tokenKey = JSON.stringify(tokens);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    // The app may not have heard of the card the moment this part does (two connections, two events): ask again for a
    // moment, rather than leave an empty place for good.
    const ask = () => {
      void rt().bridge.sealedFrame?.(mount, cardId, kind === "field" ? `field:${name}` : `button:${name}`, look, JSON.parse(tokenKey) as Record<string, TokenValue>).then((u) => {
        if (!live) return;
        if (u === "") setAbsent(true);
        else if (u !== undefined) setSrc(u);
        else if (++tries < 12) timer = setTimeout(ask, 150 * Math.min(tries, 5));
      }).catch(() => undefined);
    };
    ask();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [mount, cardId, kind, name, look, tokenKey]);
  useEffect(() => {
    const on = (event: MessageEvent) => {
      if (frame.current === null || event.source !== frame.current.contentWindow) return;
      const said = (event.data as { cloverSealedSize?: { width?: unknown; height?: unknown } } | null)?.cloverSealedSize;
      if (said === null || typeof said !== "object" || said === undefined) return;
      const n = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.ceil(v), max) : undefined);
      const width = n(said.width, 1200);
      const height = n(said.height, 4000);
      setBox((b) => (b.width === width && b.height === height ? b : { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) }));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  // A page that never says its size (a script blocked, a slow start) is given a few lines after a moment, so it is never
  // a frame of no height for good.
  useEffect(() => {
    if (src === undefined || !loaded || box.height !== undefined) return;
    const t = setTimeout(() => setBox((b) => (b.height !== undefined ? b : { ...b, height: Math.ceil(fontPx * 1.4 * (kind === "field" ? Math.min(lines ?? 3, 3) : 2)) })), 1200);
    return () => clearTimeout(t);
  }, [src, loaded, box.height, kind, lines, fontPx]);
  const ready = src !== undefined && loaded && box.height !== undefined;
  useEffect(() => {
    onReady?.(absent || ready);
    return () => onReady?.(true);
  }, [absent, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  if (absent || src === undefined) return null;
  const cap = kind === "field" && lines !== undefined ? Math.ceil(lines * fontPx * 1.38) + 2 : undefined;
  const style: CSSProperties = { border: "none", display: "block", colorScheme: "light dark" };
  if (kind === "field") {
    style.width = "100%";
    style.height = box.height === undefined ? 0 : cap === undefined ? box.height : Math.min(box.height, cap);
  } else if (look !== undefined && look !== "label") {
    const side = Math.max(24, size ?? 30);
    style.width = side;
    style.height = side;
  } else {
    style.width = box.width ?? 0;
    style.height = box.height ?? 0;
  }
  return <iframe ref={frame} src={src} onLoad={() => setLoaded(true)} data-clover-sealed={`${kind}:${name}`} style={style} title={kind === "field" ? `card field ${name}` : `card button ${name}`} referrerPolicy="no-referrer" sandbox={undefined} />;
}

/** A pixel size from a `card.font.size` token ("15px"), or the stylesheet's own 14. */
function fontPxOf(tokens: Readonly<Record<string, TokenValue>>): number {
  const raw = tokens["card.font.size"];
  const m = typeof raw === "string" ? /^(\d+(?:\.\d+)?)px$/.exec(raw.trim()) : null;
  return m !== null ? Number(m[1]) : 14;
}

export function Card({ id, tokens, className, children }: CardElementProps) {
  const part = usePart();
  const present = useApprovals().cards.some((c) => c.id === id);
  if (!present) return null;
  // The card's own tokens go in alone (§5.5): the values the part resolved, clipped to `card.*` names. The runtime's
  // mint passes them to the frames (the sdk's own `tokens` prop stays what a part overrides).
  const given: Readonly<Record<string, TokenValue>> | undefined = tokens === undefined
    ? Object.fromEntries(Object.entries(part.tokens).filter(([name, v]) => name.startsWith("card.") && typeof v === "string"))
    : Object.fromEntries(Object.entries(tokens).filter(([name, v]) => name.startsWith("card.")));
  return (
    <div data-clover-card={id} className={className}>
      <CardOwner.Provider value={{ mount: part.mount, cardId: id, tokens: given }}>{children as never}</CardOwner.Provider>
    </div>
  );
}

const CardOwner = createContext<{ mount: string; cardId: string; tokens: Readonly<Record<string, TokenValue>> } | null>(null);

/** Told when a card's frames are all in place (each has its page, its size said), by the part that wants to hold a card
 *  back until it is whole: a card still arriving is not shown half empty. It is only a flag: no word of a frame is
 *  ever read. */
export const CardReadiness = createContext<{ report(key: string, ready: boolean): void } | null>(null);

function useReadyKey(prefix: string): ((ready: boolean) => void) | undefined {
  const readiness = useContext(CardReadiness);
  const key = useId();
  return useMemo(() => (readiness === null ? undefined : (ready: boolean) => readiness.report(`${prefix}${key}`, ready)), [readiness, prefix, key]);
}

export function CardField({ name, lines }: CardFieldProps) {
  const owner = useContext(CardOwner);
  const onReady = useReadyKey("f");
  if (owner === null) return null;
  return <SealedFrame mount={owner.mount} cardId={owner.cardId} kind="field" name={name} lines={lines} tokens={owner.tokens} fontPx={fontPxOf(owner.tokens)} onReady={onReady} />;
}

/** One sealed button: the option named, else the first of its kind from the card's options (`useApprovals()`), which a
 *  button with no option to answer for draws nothing. */
function CardOption({ kind, option, look, size }: CardButtonProps & { kind: "approve" | "deny" }) {
  const owner = useContext(CardOwner);
  const meta = useApprovals().cards.find((c) => c.id === owner?.cardId);
  const onReady = useReadyKey("b");
  if (owner === null) return null;
  const pick = option ?? meta?.options.find((o) => o.kind === kind)?.id;
  if (pick === undefined) return null;
  return <SealedFrame mount={owner.mount} cardId={owner.cardId} kind="button" name={pick} look={look} size={size} tokens={owner.tokens} fontPx={fontPxOf(owner.tokens)} onReady={onReady} />;
}

export function CardApprove(props: CardButtonProps) {
  return <CardOption kind="approve" {...props} />;
}

export function CardDeny(props: CardButtonProps) {
  return <CardOption kind="deny" {...props} />;
}

export const Cards = { Root: Card, Field: CardField, Approve: CardApprove, Deny: CardDeny };

/** MCP Apps views (E-M3): until then the tool's result shows as text, as for a page no component places. */
export const AppView = (_props: AppViewProps) => null;

/** The UI API as lane B declared it. */
export const CardKit: CardComponents = Object.assign(Card, { Field: CardField, Approve: CardApprove, Deny: CardDeny });
// The UI API as lane B declared it.
export const ui: UiApi = { Spot: Spot as unknown as UiComponent<SpotElementProps>, Card: CardKit, AppView, usePluginApi, useTokens, useT, useApprovals };
