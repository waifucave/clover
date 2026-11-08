// What the Clover Browser's API lets through, decided in the core before anything reaches the app (spec §12.1).
// The app checks again where it can (its own allow list on each tab's debugger, and each partition's session
// refusing schemes), so a bug on one side never opens the door alone.
import { createHash } from "node:crypto";
import { AGENT_VIEWPORT, CDP_ALLOWED_DOMAINS, isCdpMethodAllowed, type TabOwner, type Viewport } from "./contract";

/** The ids a bot may have (its plugin's id, a child's included: `luna`, `pack/luna`). */
const BOT_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\/[a-z][a-z0-9]*(-[a-z0-9]+)*)?$/;

export function isBotId(bot: string): boolean {
  if (bot.length > 81 || !BOT_ID_RE.test(bot)) return false;
  return bot.split("/").every((part) => part.length >= 2 && part.length <= 40);
}

/** A session's id, as a tab's owner: what B's `SessionId` allows, at most. */
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The session partition a tab lives in: one per bot, one per session without a bot, one for the user, never per site
 *  (§12.1). A plugin id never holds `--`, so a child bot's `/` becomes `--` without two bots ever sharing a partition.
 *  A session's partition is named by a hash of its id, so no id ever spells a folder name. On disk each is
 *  `<userData>/Partitions/<name after "persist:">`. */
export function partitionFor(owner: TabOwner): string {
  if (owner.kind === "user") return "persist:user";
  if (owner.kind === "session") {
    if (!SESSION_ID_RE.test(owner.session)) throw new BrowserError("bad_owner", "that is not a session's id");
    return `persist:session-${createHash("sha256").update(owner.session).digest("hex").slice(0, 32)}`;
  }
  if (owner.kind === "plugin") {
    // A plugin's id follows the same rule as a bot's (a bot is a plugin); a child's `/` becomes `--` the same way.
    if (!isBotId(owner.plugin)) throw new BrowserError("bad_owner", `"${owner.plugin}" is not a plugin's id`);
    return `persist:plugin-${owner.plugin.replace("/", "--")}`;
  }
  if (!isBotId(owner.bot)) throw new BrowserError("bad_owner", `"${owner.bot}" is not a bot's id`);
  return `persist:bot-${owner.bot.replace("/", "--")}`;
}

export function sameOwner(a: TabOwner, b: TabOwner): boolean {
  if (a.kind === "bot") return b.kind === "bot" && a.bot === b.bot;
  if (a.kind === "session") return b.kind === "session" && a.session === b.session;
  if (a.kind === "plugin") return b.kind === "plugin" && a.plugin === b.plugin;
  return b.kind === "user";
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
  | "bad_owner" | "no_app" | "no_tab" | "not_yours" | "needs_ok" | "held" | "url_refused" | "method_refused"
  | "point_stale" | "stalled" | "bad_viewport" | "app_failed" | "bad_setting" | "computer_offline" | "no_computer" | "tab_closed" | "read_only";

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
 *  the headless lessons it carries over). */
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
