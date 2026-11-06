// `@waifucave/clover-plugin-sdk/ui`: the UI API that a plugin's React components use (spec §5.5), implementing lane
// B's declarations (`../api/ui-api.ts`). Each layer loads one copy, shared by every component in it: the app maps the
// bare specifier to the layer's own copy, beside React's.
//
// E-M1 builds `<Spot>` (inline in the same layer, a frame from the entry's own layer otherwise), the tokens hook and
// the layer's root; E-M2 the themes' sheets, strings (`useT`) and layouts. Sealed cards (`<Card>`, `useApprovals`,
// E-M3), MCP Apps (`<AppView>`, E-M3) and the plugin API in layers (`usePluginApi`, with lane B's host side) are
// placeholders that draw nothing and never fail, so components written against the declarations already run.
import {
  Component, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ErrorInfo, type ReactNode,
} from "react";
import type { CardMeta } from "@waifucave/clover-protocol";
import type { TokenValue } from "../catalogs/tokens";
import { cssProperty } from "../catalogs/tokens";
import type { PluginApi, Unsubscribe } from "../api/plugin-api";
import type {
  AppViewProps, CardButtonProps, CardComponents, CardElementProps, CardFieldProps, EntryProps, SpotElementProps, UiApi, UiComponent,
} from "../api/ui-api";
import { CALLBACK_KEY, type DragOffer, type LayerBridge, type LayerMessage, type MenuItem, type MountContext, type MountInfo, type OpenTarget, type SpotItem, type SpotView, type SurfaceEnvironment, type SurfaceRequest, type ThemeSheet, type StringTable } from "./bridge";
import { EMPTY_STRINGS, translate } from "./strings";
import { LayoutRoot } from "./layout";

export * from "./bridge";
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
  return (
    <StringsContext.Provider value={strings}>
      <EntryView part={part} component={component} props={props} />
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

/** `<Spot name spotKey props>`'s props. Lane B's declaration names the key `key`, which React keeps for itself and
 *  never hands a component, so the runtime reads `spotKey` (asked of lane B: rename it). */
export type SpotProps = Omit<SpotElementProps, "key"> & { spotKey?: string };

/** `<Spot name spotKey props>`: shows a spot this part declares (§5.5). */
export function Spot({ name, spotKey, props }: SpotProps) {
  const part = usePart();
  const hints = useContext(SpotHints);
  const r = rt();
  const [view, setView] = useState<SpotView | undefined>(undefined);
  const session = hints.session;
  const resolve = useCallback(() => {
    void r.bridge.resolve(part.mount, name, spotKey, session !== undefined ? { session } : undefined)
      .then((v) => setView((old) => (sameView(old, v) ? old : v)), () => setView(undefined));
  }, [r, part.mount, name, spotKey, session]);
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
    return <div data-clover-spot={name} data-clover-key={spotKey} data-clover-empty={view?.hidden ? "hidden" : view?.undeclared ? "waiting" : ""} style={{ display: "contents" }} />;
  }
  return (
    <div data-clover-spot={name} data-clover-key={spotKey} data-clover-conflict={view.conflict ? "" : undefined} style={{ display: "contents" }}>
      {view.items.map((item) => <SpotItemView key={item.mount} item={item} parent={part} spot={name} spotKey={view.key} props={props} />)}
    </div>
  );
}

function SpotItemView({ item, parent, spot, spotKey, props }: { item: SpotItem; parent: Part; spot: string; spotKey: string | undefined; props: unknown }) {
  if (item.kind === "frame") return <LayerFrame item={item} props={props} />;
  if (item.kind === "web") {
    return <div className="clover-web-placeholder" data-clover-entry={item.ref} role="note">This part is a web page, which shows in a later version.</div>;
  }
  return <InlineItem item={item} parent={parent} spot={spot} spotKey={spotKey} props={props} />;
}

function InlineItem({ item, parent, spot, spotKey, props }: { item: Extract<SpotItem, { kind: "inline" }>; parent: Part; spot: string; spotKey: string | undefined; props: unknown }) {
  const r = rt();
  const [tokens, setTokens] = useState(item.tokens ?? parent.tokens);
  useEffect(() => setTokens(item.tokens ?? parent.tokens), [item.tokens, parent.tokens]);
  useEffect(() => onLayerMessage((m) => {
    if (m.type === "tokens" && m.tokens[item.mount] !== undefined) setTokens(m.tokens[item.mount]!);
  }), [item.mount]);
  const part: Part = useMemo(() => ({
    mount: item.mount,
    entry: { pluginId: item.pluginId, id: item.entryId, spot, ...(spotKey !== undefined ? { key: spotKey } : {}) },
    tokens,
    context: item.context,
  }), [item, tokens, spot, spotKey]);
  const own = tokens !== parent.tokens ? tokenStyle(tokens) : undefined;
  const marks = { "data-clover-entry": item.ref, "data-clover-part": item.mount, "data-clover-tab": item.tab, "data-clover-styled": item.styled === true ? "" : undefined };
  if (item.layout !== undefined) {
    // A bot's layout: data the runtime draws as the tab's part, its spots the part's own. A layout's root fills the
    // place it is in, so it gets a box of its own (the theme's `contain` reaches it).
    const layout = item.layout;
    return (
      <div {...marks} data-clover-layout-part="" style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, height: "100%", ...own }}>
        <PartContext.Provider value={part}>
          <PartBoundary name={item.ref}>
            <LayoutRoot layout={layout} renderSpot={(spot, key) => <Spot name={spot} {...(key !== undefined ? { spotKey: key } : {})} />} />
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
function LayerFrame({ item, props }: { item: Extract<SpotItem, { kind: "frame" }>; props: unknown }) {
  const r = rt();
  const [url, setUrl] = useState(item.url);
  const [asleep, setAsleep] = useState(item.asleep === true);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [gone, setGone] = useState<string | undefined>(undefined);
  const [el, setEl] = useState<Element | null>(null);
  const near = useNear(el);
  useEffect(() => {
    if (item.url !== "") setUrl(item.url);
  }, [item.url]);
  useEffect(() => onLayerMessage((m) => {
    if (m.type === "child-size" && m.child === item.mount) setHeight(m.height);
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
    r.bridge.setProps(item.mount, encoded);
  }, [props, item.mount, r, asleep]);
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
      allow=""
      referrerPolicy="no-referrer"
      style={{ display: "block", border: 0, width: "100%", height: height === undefined ? undefined : `${height}px`, colorScheme: "normal", background: "transparent" }}
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

/** The plugin API in this layer: only `plugin` and `t` in E-M1; the rest reaches layers with lane B's host side. */
export function usePluginApi(): PluginApi {
  const part = usePart();
  const t = useT();
  return useMemo(() => {
    const unavailable = (what: string) => () => Promise.reject(new Error(`${what} isn't available in layers yet`));
    return {
      plugin: { id: part.entry.pluginId } as PluginApi["plugin"],
      points: { list: unavailable("points") } as unknown as PluginApi["points"],
      commands: { list: unavailable("commands"), run: unavailable("commands") } as unknown as PluginApi["commands"],
      host: { call: unavailable("host"), on: () => () => {} } as unknown as PluginApi["host"],
      ui: { send: () => {} } as unknown as PluginApi["ui"],
      storage: {} as PluginApi["storage"],
      net: { fetch: unavailable("net.fetch") } as unknown as PluginApi["net"],
      settings: {} as PluginApi["settings"],
      confirm: unavailable("confirm") as unknown as PluginApi["confirm"],
      t,
    } as PluginApi;
  }, [part.entry.pluginId, t]);
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
    const onUse = () => measure(true);
    const onChange = () => measure();
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(onChange);
    resize?.observe(el);
    window.addEventListener("resize", onChange);
    document.addEventListener("scroll", onChange, true);
    document.addEventListener("visibilitychange", onChange);
    el.addEventListener("pointerdown", onUse, true);
    el.addEventListener("keydown", onUse, true);
    const poll = setInterval(onChange, VIEW_FRAME_POLL_MS);
    // Placed: the newest place gets the view until the person uses another.
    measure(true);
    return () => {
      resize?.disconnect();
      window.removeEventListener("resize", onChange);
      document.removeEventListener("scroll", onChange, true);
      document.removeEventListener("visibilitychange", onChange);
      el.removeEventListener("pointerdown", onUse, true);
      el.removeEventListener("keydown", onUse, true);
      clearInterval(poll);
      bridge.viewFrame(part.mount, name, null);
    };
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

/** Pending cards without their text. Sealed cards come in E-M3: none until then. */
export function useApprovals(): { readonly cards: readonly CardMeta[]; subscribe(listener: () => void): Unsubscribe } {
  return useMemo(() => ({ cards: [], subscribe: () => () => {} }), []);
}

// Sealed cards (E-M3): the frames come from a core-owned origin. Until then they draw nothing, and the app's own
// fallback card stands in for any card a component places.
const CardRoot = (_props: CardElementProps) => null;
const CardField = (_props: CardFieldProps) => null;
const CardButton = (_props: CardButtonProps) => null;
export const Card: CardComponents = Object.assign(CardRoot, { Field: CardField, Approve: CardButton, Deny: CardButton });

/** MCP Apps views (E-M3): until then the tool's result shows as text, as for a page no component places. */
export const AppView = (_props: AppViewProps) => null;

/** The UI API as lane B declared it. */
export const ui: UiApi = { Spot: Spot as unknown as UiComponent<SpotElementProps>, Card, AppView, usePluginApi, useTokens, useT, useApprovals };
