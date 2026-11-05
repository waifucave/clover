// What the Clover Browser's API lets through, decided in the core before anything reaches the app (spec §12.1).
// The app checks again where it can (its own allow list on each tab's debugger, and each partition's session
// refusing schemes), so a bug on one side never opens the door alone.
import { AGENT_VIEWPORT, CDP_ALLOWED_DOMAINS, isCdpMethodAllowed, type TabOwner, type Viewport } from "./contract";

/** The ids a bot may have (its plugin's id, a child's included: `luna`, `pack/luna`). */
const BOT_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\/[a-z][a-z0-9]*(-[a-z0-9]+)*)?$/;

export function isBotId(bot: string): boolean {
  if (bot.length > 81 || !BOT_ID_RE.test(bot)) return false;
  return bot.split("/").every((part) => part.length >= 2 && part.length <= 40);
}

/** The session partition a tab lives in: one per bot, one for the user, never per site (§12.1). A plugin id never
 *  holds `--`, so a child bot's `/` becomes `--` without two bots ever sharing a partition. */
export function partitionFor(owner: TabOwner): string {
  if (owner.kind === "user") return "persist:user";
  if (!isBotId(owner.bot)) throw new BrowserError("bad_owner", `"${owner.bot}" is not a bot's id`);
  return `persist:bot-${owner.bot.replace("/", "--")}`;
}

export function sameOwner(a: TabOwner, b: TabOwner): boolean {
  return a.kind === b.kind && (a.kind === "user" || a.bot === (b as { bot: string }).bot);
}

/** DevTools methods inside the allowed domains that the API still refuses, because they reach outside the page:
 *  files on the computer, where downloads go, or the browser's own settings. A bot hands a page a file through the
 *  browser view's file chooser, never by path. */
export const CDP_DENIED_METHODS: readonly string[] = [
  "DOM.setFileInputFiles",
  "Page.setDownloadBehavior",
  "Page.setInterceptFileChooserDialog",
  "Network.setCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Network.loadNetworkResource",
  "Input.setInterceptDrags",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride",
  "Emulation.setVisibleSize",
];

/** Why a call was refused, in words a bot or a person can act on. */
export type BrowserErrorCode =
  | "bad_owner" | "no_app" | "no_tab" | "not_yours" | "held" | "url_refused" | "method_refused"
  | "point_stale" | "stalled" | "bad_viewport" | "app_failed";

export class BrowserError extends Error {
  constructor(readonly code: BrowserErrorCode, message: string) {
    super(message);
    this.name = "BrowserError";
  }
}

export function checkCdpMethod(method: string): void {
  if (!isCdpMethodAllowed(method)) {
    throw new BrowserError("method_refused", `${method} isn't allowed: the browser passes only these DevTools domains: ${CDP_ALLOWED_DOMAINS.join(", ")}`);
  }
  if (CDP_DENIED_METHODS.includes(method)) throw new BrowserError("method_refused", `${method} isn't allowed: it reaches outside the page`);
}

/** DevTools methods that act at a point on the page. A point taken from a screenshot at another size lands somewhere
 *  else, so these are refused when the caller says which viewport its point came from and the tab's differs (§12.1,
 *  from Winter's headless lessons). */
export const POINT_METHODS: readonly string[] = [
  "Input.dispatchMouseEvent",
  "Input.dispatchTouchEvent",
  "Input.dispatchDragEvent",
  "Input.emulateTouchFromMouseEvent",
  "Input.synthesizePinchGesture",
  "Input.synthesizeScrollGesture",
  "Input.synthesizeTapGesture",
  "DOM.getNodeForLocation",
];

export function checkPoint(method: string, from: Viewport | undefined, tab: Viewport): void {
  if (from === undefined || !POINT_METHODS.includes(method)) return;
  if (from.width !== tab.width || from.height !== tab.height) {
    throw new BrowserError("point_stale", `the point came from a ${from.width}×${from.height} picture, but the tab is ${tab.width}×${tab.height} now: take a new screenshot`);
  }
}

export function checkViewport(v: Viewport): void {
  const ok = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 16_384;
  if (!ok(v.width) || !ok(v.height)) throw new BrowserError("bad_viewport", `a viewport is whole pixels, 1–16384 each way (got ${v.width}×${v.height})`);
}

export { AGENT_VIEWPORT };
