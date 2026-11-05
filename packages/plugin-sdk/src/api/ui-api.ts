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

/** `<Spot name key props>`: shows a spot this component declares; the core mounts each entry there, inline in the same
 *  layer or as a frame from its own (§5.5). */
export interface SpotElementProps {
  name: string;
  key?: string;
  /** Handed to each entry, checked against the spot's declared `props`. */
  props?: Record<string, unknown>;
}

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
   *  ✓, `cross` ✕, `open` ↗ (an elicitation's link). */
  look?: "label" | "check" | "cross" | "open";
  /** A glyph button's side in CSS pixels, at least 24 (smaller draws 24). */
  size?: number;
  className?: string;
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
}

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
