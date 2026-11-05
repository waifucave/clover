// Contract: BrowserApi (spec §12.1 "The Clover Browser"; §5.4 the `browser` capability; spike S7). Owner: lane L.
//
// Clover runs its own browser on each computer: on desktops in the app's own Electron, where no app runs in Chrome for
// Testing's headless shell driven by the daemon. Plugins with `browser` open tabs, navigate and use the DevTools
// protocol through this API, and the browser view (a UI plugin) shows tabs its own way.
//
// What the contract promises:
// * Tabs live in their owner's partition: one per bot, one for the user, never per site.
// * A tab is in one of three places (S7): `headless` in the host window at the agent's 1280×800, `shown` in a browser
//   view at the view's size, or `resting` in the never-shown window, throttled. It moves without reloading, and a
//   resting tab goes back to headless before the next command reaches it.
// * DevTools calls pass the allow list (`isCdpMethodAllowed`): no `Target`, `Browser` or `Storage`, and no path
//   outside the bot's scratch folder in a call's parameters.
// * A Point from a screenshot taken at another size is refused (`refused`), as is an agent's command on a tab the user
//   holds (`held`, Winter's control lease). The user's own commands are never refused for a hold.
// * A host that stopped drawing gives an error, never a stale picture (S7 "What M1 should start with" item 4).
import {
  AGENT_VIEWPORT, isCdpMethodAllowed,
  type Caller, type Screenshot, type TabOwner, type TabView, type Viewport,
} from "@waifucave/clover-protocol";
import type { Unsubscribe } from "./common";

export { AGENT_VIEWPORT, isCdpMethodAllowed };

export type BrowserChange = { type: "changed"; tab: TabView } | { type: "closed"; id: string; by: "user" | "page" | "crash" | "api" };

export interface CdpOptions {
  /** The viewport the Point in this call came from; refused if the tab's differs now (§12.1). */
  viewport?: Viewport;
}

export interface BrowserApi {
  /** This browser's computer. */
  readonly computer: string;
  tabs(filter?: { owner?: TabOwner }): TabView[];
  open(req: { owner: TabOwner; url?: string; show?: { view: string; viewport: Viewport } }, as: Caller): Promise<TabView>;
  close(id: string, as: Caller): Promise<void>;
  navigate(id: string, url: string, as: Caller): Promise<TabView>;
  /** Moves a tab into a browser view, laid out at the view's size. */
  show(id: string, view: string, viewport: Viewport): Promise<TabView>;
  /** Moves a tab back to headless at the agent's 1280×800. */
  hide(id: string): Promise<TabView>;
  screenshot(id: string, as: Caller, opts?: { format?: Screenshot["format"]; quality?: number }): Promise<Screenshot>;
  cdp(id: string, method: string, params: Record<string, unknown> | undefined, as: Caller, opts?: CdpOptions): Promise<unknown>;
  onCdpEvent(id: string, fn: (method: string, params: unknown) => void): Unsubscribe;
  /** The user takes a tab in the view, or gives it back (the app's main process saw their gesture). */
  setHeld(id: string, held: boolean): void;
  watch(fn: (change: BrowserChange) => void): Unsubscribe;
}

/** The CDP methods whose parameters carry paths, and which parameters: each path must sit inside the bot's scratch. */
export const CDP_PATH_PARAMS: Readonly<Record<string, readonly string[]>> = {
  "DOM.setFileInputFiles": ["files"],
  "Page.setDownloadBehavior": ["downloadPath"],
};

/** Whether a command from `as` may act on a tab the user holds: only the user's own. */
export function mayActOnHeldTab(as: Caller): boolean {
  return as.kind === "user";
}

export function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.width === b.width && a.height === b.height;
}
