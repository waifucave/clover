// The channel between a plugin layer and the app's main process (spec §5.5), as the layer's preload exposes it on
// `window.cloverLayer`. Lane E's runtime is both ends: the app's main process (apps/desktop/src/main/ui) answers, and
// the UI API (`index.tsx`) calls. A plugin's components never see it; they use `<Spot>`, the hooks and the plugin
// API.
//
// Every mount is one entry in one place: a document of its own (a frame from the entry's layer, loaded with a
// single-use token the core issued) or a part inside its parent's document (inline, same layer). The main process
// binds each document to its frame, so a layer can only resolve spots its own entries declare and only mount what the
// core chose.
import type { TokenValue } from "../catalogs/tokens";
import type { StringTable } from "./strings";

export * from "./strings";

/** Where a part is, as the runtime tells it: the tab (its bot), the surface, the session's kind, the OS, the window's
 *  material, safe mode. */
export interface MountContext {
  bot?: string;
  surface?: string;
  session?: string;
  os: "macos" | "windows" | "linux";
  /** The window's system material behind transparent parts (§86: macOS sidebar vibrancy, Windows 11 acrylic). */
  material: "vibrancy" | "acrylic" | "none";
  safeMode: boolean;
  /** The bots this computer knows, for the default shell until the plugin API's `bots` reaches layers (E-M2). */
  bots?: readonly { id: string; name: string }[];
}

/** A mounted entry, as its document learns it. */
export interface MountInfo {
  mount: string;
  pluginId: string;
  entryId: string;
  /** The `client.entry` export to render; absent for a web or style entry. */
  component?: string;
  spot: string;
  key?: string;
  props: unknown;
  /** The part's resolved tokens, by name (its tab's theme, plus what dresses it). */
  tokens: Readonly<Record<string, TokenValue>>;
  context: MountContext;
  /** The plugin's client module, served from this layer's origin; absent for the `clover` layer, whose modules come
   *  with the runtime. */
  module?: string;
  /** The plugin's stylesheets, served from this layer's origin. */
  css: readonly string[];
  /** The themes' sheets the core applies in this document, in the stack's order, after the plugin's own (§5.5):
   *  cleaned, each scoped to the part it dresses. */
  sheets?: readonly ThemeSheet[];
  /** The document's root is a bot's tab (its bot), or is dressed by a style entry: the sheets' scopes find it so. */
  tab?: string;
  styled?: boolean;
  /** The document's strings: its plugin's keys (`<top-level id>.…`; `clover.…` for the `clover` layer and the core),
   *  in the user's language (§5.5). */
  strings?: StringTable;
}

/** One sheet the core applies in a document. */
export interface ThemeSheet {
  id: string;
  css: string;
}

/** One thing a spot shows. */
export type SpotItem =
  | {
    kind: "inline";
    mount: string;
    ref: string;
    pluginId: string;
    entryId: string;
    component: string;
    /** Present when the part's tokens differ from its parent's (another tab, or a dressing plugin). */
    tokens?: Readonly<Record<string, TokenValue>>;
    context: MountContext;
    /** The part is a bot's tab (its bot), or is dressed by a style entry: the document's sheets find it so. */
    tab?: string;
    styled?: boolean;
    /** A bot's layout (§5.5), which the runtime draws in place of a component: data only. */
    layout?: LayoutView;
  }
  | {
    kind: "frame";
    mount: string;
    ref: string;
    pluginId: string;
    entryId: string;
    layer: string;
    /** Empty while the frame sleeps. */
    url: string;
    /** The frame is asleep (far from the screen a while); it wakes rebuilt from the core's state. */
    asleep?: boolean;
  }
  /** A web page entry (§5.5 "Web pages"): an isolated view with its own session, which the core draws over the
   *  place the part reports (`webFrame`). */
  | { kind: "web"; mount: string; ref: string; pluginId: string; entryId: string };

/** A node of a bot's layout as the core hands it to the runtime: sizes as CSS lengths, classes already prefixed with
 *  the plugin's id, images as the core's asset URLs, text in the user's language and markdown as its text. */
export interface LayoutAttrs {
  size?: string;
  min?: string;
  max?: string;
  grow?: number;
  /** Hidden while the window is narrower than this, in CSS pixels. */
  hideBelow?: number;
  className?: string;
  gap?: string;
  padding?: string;
  align?: "start" | "center" | "end" | "stretch";
}

export type LayoutView = LayoutAttrs & (
  | { kind: "row" | "column" | "stack"; children: LayoutView[] }
  | { kind: "tabs"; tabs: { title: string; node: LayoutView }[] }
  | { kind: "spot"; spot: string; key?: string }
  | { kind: "image"; src: string }
  | { kind: "text"; text: string }
  | { kind: "markdown"; markdown: string }
  | { kind: "spacer" }
);

/** What a `<Spot>` shows, as the core resolved it. */
export interface SpotView {
  spot: string;
  key?: string;
  shape: "single" | "list" | "keyed";
  items: readonly SpotItem[];
  /** A hide won, or the user picked nothing: the part shows nothing (Settings can bring it back). */
  hidden: boolean;
  /** Two entries tied up to "the most recently enabled": Settings shows a conflict badge. */
  conflict: boolean;
  /** The spot isn't declared by the part asking, so what would fill it waits (§5.5). */
  undeclared?: boolean;
}

/** Messages from the main process to a layer document. */
export type LayerMessage =
  /** A frame's props changed in its parent. */
  | { type: "props"; mount: string; props: unknown }
  /** A child frame called one of the callbacks its parent handed it. */
  | { type: "callback"; child: string; id: string; args: unknown[] }
  /** The tokens changed (appearance, accent, theme): by mount, every mount in this document. */
  | { type: "tokens"; tokens: Readonly<Record<string, Readonly<Record<string, TokenValue>>>> }
  /** The registry or the user's choices changed: resolve every spot again. */
  | { type: "respot" }
  /** The themes' sheets for this document changed (a theme, a style entry, a part placed). */
  | { type: "sheets"; sheets: readonly ThemeSheet[] }
  | { type: "strings"; strings: StringTable }
  /** A child frame's layer stopped; the parent shows a placeholder with a reload. */
  | { type: "child-gone"; child: string; reason: string }
  /** A child frame's document loads again, from this fresh single-use URL (it must frame a layer installed after it
   *  was served). */
  | { type: "child-reload"; child: string; url: string }
  /** A child frame's content height, for the parent to size it (§5.5: the core sizes the frame). */
  | { type: "child-size"; child: string; height: number }
  /** The window got the focus back after the core's own overlay: restore the element that had it (S9). */
  | { type: "focus-returned" }
  /** An app command from the window's shortcuts or menus (open settings, a new chat…), with its arguments
   *  (`open-settings`: `section`, `item`). */
  | { type: "command"; name: string; args?: Readonly<Record<string, string>> }
  /** A surface window's display changed (resolution, arrangement, the menu bar): its environment as it is now. */
  | { type: "surface-environment"; environment: SurfaceEnvironment }
  /** The core asks where a child frame is in this document's viewport (the menu broker); answered by `rectReply`. */
  | { type: "rect-query"; id: string; child: string };

/** An item of a menu the core shows for a part (it crosses frames, so the core draws it): data only. */
export interface MenuItem {
  id?: string;
  label?: string;
  enabled?: boolean;
  checked?: boolean;
  type?: "normal" | "separator" | "checkbox";
  submenu?: MenuItem[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a surface window (the island, the pill) asks of the core: to show or hide, its size or its whole place on
 *  the screen, and where it takes clicks (elsewhere clicks pass through to whatever is under it). `bounds` is in screen
 *  CSS pixels and wins over `width` and `height`; the core keeps it on the surface's display (a plugin outside the
 *  `clover` tree, inside the work area and 800 × 600). With neither, the core places the window by its surface (the
 *  island at the top centre, the pill at the bottom centre). */
export interface SurfaceRequest {
  visible?: boolean;
  width?: number;
  height?: number;
  bounds?: Rect;
  /** In the window's own space. */
  regions?: readonly Rect[];
}

/** Where a surface window lives, as its part reads it (lane G's `SurfaceEnvironment`): the OS, on Linux the display
 *  server, and its display, in screen CSS pixels. `notch` is the camera housing in the display's own coordinates,
 *  null on a display without one (and until the native add-on reads it, E-M2). On Wayland a surface is a normal framed
 *  window the user places, never an overlay. */
export interface SurfaceEnvironment {
  os: "macos" | "windows" | "linux";
  session?: "wayland" | "x11";
  display: { bounds: Rect; workArea: Rect; notch: Rect | null };
}

/** A place in the app the core opens on a part's request (the island's Usage and Devices tabs open Settings there). */
export type OpenTarget =
  | { kind: "settings"; section?: string; item?: string }
  | { kind: "bot"; bot: string };

/** Data a part offers for a drag to another part, through the core (the drag broker). */
export interface DragOffer {
  type: "text/plain" | "text/uri-list" | "application/x-clover-file" | "application/x-clover-message";
  data: unknown;
}

/** The drag's data type that carries a grant token from the core. */
export const DRAG_GRANT_TYPE = "application/x-clover-grant";

/** A value handed across a frame's edge in place of a function: the core routes calls back to the parent. */
export interface CallbackMarker {
  "$clover.callback": string;
}

export const CALLBACK_KEY = "$clover.callback";

/** The bridge the preload puts on `window.cloverLayer`. */
export interface LayerBridge {
  /** The mount token this document was loaded with, from its URL. */
  readonly token: string | undefined;
  /** Binds this document to its mount, once. */
  describe(): Promise<MountInfo>;
  /** Resolves a spot that the part `mount` (this document's, or an inline part in it) declares. `hints.session` (the
   *  kind of session the part shows, for `when.session`) is heard from the `clover` layer only. */
  resolve(mount: string, spot: string, key?: string, hints?: { session?: string }): Promise<SpotView>;
  /** New props for a child frame. */
  setProps(child: string, props: unknown): void;
  /** Calls a callback the parent handed this frame. */
  callback(id: string, args: unknown[]): void;
  /** This frame's content height. */
  reportSize(height: number): void;
  /** Parts no longer shown: their mounts, and everything under them, are dropped. */
  release(mounts: readonly string[]): void;
  /** A fresh single-use URL for a child frame whose layer stopped. */
  reload(child: string): Promise<string | undefined>;
  /** A child frame far from the screen a while goes to sleep; `wake` brings it back with a fresh single-use URL. */
  sleep(child: string): void;
  wake(child: string): Promise<string | undefined>;
  /** Answers the core's `rect-query`: the child frame's place in this document's viewport. */
  rectReply(id: string, rect: { x: number; y: number; width: number; height: number } | null): void;
  /** Shows a menu for the part `mount` at a point in this frame; the id picked, or null. */
  menu(mount: string, items: readonly MenuItem[], x: number, y: number): Promise<string | null>;
  /** This document's surface window (only the document a surface window's root placed). */
  surface(request: SurfaceRequest): void;
  /** This document's surface window's environment (only the document a surface window's root placed). */
  surfaceEnvironment(): Promise<SurfaceEnvironment | undefined>;
  /** Opens a place in the main window for the part `mount` (the `clover` tree's parts only, in 1.111.1). */
  open(mount: string, target: OpenTarget): Promise<void>;
  /** Where the part `mount`'s native view `name` goes (the Clover Browser's live view): its rect in this document's
   *  viewport, null when it has no place; `used` when the person just used it (ruling R8: the view the person used
   *  last gets the live view). */
  viewFrame(mount: string, name: string, rect: Rect | null, used?: boolean): void;
  /** Where a web page part's view goes, in this document's viewport (null: hidden). Only the document that placed
   *  the web part places its view. */
  webFrame(mount: string, rect: Rect | null): void;
  /** Offers data for a drag from the part `mount`: a token to put in the drag's `DRAG_GRANT_TYPE`. */
  dragOffer(mount: string, offer: DragOffer): Promise<{ token: string } | { error: string }>;
  /** Claims a dropped grant for the part `mount`. */
  dragClaim(mount: string, token: string): Promise<DragOffer | { error: string }>;
  onMessage(listener: (message: LayerMessage) => void): () => void;
}

declare global {
  interface Window {
    cloverLayer?: LayerBridge;
  }
}
