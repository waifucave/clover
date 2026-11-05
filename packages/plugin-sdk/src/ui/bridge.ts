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
  }
  | { kind: "frame"; mount: string; ref: string; pluginId: string; entryId: string; layer: string; url: string }
  /** A web page entry (§5.5 "Web pages"): an isolated view, E-M2's. Shown as a placeholder until then. */
  | { kind: "web"; mount: string; ref: string; pluginId: string; entryId: string };

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
  /** A child frame's layer stopped; the parent shows a placeholder with a reload. */
  | { type: "child-gone"; child: string; reason: string }
  /** A child frame's content height, for the parent to size it (§5.5: the core sizes the frame). */
  | { type: "child-size"; child: string; height: number }
  /** The window got the focus back after the core's own overlay: restore the element that had it (S9). */
  | { type: "focus-returned" }
  /** An app command from the window's shortcuts or menus (open settings, a new chat…). */
  | { type: "command"; name: string };

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
  onMessage(listener: (message: LayerMessage) => void): () => void;
}

declare global {
  interface Window {
    cloverLayer?: LayerBridge;
  }
}
