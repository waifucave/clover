// The browser view's types: lane B's browser contract, mirrored, and the props of its parts.
//
// The first half is a local copy of what the plugin needs from lane B's contract (`TabView`, `TabOwner`,
// `Viewport` in `packages/protocol/src/browser.ts`, and `BrowserApi` in `packages/plugin-sdk/src/api/plugin-api.ts`,
// both on lane/b-m0 until B merges), the way lane F's parts mirror theirs. When B is on main, this half becomes a
// re-export of `@waifucave/clover-protocol` and `@waifucave/clover-plugin-sdk`. Only the fields the view reads are
// kept where a type is large; none is renamed.
import type { Ref } from "react";

// ---- Lane B's contract (mirrored) -----------------------------------------------------------------------------

/** A bot's tabs live in its own partition, the user's in another. */
export type TabOwner = { kind: "bot"; bot: string } | { kind: "session"; session: string } | { kind: "plugin"; pluginId: string } | { kind: "user" };

/** `headless` in the host window at the agent's 1280x800, `shown` in a browser view at the view's size, `resting` in
 *  the never-shown window until a bot's next command. */
export type TabPlace = "headless" | "shown" | "resting";

export interface Viewport {
  width: number;
  height: number;
}

export interface TabView {
  id: string;
  computer: string;
  owner: TabOwner;
  partition: string;
  url: string;
  title: string;
  place: TabPlace;
  viewport: Viewport;
  loading: boolean;
  /** The user holds it in the view; an agent's commands are refused meanwhile. */
  heldByUser: boolean;
}

export type Unsubscribe = () => void;

/** A picture of a tab (lane B's `Screenshot`). */
export interface Screenshot {
  format: "png" | "jpeg" | "webp";
  /** Base64. */
  data: string;
  width: number;
  height: number;
  takenAt: number;
}

/** The `browser` member of the plugin API (the plugin needs the `browser` capability). The call the view does not
 *  make (`onCdpEvent`) is left out of this copy. */
export interface BrowserApi {
  tabs(filter?: { owner?: TabOwner; computer?: string }): Promise<TabView[]>;
  /** `show` puts it in that view at that size at once (lane B's B-M1 shape); headless otherwise. */
  open(opts: { owner: TabOwner; url?: string; show?: { view: string; viewport: Viewport }; computer?: string }): Promise<TabView>;
  close(tab: string): Promise<void>;
  navigate(tab: string, url: string): Promise<TabView>;
  show(tab: string, view: string, viewport: Viewport): Promise<TabView>;
  hide(tab: string): Promise<TabView>;
  cdp<R = unknown>(tab: string, method: string, params?: Record<string, unknown>, opts?: { viewport?: Viewport }): Promise<R>;
  screenshot(tab: string, opts?: { format?: "png" | "jpeg" | "webp"; quality?: number }): Promise<Screenshot>;
  watch(listener: (tab: TabView) => void): Unsubscribe;
}

/** What the plugin API hands a component, as far as this view uses it. */
export interface PluginApi {
  readonly browser?: BrowserApi;
}

// ---- The spot's props (lane B's `panel` spot; lane E hands them over) -----------------------------------------

/** The `panel` spot's props, `{ app, session? }` in lane B's catalog, plus `bot`: the host passes the bot's id
 *  in a bot's tab so the view shows that bot's tabs (a request to lanes B and F; see the container's comment). */
export interface BrowserSpotProps {
  app?: string;
  /** A coding session's panel shows that session's own tabs (R10), unless `bot` says whose. */
  session?: string;
  /** Present in a bot's tab: whose tabs these are. */
  bot?: string;
  /** The panel host's header row for this panel (lane F's `PanelHost`): the tab row is drawn there, and the host's
   *  title steps aside. Absent or null: the panel draws its own row. */
  header?: HTMLElement | null;
  /** Whether the person used this panel last (lane F's `PanelHost`): of two panels showing browser tabs, the one used
   *  last has the live view (ruling R8), so becoming the one used last takes the live view back. */
  usedLast?: boolean;
}

/** What lane E's runtime gives every component (`EntryProps` in `ui-api.ts`): its spot's props, the resolved tokens
 *  and which entry it is. The view reads only `props`. */
export interface BrowserEntryProps {
  props?: BrowserSpotProps;
  tokens?: Readonly<Record<string, unknown>>;
  entry?: { pluginId: string; id: string; spot: string; key?: string };
}

// ---- The parts' own props -------------------------------------------------------------------------------------

/** A tab as the row draws it. */
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading?: boolean;
  /** The user holds it in the view: the bot's commands wait. */
  held?: boolean;
}

export type AnnotateTool = "pointer" | "pen" | "box" | "text";

export interface BrowserTabsProps {
  tabs: BrowserTab[];
  active: string | undefined;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew?: () => void;
}

/** The chrome around the live view: back, forward, reload, the address bar, the frame, and the annotate strip. */
export interface BrowserChromeProps {
  tab: BrowserTab | undefined;
  /** Whether the browser's live view is on screen in the frame (the tab is `shown`): nothing then sits under it. */
  live?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onReload?: () => void;
  /** What the user typed in the address bar, on Enter. The container decides what it opens, and says `false` when
   *  it could not, so the typed address stays in the bar to be fixed. */
  onNavigate?: (input: string) => void | boolean | Promise<void | boolean>;
  /** A failure to say in plain words, attached to the bar. */
  error?: string | null;
  /** The live view went to another panel the person used since (ruling R8): the frame holds the tab's last picture,
   *  and using it brings the live view back here. */
  paused?: { picture?: string; onResume: () => void };
  /** The frame the browser's live view fills; the container measures it. */
  frameRef?: Ref<HTMLDivElement>;
  /** Mark up the page for the bot: point, draw, box or write on it. Not mounted until the API can send marks. */
  annotate?: { tool: AnnotateTool | null; onTool: (tool: AnnotateTool | null) => void };
}
