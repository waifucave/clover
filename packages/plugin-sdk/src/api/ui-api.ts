// The UI API (spec §5.5), as TypeScript declarations: what a plugin's React components use. Lane E implements it in
// `src/ui/` (E-M1 for `<Spot>`, E-M2 for tokens and strings, E-M3 for sealed cards and `<AppView>`) and signs off on
// these declarations. Spike S9 (layers) is still running, so they say only what the spec fixes.
//
// A component is an export of `client.entry` that a `ui` entry names. It renders in its plugin's own layer (§5.5),
// gets only its spot's declared props (data, plus callbacks the core routes back) and the part's resolved tokens, and
// shows other spots with `<Spot>`, sealed approval frames with `<Card>` and an MCP Apps page with `<AppView>`.
//
// React's types are deliberately not imported: `UiNode` stands for a React node, and lane E's runtime binds the
// declarations to React's own types when it adds React to the app.
import type { CardFieldName, CardMeta } from "@waifucave/clover-protocol";
import type { TokenValue } from "../catalogs/tokens";
import type { PluginApi, Unsubscribe } from "./plugin-api";

/** A React node. */
export type UiNode = unknown;

/** A component: props in, a node out. */
export type UiComponent<P> = (props: P) => UiNode;

/** What every entry's component gets: its spot's props, the part's resolved tokens (its own CSS may override them),
 *  and which entry it is. */
export interface EntryProps<P = Record<string, unknown>> {
  readonly props: P;
  /** By token name (`color.accent`); the same values are set as `--clover-…` custom properties on the part. */
  readonly tokens: Readonly<Record<string, TokenValue>>;
  readonly entry: { readonly pluginId: string; readonly id: string; readonly spot: string; readonly key?: string };
}

/** `<Spot name spotKey props>`: shows a spot this component declares; the core mounts each entry there, inline in the
 *  same layer or as a frame from its own (§5.5). The key is `spotKey`, since React keeps `key` for itself and never
 *  hands it to a component (lane E). */
export interface SpotElementProps {
  name: string;
  /** For a keyed spot: which key to show. */
  spotKey?: string;
  /** Shows one entry only, by its ref from `useSpotEntries`: a declaring part that draws one at a time (the island's
   *  tabs, the pill's targets). */
  entry?: string;
  /** Handed to each entry, checked against the spot's declared `props`. */
  props?: Record<string, unknown>;
}

/** One entry of a spot, as its declaring part lists it (lane G's ask): its ref for `<Spot entry>`, the plugin it comes
 *  from, by name too (a part labels a third-party entry with it, so nothing reads as the app's own or as a bot), and
 *  the spot's own fields (`title`, `icon`…), checked against the catalog. In the spot's order: `order`, then plugin
 *  id, then title. */
export interface SpotEntryView {
  readonly ref: string;
  readonly pluginId: string;
  readonly pluginName: string;
  /** Whether it comes from the bundled `clover` tree. */
  readonly bundled: boolean;
  readonly key?: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Where a part is, as the runtime tells it (lane E): the tab's bot, the surface, the session's kind, the OS, the
 *  window's material behind transparent parts (decision 86), and safe mode. */
export interface MountContext {
  readonly bot?: string;
  readonly surface?: string;
  readonly session?: string;
  readonly os: "macos" | "windows" | "linux";
  readonly material: "vibrancy" | "acrylic" | "none";
  readonly safeMode: boolean;
}

/** An item of a menu the core shows for a part; it can cross frames, so the core draws it. Data only. */
export interface MenuItem {
  id?: string;
  label?: string;
  enabled?: boolean;
  checked?: boolean;
  type?: "normal" | "separator" | "checkbox";
  submenu?: MenuItem[];
}

/** Data a part offers for a drag to another part, through the core (the drag broker). */
export interface DragOffer {
  type: "text/plain" | "text/uri-list" | "application/x-clover-file" | "application/x-clover-message";
  data: unknown;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What an `app.surface` entry asks of its window (lane G's ask): to show, its size, and the regions that take clicks;
 *  elsewhere clicks pass through to what is under it. The window itself is the entry's manifest `window` (its type,
 *  `transparent`, `placement`; `alwaysOnTop` only for the bundled `clover` tree in 1.111.1, R12). */
export interface SurfaceRequest {
  visible?: boolean;
  width?: number;
  height?: number;
  /** Where on the display, in screen CSS pixels. */
  bounds?: Rect;
  /** In the window's own space. */
  regions?: readonly Rect[];
}

/** Where a surface window lives (lane G's ask): the OS, on Linux the display server, and its display in screen CSS
 *  pixels, with `notch`, the camera housing in the display's own coordinates (null where there is none, and until the
 *  native add-on reads it). On Wayland a surface is a normal framed window the user places, never an overlay. */
export interface SurfaceEnvironment {
  readonly os: "macos" | "windows" | "linux";
  readonly session?: "wayland" | "x11";
  readonly display: { readonly bounds: Rect; readonly workArea: Rect; readonly notch: Rect | null };
}

/** A place in the main window a part asks the app to open (the island's Usage and Devices tabs open Settings there). */
export type OpenTarget = { kind: "settings"; section?: string; item?: string } | { kind: "bot"; bot: string };

/** A question a bot asked (`AskUserQuestion`), with its text, for a part that shows questions in its own form (the
 *  island): a plugin with `conversation.read` reads them, and one with `conversation.post` answers them
 *  (`conversation.answer`). Provisional for lane D, whose session log carries them. */
export interface PendingQuestion {
  readonly session: string;
  readonly callId: string;
  readonly bot?: string;
  readonly at: number;
  readonly questions: readonly {
    readonly question: string;
    readonly header?: string;
    readonly multiSelect?: boolean;
    readonly options: readonly { readonly label: string; readonly description?: string }[];
  }[];
}

/** Where the user's own words go from a part that takes them (the Dispatch pill, lane G's ask; the browser view's
 *  annotations, L's): a bot, whose main conversation gets them as the user's message; a session (a coding session's,
 *  an agent's), likewise; or a `pill.target` entry by its ref, whose `handler` gets them. */
export type UserSendTarget = { bot: string } | { target: string } | { session: string };

/** The user's words, with pictures they made or chose (an annotated screenshot from the browser view's strip, L's
 *  ask). */
export type UserSendMessage = string | { text: string; images?: readonly { mediaType: "image/png" | "image/jpeg" | "image/webp"; data: Uint8Array }[] };

/** `<Card id>`: an approval card's sealed frames, for a component whose plugin has `approvals` (§5.5). Style tokens
 *  go in; nothing comes out. A filter, opacity below 1 or a transform other than a move or an enlargement on a frame or
 *  anything around it counts as hidden. A resolved card still mounts, its fields as they were, and its buttons draw
 *  nothing, so a conversation keeps it in place beside its own words for the outcome. */
export interface CardElementProps {
  id: string;
  /** `card.*` values over the part's own (§5.5: sealed frames take only these); any other name is ignored. */
  tokens?: Readonly<Record<`card.${string}`, TokenValue>>;
  /** Classes for the layout of the element that holds the frames; the frames size themselves to their content. */
  className?: string;
  children?: UiNode;
}
/** `<Card.Field name>`: one sealed field; a field the card doesn't have draws nothing. */
export interface CardFieldProps {
  name: CardFieldName;
  /** Clamps the field to this many lines; the frame itself offers the rest, so nothing sealed is cut unseen. */
  lines?: number;
  className?: string;
}
/** `<Card.Approve>`, `<Card.Deny>`: a sealed button, the first option of its kind, or a named one (`option`, from
 *  `CardMeta.options`, such as the one whose `remember` is `always`). A click counts only while the whole button
 *  shows, at 24 by 24 CSS pixels or more, uncovered, from the hardware (§5.5). */
export interface CardButtonProps {
  option?: string;
  /** The option's sealed label (the default), or a glyph the core draws with the label as its accessible name: `check`
   *  ✓ only on an approve option, `cross` ✕ only on a deny option, `open` ↗ only on an elicitation's approve option
   *  (`isSealedLookAllowed`); the core draws the label for any other pairing, so a glyph never contradicts its button. */
  look?: SealedLook;
  /** A glyph button's side in CSS pixels, at least 24 (smaller draws 24). */
  size?: number;
  className?: string;
}

export type SealedLook = "label" | "check" | "cross" | "open";

/** Whether a sealed button may wear a glyph: ✓ approves, ✕ denies, ↗ opens an elicitation's link. */
export function isSealedLookAllowed(look: SealedLook, option: { kind: "approve" | "deny" }, cardKind: string): boolean {
  switch (look) {
    case "label": return true;
    case "check": return option.kind === "approve" && cardKind !== "elicitation";
    case "cross": return option.kind === "deny";
    case "open": return option.kind === "approve" && cardKind === "elicitation";
  }
}

/** `<AppView call>`: places an MCP Apps page where a tool's result shows (§5.5). A page no component places within 2
 *  seconds shows as text. */
export interface AppViewProps {
  /** The tool call: its session and its id, which is unique only within the session. */
  call: { session: string; callId: string };
  className?: string;
}

export interface CardComponents extends UiComponent<CardElementProps> {
  Field: UiComponent<CardFieldProps>;
  Approve: UiComponent<CardButtonProps>;
  Deny: UiComponent<CardButtonProps>;
}

/** What `@waifucave/clover-plugin-sdk/ui` exports to components (lane E). */
export interface UiApi {
  Spot: UiComponent<SpotElementProps>;
  Card: CardComponents;
  AppView: UiComponent<AppViewProps>;
  /** The plugin API in this layer: no secrets, no data folder, and no way to answer cards, change levels or devices. */
  usePluginApi(): PluginApi;
  /** The part's resolved tokens, by name. */
  useTokens(): Readonly<Record<string, TokenValue>>;
  /** Strings from the plugin's own keys, in the user's language. */
  useT(): (key: string, params?: Record<string, string | number>) => string;
  /** Pending cards without their text (ids, computers, options), for a plugin with `approvals`. */
  useApprovals(): { readonly cards: readonly CardMeta[]; subscribe(listener: () => void): Unsubscribe };
  // The ten hooks from here on are optional until lane E's runtime has them (E-M2); B-M2 makes them required. A part
  // that needs one checks for it.
  /** Where this part is. */
  useMountContext?(): MountContext;
  /** A spot this component declares, as a list of its entries, to draw one at a time with `<Spot entry>`. Only the
   *  declaring part lists a spot. */
  useSpotEntries?(name: string, spotKey?: string): { readonly entries: readonly SpotEntryView[]; subscribe(listener: () => void): Unsubscribe };
  /** Shows a menu at a point in the part; resolves with the chosen item's id, or null. */
  useMenu?(): (items: readonly MenuItem[], at: { x: number; y: number }) => Promise<string | null>;
  /** Drags between parts, through the core: `offer` returns a token the drop target `claim`s. */
  useDrag?(): { offer(offer: DragOffer): Promise<string | undefined>; claim(token: string): Promise<DragOffer | undefined> };
  /** Steers the surface window this part's root placed (an `app.surface` entry): show or hide it, size and place it,
   *  and say where it takes clicks. */
  useSurface?(): (request: SurfaceRequest) => void;
  /** Where this part's surface window lives, kept current as the display changes; undefined outside a surface window
   *  and until the core answers. */
  useSurfaceEnvironment?(): SurfaceEnvironment | undefined;
  /** Opens a place in the main window (Settings at a section and an item, a bot's tab): for the `clover` tree's parts
   *  only, in 1.111.1. */
  useOpen?(): (target: OpenTarget) => Promise<void>;
  /** Places a native view the core draws over this part (the Clover Browser's live view, `name` "browser"): the ref
   *  callback goes on the element the view covers (a DOM element; the SDK carries no DOM types), and the core keeps the
   *  view on it, clipped to this part's own frame. Only a plugin with `browser` places one; with two parts placing the
   *  same view, the one the person used last has it (ruling R8). */
  useViewFrame?(name: string): (element: unknown) => void;
  /** Questions waiting in any session the plugin may read, with their text (`conversation.read`). */
  useQuestions?(): { readonly questions: readonly PendingQuestion[]; subscribe(listener: () => void): Unsubscribe };
  /** Sends the user's own words (lane G's ask, the pill), in place of `conversation.send`, whose turns are the
   *  plugin's. Only the bundled `clover` tree's surfaces have it. Call it synchronously inside the key press or click
   *  that sends: the runtime counts it only within that frame's transient user activation (§5.5), and otherwise
   *  refuses it and sends nothing, so a script can't speak as the user. The app's main process carries the words to the
   *  daemon as `pill.send`, an `app`-role method no layer may call (#179's review, S2). */
  useUserSend?(): ((to: UserSendTarget, message: UserSendMessage) => Promise<void>) | undefined;
}

// `useLayerMessage()` (the app's commands from shortcuts and menus) stays lane E's, for the `clover` layer only, and
// is not part of these declarations: no third-party part hears the app's commands.

/** One frame of the speech the app plays for a bot, for lip-sync: what the `avatar` spot's `speech` feed hands on, so
 *  an avatar needs no `audio` capability. Provisional: lane G proposes the shape, and lane E, whose runtime carries
 *  the feed across layers, agrees it. */
export interface SpeechFrame {
  /** When it plays: seconds on the layer's audio clock, output latency already added. */
  t: number;
  /** Loudness, 0 to 1 (RMS). */
  rms: number;
  /** Brightness: the spectral centroid, in Hz. */
  centroid: number;
}

/** The `avatar` spot's `speech` prop. */
export interface SpeechFeed {
  /** Frames as they're made, in time order, a little ahead of when they play. */
  subscribe(listener: (frames: readonly SpeechFrame[]) => void): Unsubscribe;
  /** The audio clock now, in the frames' seconds. */
  now(): number;
}

/** A component module: the exports of `client.entry` that `ui` entries name. */
export type ClientModule = Record<string, UiComponent<EntryProps<any>>>;
