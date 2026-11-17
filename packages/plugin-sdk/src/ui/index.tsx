// `@waifucave/moss-plugin-sdk/ui`: the UI API that a plugin's React components use (spec §5.5), implementing lane
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
import type { CardMeta } from "@waifucave/moss-protocol";
import type { TokenValue } from "../catalogs/tokens";
import { cssProperty } from "../catalogs/tokens";
import { COMPONENT_CALLS, fromLayerWire, listenerArgOf, toLayerWire } from "../catalogs/layer-calls";
import type { PluginApi, ShellAccount, ShellApp, ShellState, Unsubscribe } from "../api/plugin-api";
import type { StreamMeta, StreamOpenEvent, StreamOpenOptions, StreamReadEvent } from "../api/plugin-api";
import { acceptStreams, openPicture, openStream, pointStream, type StreamsTransport } from "../api/streams";
import type {
  AppViewProps, CardButtonProps, CardComponents, CardElementProps, CardFieldProps, EntryProps, SpotElementProps, UiApi, UiComponent,
} from "../api/ui-api";
import { CALLBACK_KEY, type DragOffer, type LayerBridge, type LayerMessage, type MenuItem, type MountContext, type MountInfo, type OpenTarget, type SpotItem, type SpotView, type SurfaceEnvironment, type SurfaceRequest, type ThemeSheet, type StringTable, type SpotEntryView, type PendingQuestion, type UserSendTarget, type ShellMethod } from "./bridge";
import { EMPTY_STRINGS, translate } from "./strings";
import { LayoutRoot } from "./layout";

export * from "./bridge";
// Mouth levels from speech (./mouth), for any part that moves a mouth: the five vowel weights from a speech feed, and
// `TimedSpeech` (./speech), a feed made from mouth levels stamped in epoch milliseconds.
export { TimedSpeech, type TimedSpeechClock, type TimedSpeechStats } from "./speech";
export { LipSync, SpeechRing, frameSource, ringSource, analyserSource, bufferSource, speechFrames, PushedSpeech, MAX_FRAME_SECONDS, visemeWeights, MouthSmoother, VISEMES, SHUT, SILENCE_RMS, FULL_RMS, DARK_HZ, BRIGHT_HZ, clamp01, rmsOf, spectralCentroidOf, FFT_SIZE, type LipSyncSource, type SpeechFeatureSource, type SpeechFeatures, type AnalyserLike, type VisemeWeights } from "./mouth";
// What a component needs of React, from the layer's own copy: a plugin that writes its components with these ships no
// React of its own (`moss plugin new`'s UI and point templates do).
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
  /** A test layer's plugin API (`ui/testing`): `usePluginApi` hands a part this object as it is. Never set in the app. */
  testApi?: (pluginId: string, mount?: string) => PluginApi | undefined;
  /** A test layer's own room in the window's session storage (`useKept`), so several layers in one document (a gallery)
   *  keep apart. Never set in the app. */
  testKeptScope?: (mount: string) => string;
  /** Whether a pending card is a test layer's own, for a part of it (several layers in one document hold their own
   *  cards). Never set in the app. */
  testOwnsCard?: (mount: string, cardId: string) => boolean;
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
  if (runtime === undefined) throw new Error("the MOSS UI runtime isn't set up in this document");
  return runtime;
}

/** Sets the layer up (the app's layer boot calls it once, before rendering). Not for plugins. */
export function configureLayer(input: { bridge: LayerBridge; modules?: Record<string, ClientModule> | Map<string, ClientModule>; load?: Runtime["load"]; sleepAfterMs?: number; testApi?: Runtime["testApi"]; testKeptScope?: Runtime["testKeptScope"]; testOwnsCard?: Runtime["testOwnsCard"] }): void {
  const r: Runtime = {
    bridge: input.bridge,
    // A map is kept as given (a test layer adds the modules of the layers it sets up later).
    modules: input.modules instanceof Map ? input.modules : new Map(Object.entries(input.modules ?? {})),
    ...(input.load ? { load: input.load } : {}),
    ...(input.testApi ? { testApi: input.testApi } : {}),
    ...(input.testKeptScope ? { testKeptScope: input.testKeptScope } : {}),
    ...(input.testOwnsCard ? { testOwnsCard: input.testOwnsCard } : {}),
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
      const el = typeof document === "undefined" ? undefined : Array.from(document.querySelectorAll("iframe[data-moss-mount]")).find((f) => f.getAttribute("data-moss-mount") === m.child);
      const b = el?.getBoundingClientRect();
      r.bridge.rectReply(m.id, b === undefined ? null : { x: b.x, y: b.y, width: b.width, height: b.height });
    }
    for (const l of r.listeners) l(m);
  });
  trackFocus();
}

/** Hears the core's messages to this document (app commands such as `open-settings`). For the `moss` layer's own
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

/** CSS custom properties for a set of tokens (`color.text` → `--moss-color-text`). */
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

/** The document's strings, as the core last sent them. */
const StringsContext = createContext<StringTable>(EMPTY_STRINGS);

/** What the `moss` layer tells the core about the parts under it: the kind of session they show (`when.session`).
 *  Heard from the `moss` layer only. Not for plugins. */
export const SpotHints = createContext<{ session?: string }>({});

function usePart(): Part {
  const part = useContext(PartContext);
  if (part === null) throw new Error("a MOSS UI hook ran outside a mounted entry");
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
    if (this.state.failed) return <div className="moss-part-stopped" role="status" data-moss-stopped={this.props.name}>This part stopped.</div>;
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

/** How long a part's document waits for an animation frame before it measures itself without one. */
const MEASURE_FALLBACK_MS = 250;

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
    root.setAttribute("data-moss-part", info.mount);
    if (info.tab !== undefined) root.setAttribute("data-moss-tab", info.tab);
    if (info.styled === true) root.setAttribute("data-moss-styled", "");
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
  // The spot this document fills, for the base sheet: a page in `main` or `panel` fills the column it is given and scrolls in itself.
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-moss-spot", info.spot);
  }, [info.spot]);
  useEffect(() => {
    // The core sizes the frame: report the content's height as it changes (the bottom of the part's own elements, so
    // a part that fills its frame reports the frame, and a small one its own size).
    const host = document.getElementById("moss-root") ?? document.body;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = -1;
    const report = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      let bottom = 0;
      for (const c of Array.from(host.children)) bottom = Math.max(bottom, c.getBoundingClientRect().bottom);
      const h = Math.ceil(bottom);
      if (h !== last) {
        last = h;
        r.bridge.reportSize(h);
      }
    };
    const measure = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = requestAnimationFrame(report);
      // A frame the browser isn't drawing yet is given no animation frame (seen with the display off: a part's frame, just
      // loaded, never got its first one), and a frame that never reports stays at an iframe's default 150 px in its
      // parent. The timer measures it all the same; whichever comes first reports, once.
      timer = setTimeout(report, MEASURE_FALLBACK_MS);
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
      clearTimeout(timer);
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
    return mod === undefined && r.load !== undefined ? null : <div className="moss-part-missing" role="status">This part has no component {info.component}.</div>;
  }
  const view = <EntryView part={part} component={component} props={props} />;
  return (
    <StringsContext.Provider value={strings}>
      {view}
    </StringsContext.Provider>
  );
}

/** Puts the themes' sheets in the head, after the part's own stylesheets and in the core's order (§5.5's stack: the
 *  later and the nearer win). A sheet whose text is unchanged keeps its element. */
export function applySheets(sheets: readonly ThemeSheet[], doc: Document = document): void {
  const head = doc.head;
  const old = new Map<string, HTMLStyleElement>();
  for (const el of Array.from(head.querySelectorAll<HTMLStyleElement>("style[data-moss-sheet]"))) old.set(el.getAttribute("data-moss-sheet") ?? "", el);
  for (const s of sheets) {
    let el = old.get(s.id);
    old.delete(s.id);
    if (el === undefined) {
      el = doc.createElement("style");
      el.setAttribute("data-moss-sheet", s.id);
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
  /** The bot whose tab shows, for the spots that offer `when.bot` outside a bot's tab (`sidebar`, `bar`): heard from the `moss` layer only. */
  forBot?: string;
  /** An entry in a frame of its own fills the room this part gives the spot (and scrolls inside itself), instead of
   *  taking the height its content reports: a drawing that is as big as its box, say. */
  fill?: boolean;
};

/** `<Spot name spotKey props>`: shows a spot this part declares (§5.5). */
export function Spot({ name, spotKey, entry: entryRef, only, props, fallback, forBot, fill }: SpotProps) {
  const entry = entryRef ?? only;
  const part = usePart();
  const hints = useContext(SpotHints);
  const r = rt();
  const [view, setView] = useState<SpotView | undefined>(undefined);
  // A panel's `when.session` (and what a conversation's spots need to read: a code session is read with `sessions.read`) is the kind of session the shell shows it for: the `moss` layer says so in the props it gives the spot (the main process heeds it from that layer only).
  const propKind = name === "panel" || name === "conversation" ? (props as { sessionKind?: unknown } | undefined)?.sessionKind : undefined;
  const session = hints.session ?? (typeof propKind === "string" ? propKind : undefined);
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
    // `data-moss-pending`: not resolved yet (a host that holds a tab until it is drawn reads it, the shell's KeptTab).
    return <div data-moss-spot={name} data-moss-key={spotKey} data-moss-empty={view?.hidden ? "hidden" : view?.undeclared ? "waiting" : ""} data-moss-pending={view === undefined ? "" : undefined} style={{ display: "contents" }}>{view !== undefined && !view.hidden ? fallback : null}</div>;
  }
  return (
    <div data-moss-spot={name} data-moss-key={spotKey} data-moss-conflict={view.conflict ? "" : undefined} style={{ display: "contents" }}>
      {view.items.map((item) => <SpotItemView key={item.mount} item={item} parent={part} spot={name} spotKey={view.key} props={props} fill={fill} />)}
    </div>
  );
}

function SpotItemView({ item, parent, spot, spotKey, props, fill }: { item: SpotItem; parent: Part; spot: string; spotKey: string | undefined; props: unknown; fill?: boolean | undefined }) {
  if (item.kind === "frame") return <LayerFrame item={item} props={props} spot={spot} {...(fill === true ? { fill: true } : {})} />;
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
  return <div ref={setEl} className="moss-web-part" data-moss-entry={item.ref} data-moss-web={item.mount} style={{ display: "block", width: "100%", height: "100%", minHeight: 120 }} />;
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
  const marks = { "data-moss-entry": item.ref, "data-moss-part": item.mount, "data-moss-tab": item.tab, "data-moss-styled": item.styled === true ? "" : undefined };
  if (item.layout !== undefined) {
    // A bot's layout: data the runtime draws as the tab's part, its spots the part's own. A layout's root fills the
    // place it is in, so it gets a box of its own (the theme's `contain` reaches it). Its spots get the tab's own props (the
    // bot and the session): the conversation and the composer in it are the tab's, and read them.
    const layout = item.layout;
    return (
      <div {...marks} data-moss-layout-part="" style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, height: "100%", ...own }}>
        <PartContext.Provider value={part}>
          <PartBoundary name={item.ref}>
            <LayoutRoot layout={layout} renderSpot={(spot, key) => <Spot name={spot} props={props as Record<string, unknown> | undefined} {...(key !== undefined ? { spotKey: key } : {})} />} />
          </PartBoundary>
        </PartContext.Provider>
      </div>
    );
  }
  const component = findComponent(r.modules.get(item.pluginId), item.component);
  if (component === undefined) return <div className="moss-part-missing" role="status" data-moss-entry={item.ref}>This part has no component {item.component}.</div>;
  return (
    <div {...marks} style={{ display: "contents", ...own }}>
      <EntryView part={part} component={component} props={props} />
    </div>
  );
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
/** The spots whose frames fill the room they are given and scroll inside themselves, instead of taking the height their
 *  content reports: the window's `main` and `panel` columns, and any spot whose declaring part asks it (`<Spot fill>`). */
const FILL_SPOTS: readonly string[] = ["main", "panel"];
/** In a flex column it takes what is left (and may shrink under it); anywhere else, the whole height of its container. */
const FILL_STYLE: CSSProperties = { height: "100%", flex: "1 1 0", minHeight: 0 };

function LayerFrame({ item, props, spot, fill: fillAsked }: { item: Extract<SpotItem, { kind: "frame" }>; props: unknown; spot: string; fill?: boolean }) {
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
  const fill = fillAsked === true || FILL_SPOTS.includes(spot);
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
      <div className="moss-part-stopped" role="status" data-moss-entry={item.ref} data-moss-gone={gone}>
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
    return <div ref={setEl} data-moss-entry={item.ref} data-moss-asleep="" style={{ display: "block", width: "100%", ...(fill ? FILL_STYLE : { height: height === undefined ? undefined : `${height}px` }) }} />;
  }
  return (
    <iframe
      ref={setEl}
      key={url}
      src={url}
      title={item.ref}
      data-moss-entry={item.ref}
      data-moss-layer={item.layer}
      data-moss-mount={item.mount}
      // Its document has drawn (its first size report since this URL loaded): a host holding a tab until it is drawn reads it.
      data-moss-drawn={drawnUrl === url ? "" : undefined}
      // A plugin's own isolated frame, and the `moss` layer's frames, which pass the permission down to a plugin page placed inside them.
      allow={[item.isolated === true || item.layer === "moss" ? "cross-origin-isolated" : "", item.microphone === true ? "microphone" : ""].filter((a) => a !== "").join("; ")}
      referrerPolicy="no-referrer"
      data-moss-fill={fill ? "" : undefined}
      style={{ display: "block", border: 0, width: "100%", ...(fill ? FILL_STYLE : { height: height === undefined ? undefined : `${height}px` }), colorScheme: "light dark", background: "transparent" }}
    />
  );
}

// -------------------------------------------------------------------------------------------------
// Hooks and the later parts
// -------------------------------------------------------------------------------------------------

/** Where the part is (its tab's bot, the surface, the OS, the window's material, safe mode). For the `moss` layer's
 *  own parts; not in lane B's declarations. */
export function useMountContext(): MountContext {
  const context = usePart().context;
  // `window.narrow` is live: the window's width class changing is told to every frame of the window.
  const [narrow, setNarrow] = useState(context.window?.narrow ?? false);
  useEffect(() => setNarrow(context.window?.narrow ?? false), [context]);
  useEffect(() => onLayerMessage((m) => {
    if (m.type === "window") setNarrow(m.narrow);
  }), []);
  return useMemo(() => ({ ...context, window: { narrow } }), [context, narrow]);
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

/** `terminal` (components of the bundled `moss` tree): what reaches a terminal the core derives from the trusted
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

/** A member called on the part's own plugin's connection (`plugin.layer.call`), its args and answer as the wire
 *  carries them (bytes as `{ $bytes }`, a `net.fetch` response as `{ $response }`). */
function layerCall(mount: string, path: string, args: readonly unknown[]): Promise<unknown> {
  const sent = [...args];
  while (sent.length > 0 && sent[sent.length - 1] === undefined) sent.pop();
  return (rt().bridge.api(mount, "plugin.layer.call", { call: path, args: toLayerWire(sent) }) as Promise<{ result: unknown }>).then((r) => fromLayerWire(r.result));
}

/** What a component's watch returns: its unsubscribe, with `opened`, which settles once the core opened the watch (or
 *  refused it, with why), and `ended`, which settles with why once the core ends the watch (the plugin stopped, was
 *  turned off or removed, lost the capability; the source ended) or it couldn't open. */
export type LayerUnsubscribe = Unsubscribe & { readonly opened: Promise<void>; readonly ended: Promise<string> };

/** A member that takes a listener, watched on the part's own plugin's connection (`plugin.layer.watch`): the core puts
 *  its own listener in that place and each value comes back as `plugin_api_event` to this connection alone. Values
 *  that land before the watch's id is known wait for it. */
/** How often, and how long apart, a watch refused for the page's calls-per-second cap is opened again. */
const WATCH_BUSY_TRIES = 5;
const WATCH_BUSY_RETRY_MS = 1_000;
const BUSY = /calls this second/;
function layerWatch(mount: string, pluginId: string, path: string, args: readonly unknown[], at: number): { stop: LayerUnsubscribe; opened: Promise<void> } {
  const listener = args[at];
  if (typeof listener !== "function") throw new Error(`${path} takes a listener`);
  subscribe(mount, pluginId, "plugins");
  const sent: unknown[] = [...args];
  sent[at] = null;
  while (sent.length > 0 && sent[sent.length - 1] === undefined) sent.pop();
  let id: string | undefined;
  let stopped = false;
  let endedWith: (why: string) => void = () => {};
  const ended = new Promise<string>((resolve) => { endedWith = resolve; });
  type ApiEvent = { type?: unknown; pluginId?: unknown; watch?: unknown; value?: unknown; ended?: { reason?: unknown } };
  const early: ApiEvent[] = [];
  const deliver = (e: ApiEvent) => {
    if (e.ended !== undefined) {
      off();
      endedWith(typeof e.ended.reason === "string" ? e.ended.reason : "the watch ended");
      return;
    }
    if (!stopped) (listener as (v: unknown) => void)(fromLayerWire(e.value));
  };
  const off = onApiEvent(pluginId, (method, params) => {
    const e = params as ApiEvent | undefined;
    if (method !== "core.event" || e?.type !== "plugin_api_event" || e.pluginId !== pluginId) return;
    if (id === undefined) {
      if (early.length < 256) early.push(e);
      return;
    }
    if (e.watch === id) deliver(e);
  });
  const unwatch = (watch: string) => void rt().bridge.api(mount, "plugin.layer.unwatch", { watch }).catch(() => undefined);
  // A watch refused only for the page's calls-per-second cap (many parts mounting at once) is opened again a moment
  // later, a few times, so a listener isn't lost to a busy second.
  const open = (tries: number): Promise<void> => (rt().bridge.api(mount, "plugin.layer.watch", { call: path, args: toLayerWire(sent) }) as Promise<{ watch: string }>).then((r) => {
    id = r.watch;
    if (stopped) return unwatch(r.watch);
    for (const e of early.splice(0)) if (e.watch === id) deliver(e);
  }, (err: unknown) => {
    const why = err instanceof Error ? err.message : String(err);
    if (!stopped && tries < WATCH_BUSY_TRIES && BUSY.test(why)) return new Promise<void>((resolve, reject) => setTimeout(() => open(tries + 1).then(resolve, reject), WATCH_BUSY_RETRY_MS));
    off();
    early.length = 0;
    endedWith(why);
    throw err;
  });
  const opened = open(0);
  const stop = Object.assign(() => {
    if (stopped) return;
    stopped = true;
    off();
    if (id !== undefined) unwatch(id);
  }, { opened, ended });
  return { stop, opened };
}

/** Every member the catalog gives components (`COMPONENT_CALLS`), each on the part's own plugin's connection: a call
 *  through `plugin.layer.call`, a member with a listener through `plugin.layer.watch` (`files.watch` resolves its
 *  unsubscribe once the watch is open; the rest return it at once). The specialized members below are laid over these. */
function catalogMembers(mount: string, pluginId: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const path of COMPONENT_CALLS) {
    const names = path.split(".");
    let at = root;
    for (const n of names.slice(0, -1)) at = (at[n] ??= {}) as Record<string, unknown>;
    const l = listenerArgOf(path);
    at[names[names.length - 1]!] = l === undefined
      ? (...args: unknown[]) => layerCall(mount, path, args)
      : l.async === true
        ? (...args: unknown[]) => {
          const w = layerWatch(mount, pluginId, path, args, l.at);
          return w.opened.then(() => w.stop);
        }
        : (...args: unknown[]) => {
          const w = layerWatch(mount, pluginId, path, args, l.at);
          w.opened.catch(() => undefined);
          return w.stop;
        };
  }
  return root;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
/** `over` laid on `base`: an object in both is merged, anything else is `over`'s. */
function layOver(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isPlain(v) && isPlain(out[k]) ? layOver(out[k] as Record<string, unknown>, v) : v;
  return out;
}

/** A `net.fetch` request as a component's connection carries it: the URL as a string, the headers as pairs, the body
 *  as a string or bytes (a stream, a form or a blob can't cross). */
function fetchInit(init: RequestInit | undefined): Record<string, unknown> | undefined {
  if (init === undefined) return undefined;
  const out: Record<string, unknown> = {};
  if (init.method !== undefined) out.method = init.method;
  if (init.headers !== undefined) out.headers = [...new Headers(init.headers).entries()];
  if (init.redirect !== undefined) out.redirect = init.redirect;
  const body = init.body;
  if (body !== undefined && body !== null) {
    if (typeof body === "string" || body instanceof Uint8Array) out.body = body;
    else if (body instanceof ArrayBuffer) out.body = new Uint8Array(body);
    else if (ArrayBuffer.isView(body)) out.body = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    else if (body instanceof URLSearchParams) out.body = body.toString();
    else throw new Error("a component's net.fetch body is a string or bytes");
  }
  return out;
}

/** `turns.take` from a component (§5.4 "Turns"): the take is a watch on the part's own plugin's connection (its events
 *  the listener's), and the `Turn` is made from its grant. `done` says so to the core, then ends the watch; the watch
 *  ending without it (this frame gone, the app quit) is the core's "gone". A refusal, or the take ended before its turn,
 *  rejects. */
function layerTurnTake(mount: string, pluginId: string, name: string, given?: { limitMs?: number; note?: string; signal?: AbortSignal }, onEvent?: (e: unknown) => void): Promise<unknown> {
  const opts = { ...(given?.limitMs !== undefined ? { limitMs: given.limitMs } : {}), ...(given?.note !== undefined ? { note: given.note } : {}) };
  const signal = given?.signal;
  return new Promise((resolve, reject) => {
    let over = false;
    let granted: { id: string; until: number } | undefined;
    let lostWith: (loss: "limit" | "stopped") => void = () => {};
    const lost = new Promise<"limit" | "stopped">((r) => { lostWith = r; });
    let stop: (() => void) | undefined;
    const finish = () => {
      over = true;
      signal?.removeEventListener("abort", abort);
      stop?.();
    };
    const turn = {
      get id() { return granted!.id; },
      get until() { return granted!.until; },
      lost,
      done: async () => {
        if (over || granted === undefined) return;
        const id = granted.id;
        over = true;
        signal?.removeEventListener("abort", abort);
        // Done first, then the watch's end: the other way round the core would hear the holder go, not finish.
        try {
          await layerCall(mount, "turns.done", [id]);
        } finally {
          stop?.();
        }
      },
      extend: async (ms: number) => {
        if (granted === undefined) throw new Error("the take is still waiting");
        const until = (await layerCall(mount, "turns.extend", [granted.id, ms])) as number;
        granted.until = until;
        return until;
      },
    };
    const listener = (raw: unknown) => {
      const e = raw as { type?: string; id?: string; until?: number; reason?: string };
      if (e.type === "granted" && typeof e.id === "string" && typeof e.until === "number") {
        granted = { id: e.id, until: e.until };
        resolve(turn);
      } else if (e.type === "extended" && granted !== undefined && typeof e.until === "number") granted.until = e.until;
      else if (e.type === "ended") {
        finish();
        if (granted === undefined) reject(new Error(`${name}: the take ended before its turn`));
        else if (e.reason === "limit" || e.reason === "stopped") lostWith(e.reason);
      }
      try {
        onEvent?.(raw);
      } catch {
        // the plugin's own listener
      }
    };
    const abort = () => {
      if (over) return;
      if (granted !== undefined) void turn.done().catch(() => {});
      else {
        finish();
        reject(new Error(`${name}: the take was aborted before its turn`));
      }
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort);
    const w = layerWatch(mount, pluginId, "turns.take", [name, opts, listener], 2);
    stop = w.stop;
    if (over) w.stop();
    w.opened.catch((err: unknown) => {
      if (over) return;
      over = true;
      signal?.removeEventListener("abort", abort);
      reject(err);
    });
    void w.stop.ended.then((why) => {
      if (over) return;
      finish();
      if (granted === undefined) reject(new Error(`${name}: the take ended before its turn (${why})`));
      else lostWith("stopped");
    });
  });
}

/** What the SDK's streams need of a component: a call and a watch on the part's own plugin's connection. */
function layerStreams(mount: string, pluginId: string): StreamsTransport {
  return {
    call: (path, args) => layerCall(mount, path, args),
    watch: (path, args, at) => {
      const w = layerWatch(mount, pluginId, path, args, at);
      return { stop: w.stop, opened: w.opened, ended: w.stop.ended };
    },
  };
}

/** The plugin API in this layer, each call on the part's own plugin's connection, where the core checks it as that
 *  plugin from the `ui` side, with the same capability, fence and limits as its host half's: every member the catalog
 *  gives components (`catalogMembers`), with these laid over them where a component's own path serves it (the pickers,
 *  `shell` and the app's own events through the app; `host.*`, `storage.synced`, `settings` and `points.watch` on its
 *  own plugin's events; `net.fetch`, which carries bytes). */
export function usePluginApi(): PluginApi {
  const part = usePart();
  const t = useT();
  const fake = rt().testApi?.(part.entry.pluginId, part.mount);
  return useMemo(() => {
    if (fake !== undefined) return fake;
    const call = <T,>(method: string, params: unknown) => rt().bridge.api(part.mount, method, params) as Promise<T>;
    return layOver(catalogMembers(part.mount, part.entry.pluginId), {
      turns: {
        take: (name: string, opts?: { limitMs?: number; note?: string; signal?: AbortSignal }, onEvent?: (e: unknown) => void) => layerTurnTake(part.mount, part.entry.pluginId, name, opts, onEvent),
      } as unknown as Partial<PluginApi["turns"]>,
      // `open`, `accept` and `points.stream` make Web streams from watches (the SDK's streams.ts); the rest of the area is
      // the catalog's calls.
      streams: {
        open: (name: string, opts?: StreamOpenOptions, onEvent?: (e: StreamOpenEvent) => void) => openStream(layerStreams(part.mount, part.entry.pluginId), name, opts, onEvent),
        accept: (name: string, onStream: (s: ReadableStream<Uint8Array>, meta: StreamMeta) => void) => acceptStreams(layerStreams(part.mount, part.entry.pluginId), name, onStream),
      } as unknown as Partial<PluginApi["streams"]>,
      // A live picture's frames a component reads are a Web stream made from a watch; publishing is a host half's.
      pictures: {
        open: (picture: string, opts?: { maxFps?: number; signal?: AbortSignal }) => openPicture(layerStreams(part.mount, part.entry.pluginId), picture, opts),
      } as unknown as Partial<PluginApi["pictures"]>,
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
        watch: (listener: (bot: unknown) => void, onRemoved?: (id: string) => void): Unsubscribe => {
          const off = watcher(part.mount, part.entry.pluginId, "sessions", "bot_changed", "bot")(listener);
          const offRemoved = onRemoved === undefined ? undefined : watcher<string>(part.mount, part.entry.pluginId, "sessions", "bot_removed", "id")(onRemoved);
          return () => { off(); offRemoved?.(); };
        },
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
      // The MOSS Browser, for the bundled browser panel (the core's `browser.*` methods on this plugin's own connection,
      // which serve that one plugin and the capability gate checks): the person's tabs, placed in a view and navigated. A
      // listener can't cross a call, so `watch` hears the core's `tab_changed` and `tab_closed` events instead.
      browser: {
        tabs: (filter?: unknown) => call<{ tabs: unknown[] }>("browser.tabs", filter ?? {}).then((r) => r.tabs),
        open: (opts: unknown) => call<{ tab: unknown }>("browser.open", opts).then((r) => r.tab),
        close: (tab: string) => call<unknown>("browser.close", { id: tab }).then(() => undefined),
        navigate: (tab: string, url: string) => call<{ tab: unknown }>("browser.navigate", { id: tab, url }).then((r) => r.tab),
        show: (tab: string, view: string, viewport: unknown) => call<{ tab: unknown }>("browser.show", { id: tab, view, viewport }).then((r) => r.tab),
        hide: (tab: string) => call<{ tab: unknown }>("browser.hide", { id: tab }).then((r) => r.tab),
        screenshot: (tab: string, opts?: { format?: string; quality?: number }) => call<unknown>("browser.screenshot", { id: tab, ...(opts ?? {}) }),
        cdp: (tab: string, method: string, params?: unknown, opts?: { viewport?: unknown }) =>
          call<{ result: unknown }>("browser.cdp", { id: tab, method, ...(params !== undefined ? { params } : {}), ...(opts?.viewport !== undefined ? { viewport: opts.viewport } : {}) }).then((r) => r.result),
        // A page's DevTools events (`Page.*`), the panel's alone: a component's watch on the core's layer route, each event
        // handed to the listener as the contract says, `(method, params)`.
        onCdpEvent: (tab: string, listener: (method: string, params: unknown) => void): Unsubscribe => {
          if (typeof listener !== "function") throw new Error("browser.onCdpEvent takes a listener");
          const w = layerWatch(part.mount, part.entry.pluginId, "browser.onCdpEvent", [tab, (v: unknown) => {
            const e = v as { method?: unknown; params?: unknown } | null;
            if (e !== null && typeof e === "object" && typeof e.method === "string") listener(e.method, e.params);
          }], 1);
          w.opened.catch(() => undefined);
          return w.stop;
        },
        watch: (listener: (change: unknown) => void): Unsubscribe => {
          subscribe(part.mount, part.entry.pluginId, "browser");
          return onApiEvent(part.entry.pluginId, (method, params) => {
            const e = params as { type?: unknown; tab?: unknown; id?: unknown; computer?: unknown } | undefined;
            if (method !== "core.event") return;
            if (e?.type === "tab_changed" && e.tab !== undefined) listener({ type: "changed", tab: e.tab });
            else if (e?.type === "tab_closed" && typeof e.id === "string") listener({ type: "closed", id: e.id, computer: e.computer, by: "api" });
          });
        },
      } as unknown as PluginApi["browser"],
      // What the user hands the page (`files.pick*`, gesture-bound, served by the app's main process, which opens its own dialog):
      // tokens for the plugin's host half (`host.call`) and the media URL below. The rest of `files` (`stat`, `readText`,
      // `write`, `watch` …) is the catalog's, through the core's fence as the plugin, as its host half's.
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
        stream: (point: string, entry: unknown, field: string, args?: unknown, opts?: { method?: string; timeoutMs?: number; signal?: AbortSignal }, onEvent?: (e: StreamReadEvent) => void) =>
          pointStream(layerStreams(part.mount, part.entry.pluginId), point, entry, field, args, opts, onEvent),
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
      } as unknown as PluginApi["points"],
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
      // The core places the key (the plugin's `auth` entry) and masks it out of what comes back: the page never sees it.
      net: {
        fetch: (url: string | URL, init?: RequestInit, opts?: unknown) => layerCall(part.mount, "net.fetch", [String(url), fetchInit(init), opts]) as Promise<Response>,
      } as unknown as PluginApi["net"],
      settings: {
        // Its own plugin's settings, every part alike on its own connection (`plugin.layer.call`'s `settings.get`): the
        // value in effect at its scope, a `bot` field for the bot it names (F2: as the host half reads it), a `secret`
        // field only as `{ set }`.
        get: async <T,>(key: string, opts?: { bot?: string }) =>
          (await call<{ result: T | undefined }>("plugin.layer.call", { call: "settings.get", args: opts?.bot !== undefined ? [key, { bot: opts.bot }] : [key] })).result,
        // Its own plain settings, with no card (`plugin.layer.call`'s `settings.set`: never a secret or a setting written
        // into what the plugin runs), a `bot` field for the bot it names.
        set: async (key: string, value: unknown, opts?: { bot?: string }) => {
          await call<unknown>("plugin.layer.call", { call: "settings.set", args: opts?.bot !== undefined ? [key, value ?? null, { bot: opts.bot }] : [key, value ?? null] });
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
      // A question to the user (§5.4 "Asking the user"), on its own connection (`plugin.layer.call`): the app's own sealed
      // card, naming the plugin, as a host half's; the component gets only the answer (and, with `confirmCard`, the
      // card's id).
      confirm: (text: string) => call<{ result: boolean }>("plugin.layer.call", { call: "confirm", args: [text] }).then((r) => r.result === true),
      confirmCard: (text: string) => call<{ result: { allowed: boolean; card: string } }>("plugin.layer.call", { call: "confirmCard", args: [text] }).then((r) => r.result),
      // `plugins.install` (capability `plugins.install`, any plugin's behind its OK card): an install through the user's own door; what it
      // installs lands found, behind its sealed OK card, which says this plugin asked.
      plugins: {
        install: (source: unknown) => call<{ result: { id: string; state: string; card?: string } }>("plugin.layer.call", { call: "plugins.install", args: [source] }).then((r) => r.result),
      } as unknown as PluginApi["plugins"],
      t,
    }) as unknown as PluginApi;
  }, [part.entry.pluginId, part.mount, t, fake]);
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

/** Opens a place in the main window (Settings at a section and an item, a bot's tab): for the `moss` tree's parts,
 *  such as the island's Usage and Devices tabs. Not in lane B's declarations yet. */
export function useOpen(): (target: OpenTarget) => Promise<void> {
  const part = usePart();
  return useCallback((target: OpenTarget) => rt().bridge.open(part.mount, target), [part.mount]);
}

/** How often a placed native view's frame is measured again, besides its resizes (a move with no resize). */
export const VIEW_FRAME_POLL_MS = 250;

/** Places a native view the core draws over this part (the MOSS Browser's live view, `name` "browser"): the ref
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
export function useSpotEntries(name: string, spotKey?: string, forProps?: string | { readonly bot?: unknown; /** The kind of session the part shows (`when.session`): the `moss` layer's say, heeded by the main process from that layer only. */ readonly forSessionKind?: unknown }): { readonly entries: readonly SpotEntryView[]; /** False until the first answer: an empty list before it is not yet the spot's answer (a window document that loads again starts so). */ readonly loaded: boolean; subscribe(listener: () => void): Unsubscribe } {
  const part = usePart();
  // The bot whose tab shows, by id or as the props a `<Spot>` there is given (`{ bot }`, a reference or an id): the spots a bot's own entries fill.
  const b = typeof forProps === "string" ? forProps : forProps?.bot;
  const forBot = typeof b === "string" ? b : typeof (b as { id?: unknown } | undefined)?.id === "string" ? (b as { id: string }).id : undefined;
  const kind = typeof forProps === "object" && typeof forProps?.forSessionKind === "string" ? forProps.forSessionKind : undefined;
  const [entries, setEntries] = useState<readonly SpotEntryView[]>([]);
  // Which question the last answer was to: an answer for other params (another bot, another session kind) is not this
  // one's, so the list reads as not loaded in the very render the params change, until its own answer comes.
  const asked = JSON.stringify([part.mount, name, spotKey ?? null, forBot ?? null, kind ?? null]);
  const [answered, setAnswered] = useState<string | undefined>(undefined);
  const loaded = answered === asked;
  const listeners = useRef(new Set<() => void>());
  useEffect(() => {
    let live = true;
    const load = () => void rt().bridge.entries(part.mount, name, spotKey, forBot, kind).then((e) => {
      if (!live) return;
      setEntries((old) => (JSON.stringify(old) === JSON.stringify(e) ? old : e));
      setAnswered(asked);
    }, () => { if (live) setAnswered(asked); });
    load();
    const off = onLayerMessage((m) => {
      if (m.type === "respot") load();
    });
    return () => {
      live = false;
      off();
    };
  }, [part.mount, name, spotKey, forBot, kind, asked]);
  useEffect(() => {
    for (const l of listeners.current) l();
  }, [entries]);
  return useMemo(() => ({
    entries,
    loaded,
    subscribe: (listener: () => void) => {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
  }), [entries, loaded]);
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

/** For the `moss` shell: tells the core where the window is, for the plugin frames that read it (`shell.state`). */
export function useShellReport(): (report: { state: ShellState; apps: readonly ShellApp[]; account?: ShellAccount }) => void {
  const part = usePart();
  return useCallback((report) => rt().bridge.shellReport(part.mount, report), [part.mount]);
}

/** The user's own words, sent from inside the key press or click that sends them (lane B's `useUserSend`; the
 *  Dispatch pill's). The entry in the `composer` spot has it (whichever plugin's, to its own session only); any other part
 *  has it with the `user.send` capability (the OK card says "sends messages to your bots and sessions as you, with text it chooses"), and the app refuses the
 *  send of a part without it. A send counts only inside a press or click (the frame's own activation, and the app saw that input
 *  come to the window within a second: one send for one press), or after a hold: a press and its release the app itself saw in
 *  this frame give it one send within 30 s of the release, its activation no longer needed (hold-to-talk: the words come after
 *  the release and the transcription). A page's own events give neither; any other send is refused and sends nothing. */
export function useUserSend(): ((to: UserSendTarget, message: string | { text: string; images?: readonly { mediaType: "image/png" | "image/jpeg" | "image/webp"; data: Uint8Array }[] }) => Promise<void>) | undefined {
  const part = usePart();
  const send = useCallback(async (to: UserSendTarget, message: string | { text: string; images?: readonly { mediaType: "image/png" | "image/jpeg" | "image/webp"; data: Uint8Array }[] }) => {
    // Whether this is the user's own words is the app's to say, not the page's: a send inside a press or click (the frame's own
    // activation, and the press seen by the app within a second), or after a hold the app saw released (once, within 30 s of the
    // release, with no activation needed). Any other send is refused there.
    const m = typeof message === "string" ? { text: message } : message;
    await rt().bridge.userSend(part.mount, to, m);
  }, [part.mount]);
  return send;
}

/** What the `composer` spot hands the entry the core mounted there (spec §5.5, lane E): the models its session can
 *  switch to, a model switch, and interrupt and stop. Each acting call counts only inside the user's own key press or
 *  click. On a bot's main conversation a model switch changes a user layer: the `moss` layer's entry changes it
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

/** The core client of a part (lane F's `useCore`; not in lane B's declarations): a call of the app's door for parts
 *  (`tree-calls.ts`: each call by a capability the part's plugin holds, F2), or of the `layer` role on the part's own
 *  plugin's connection, and the core events it subscribed to (each by its area and capability). Any plugin's part has it. */
export interface CoreClient {
  call(method: string, params?: unknown): Promise<any>;
  on(event: string, listener: (event: Record<string, unknown>) => void): Unsubscribe;
}


export function useCore(): CoreClient | undefined {
  const part = usePart();
  const pluginId = part.entry.pluginId;
  return useMemo(() => ({
    call: (method: string, params?: unknown) => rt().bridge.api(part.mount, method, params ?? {}),
    on: (event: string, listener: (event: Record<string, unknown>) => void) => {
      const area = EVENT_AREAS[event];
      if (area !== undefined) subscribe(part.mount, pluginId, area);
      return onApiEvent(pluginId, (method, params) => {
        const e = params as Record<string, unknown> | undefined;
        if (method === "core.event" && e?.type === event) listener(e);
      });
    },
  }), [part.mount, pluginId]);
}

/** State that outlives its document's reload in this window (`useState`'s shape): the user's place, a draft. A layer's
 *  document loads again when a plugin with its own layer is installed, turned on or updated (the frames it may hold are
 *  fixed when it is served), and what a part keeps this way is there again, from the first render, so the window shows
 *  the same page with no flash of another. Only a reload: the part's unmount (the user left the page) drops it, as it
 *  drops plain state, and so does a change of `key` (another conversation's draft starts from its own). A value that
 *  can't be stored or read is plain state.
 *
 *  Where it lives: the window's session storage (never `localStorage`), per plugin and key, as JSON. Session storage is
 *  per origin, and every plugin's layer is its own origin (`moss-plugin://<layer>/`): a third-party part's `useKept`
 *  is in its layer's store and can't read the shell's or the composer's, and theirs (the moss layer's) can't be read
 *  by a third-party page. It goes when the window closes; MOSS writes none of it to disk (what Chromium does with a
 *  session's storage is its own, and MOSS keeps no session to restore). The `moss.kept:<plugin>:` prefix is a
 *  namespace among one layer's plugins, not a boundary: keep in it only the user's place and their own unsent words.
 *  A draft there (the composer's, keyed by its conversation's id only) may hold something pasted, a secret even: it is
 *  no more exposed than the text field it is typed in, which the same document already holds. */
export function useKept<T>(key: string, initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
  const part = useContext(PartContext);
  const pluginId = part?.entry.pluginId ?? "moss";
  const scope = part !== null && runtime !== undefined ? runtime.testKeptScope?.(part.mount) ?? "" : "";
  const storeKey = `moss.kept:${scope}${pluginId}:${key}`;
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

/** The session this window shows (the `moss` layer's shell says so; the core refuses it from any other layer): a
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
      if (added.length > 0) rt().cards = [...rt().cards, ...added];
      // Every part's list is the layer's now: one that mounted beside another (whose read added the cards first) heard
      // nothing of them otherwise, and drew a pending card as answered.
      setCards((old) => (old.length === rt().cards.length && old.every((c, i) => c === rt().cards[i]) ? old : [...rt().cards]));
    }, () => undefined);
    return () => { live = false; };
  }, [mount]);
  const listeners = useRef(new Set<() => void>());
  useEffect(() => onLayerMessage(() => setCards([...rt().cards])), []);
  useEffect(() => { for (const l of listeners.current) l(); }, [cards]);
  const owns = rt().testOwnsCard;
  const own = useMemo(() => (owns === undefined ? cards : cards.filter((c) => owns(mount, c.id))), [cards, owns, mount]);
  return useMemo(() => ({ cards: own, subscribe: (listener: () => void) => { listeners.current.add(listener); return () => listeners.current.delete(listener); } }), [own]);
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
  // How the frame got its size, for a reading of a frame that took no room: the page said it, or the wait gave it a few lines.
  const byPage = useRef(false);
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
      const said = (event.data as { mossSealedSize?: { width?: unknown; height?: unknown } } | null)?.mossSealedSize;
      if (said === null || typeof said !== "object" || said === undefined) return;
      const n = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.ceil(v), max) : undefined);
      const width = n(said.width, 1200);
      const height = n(said.height, 4000);
      // A reading of no size at all is no reading: the frame waits for the next one (or the fallback), never stays at nothing.
      if (kind === "button" && (width === 0 || height === 0)) return;
      byPage.current = true;
      setBox((b) => (b.width === width && b.height === height ? b : { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) }));
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [kind]);
  // A page that never says its size (a script blocked, a slow start) is given a few lines after a moment, so it is never
  // a frame of no height for good.
  useEffect(() => {
    if (src === undefined || !loaded || box.height !== undefined) return;
    // A label button with no word of its size gets a width too (a frame with a height and no width is a button nobody can press).
    const t = setTimeout(() => setBox((b) => (b.height !== undefined ? b : { ...b, height: Math.ceil(fontPx * 1.4 * (kind === "field" ? Math.min(lines ?? 3, 3) : 2)), ...(kind === "button" && b.width === undefined ? { width: Math.ceil(fontPx * 8) } : {}) })), 1200);
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
  return <iframe ref={frame} src={src} onLoad={() => setLoaded(true)} data-moss-sealed={`${kind}:${name}`} data-moss-sealed-state={`${loaded ? "loaded" : "pending"}${box.height === undefined ? "" : byPage.current ? " said" : " fallback"}`} style={style} title={kind === "field" ? `card field ${name}` : `card button ${name}`} referrerPolicy="no-referrer" sandbox={undefined} />;
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
    <div data-moss-card={id} className={className}>
      <CardOwner.Provider value={{ mount: part.mount, cardId: id, tokens: given }}>{children as never}</CardOwner.Provider>
      <CardReview mount={part.mount} cardId={id} />
    </div>
  );
}

/** A plugin's OK card's Review (the owner's ruling, 2026-11-13): a plain control that asks the app to open its own page
 *  for the card, where the Review, its report and the sealed buttons are. It reads and answers nothing. */
function CardReview({ mount, cardId }: { mount: string; cardId: string }) {
  const meta = useApprovals().cards.find((c) => c.id === cardId);
  const [opened, setOpened] = useState<"idle" | "opening" | "no">("idle");
  if (meta?.kind !== "plugin-ok" || rt().bridge.cardPage === undefined) return null;
  return (
    <button
      type="button"
      className="moss-card-review"
      data-moss-card-review={opened}
      title="Opens this card in MOSS's own window, where a model can read the plugin's files and say what it finds"
      onClick={() => {
        setOpened("opening");
        void rt().bridge.cardPage!(mount, cardId).then((ok) => setOpened(ok ? "idle" : "no"), () => setOpened("no"));
      }}
    >
      Review…
    </button>
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
