// Contract: BrowserApi (spec §12.1 "The Clover Browser"; §5.4 the `browser` capability; spike S7). Owner: lane L.
//
// Clover runs its own browser on each computer: on desktops in the app's own Electron, where no app runs in Chrome for
// Testing's headless shell driven by the daemon. Plugins with `browser` open tabs, navigate and use the DevTools
// protocol through this API, and the browser view (a UI plugin) shows tabs its own way.
//
// What the contract promises:
// * Tabs live in their owner's partition: one per bot, one per session without a bot (a coding session, ruling R10),
//   and the person's own (`user`), never per site. A session drives the person's partition only after an explicit card
//   for that session, and never by default (R10).
// * Two views showing one tab: the view the person used last has it live (`TabView.view`), and any other shows its
//   last still frame, marked paused (R8).
// * A tab is in one of three places (S7): `headless` in the host window at the agent's 1280×800, `shown` in a browser
//   view at the view's size, or `resting` in the never-shown window, throttled. It moves without reloading, and a
//   resting tab goes back to headless before the next command reaches it.
// * DevTools calls pass the allow list (`isCdpMethodAllowed`): no `Target`, `Browser` or `Storage`, and no path
//   outside the bot's scratch folder in a call's parameters.
// * A partition loads nothing `isBrowserUrlAllowed` refuses (`file:`, `chrome:`, `devtools:`, `view-source:`, the
//   app's and core's own `clover…` schemes), however the request starts: `open` and `navigate` refuse it at once
//   (`refused`), and the partition's session blocks it from a link, a redirect, a frame or DevTools' `Page.navigate`,
//   which fails as a blocked load (review S17). The check lives in the session, not in reading DevTools parameters.
// * Who may open a tab for which owner (#179's review, S1; `mayOpenFor`), judged on the call's own caller, which the
//   core binds (R7): a plugin acting as itself only in its own partition (`{ kind: "plugin" }`, `plugin-<id>`); a
//   session for itself or for its own bot; the person's partition (`user`) only for a session with its R10 card; the
//   user and the core for any owner. Anything else is `refused`.
// * A Point from a screenshot taken at another size is refused (`refused`). On a tab the user holds (`held`, the
//   inherited browser tool's control lease) only the user's own commands pass, and a layer's command the app's main
//   process saw come from the user's own input in that layer (`BrowserInput.userInput`; a layer's caller is its plugin,
//   never the user), so a view's back button works while held (`mayActOnHeldTab`). A session's command, and a
//   plugin's own code acting as itself, are refused (`held`), so a plugin can't carry a tool call's action past the
//   hold on a timer. A plugin's call made while it serves a tool call is that call's session (R7), bound by the core.
// * A host that stopped drawing gives an error, never a stale picture (S7 "What M1 should start with" item 4).
import {
  AGENT_VIEWPORT, isBrowserUrlAllowed, isCdpMethodAllowed,
  type Caller, type Screenshot, type TabOwner, type TabView, type Viewport,
} from "@waifucave/clover-protocol";
import type { Unsubscribe } from "./common";

export { AGENT_VIEWPORT, isBrowserUrlAllowed, isCdpMethodAllowed };

export type BrowserChange = { type: "changed"; tab: TabView } | { type: "closed"; id: string; by: "user" | "page" | "crash" | "api" };

/** What the app's main process vouches for a layer's command (#179's review, S1): `userInput` when it saw the command
 *  come from the user's own input in that layer's view (a trusted click or key, inside its user activation, as for
 *  `useUserSend`). The core takes it only from the app's own connection, never from the layer's params. */
export interface BrowserInput {
  userInput?: boolean;
}

export interface CdpOptions extends BrowserInput {
  /** The viewport the Point in this call came from; refused if the tab's differs now (§12.1). */
  viewport?: Viewport;
}

export interface BrowserApi {
  /** This browser's computer. */
  readonly computer: string;
  tabs(filter?: { owner?: TabOwner }): TabView[];
  /** Refused for an owner the caller may not name (`mayOpenFor`). */
  open(req: { owner: TabOwner; url?: string; show?: { view: string; viewport: Viewport } }, as: Caller): Promise<TabView>;
  close(id: string, as: Caller, input?: BrowserInput): Promise<void>;
  navigate(id: string, url: string, as: Caller, input?: BrowserInput): Promise<TabView>;
  /** Moves a tab into a browser view, laid out at the view's size. */
  show(id: string, view: string, viewport: Viewport): Promise<TabView>;
  /** Moves a tab back to headless at the agent's 1280×800. */
  hide(id: string): Promise<TabView>;
  screenshot(id: string, as: Caller, opts?: { format?: Screenshot["format"]; quality?: number } & BrowserInput): Promise<Screenshot>;
  cdp(id: string, method: string, params: Record<string, unknown> | undefined, as: Caller, opts?: CdpOptions): Promise<unknown>;
  onCdpEvent(id: string, fn: (method: string, params: unknown) => void): Unsubscribe;
  /** The user takes a tab in the view, or gives it back (the app's main process saw their gesture). */
  setHeld(id: string, held: boolean): void;
  /** A session's R10 card was answered: it may open tabs in the person's own partition, or no longer may. */
  setUserPartition(session: string, allowed: boolean): void;
  watch(fn: (change: BrowserChange) => void): Unsubscribe;
}

/** The CDP methods whose parameters carry paths, and which parameters: each path must sit inside the bot's scratch. */
export const CDP_PATH_PARAMS: Readonly<Record<string, readonly string[]>> = {
  "DOM.setFileInputFiles": ["files"],
  "Page.setDownloadBehavior": ["downloadPath"],
};

/** Whether a command from `as` may act on a tab the user holds: the user's own, and a layer's that the app saw come
 *  from the user's input (`input.userInput`; a layer's caller is its plugin). A session's, a peer's, the core's and a
 *  plugin's own code acting as itself are refused (#179's review, S1). */
export function mayActOnHeldTab(as: Caller, input: BrowserInput = {}): boolean {
  return as.kind === "user" || (as.kind === "plugin" && input.userInput === true);
}

/** Whether `as` may open a tab for `owner` (#179's review, S1): a plugin acting as itself only in its own partition; a
 *  session for itself or its own bot; the person's own partition only for a session with its R10 card
 *  (`userPartition`); the user and the core for any owner. */
export function mayOpenFor(owner: TabOwner, as: Caller, userPartition: (session: string) => boolean): boolean {
  if (as.kind === "user" || as.kind === "core") return true;
  if (as.kind === "plugin") return owner.kind === "plugin" && owner.pluginId === as.pluginId;
  if (as.kind !== "session") return false;
  if (owner.kind === "session") return owner.session === as.sessionId;
  if (owner.kind === "bot") return as.bot !== undefined && owner.bot === as.bot;
  if (owner.kind === "user") return userPartition(as.sessionId);
  return false;
}

/** The partition a tab's owner gives it: `persist:bot-<id>`, `persist:session-<id>`, `persist:plugin-<id>` (a
 *  plugin's id with `/` as `--`), or `persist:user`. */
export function partitionFor(owner: TabOwner): string {
  switch (owner.kind) {
    case "bot": return `persist:bot-${owner.bot.replace(/\//g, "--")}`;
    case "session": return `persist:session-${owner.session}`;
    case "plugin": return `persist:plugin-${owner.pluginId.replace(/\//g, "--")}`;
    case "user": return "persist:user";
  }
}

export function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.width === b.width && a.height === b.height;
}
