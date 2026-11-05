// The Clover Browser's contract (spec §12.1), a copy of lane B's `packages/protocol/src/browser.ts` (#157) until the
// app depends on `@waifucave/clover-protocol`. The core re-exports B's own (`packages/core/src/browser/contract.ts`,
// with R10's session owner), and `test/browser-unit.test.ts` checks this copy against it.
//
// Owner decisions since the pin (items 92–94): bot tabs are drawn offscreen and shown through a viewport, so
// `headless` means "offscreen, drawing for a bot"; while a screen reader is on, new bot tabs start as real views in a
// hidden host window instead (the hybrid).
import { createHash } from "node:crypto";

/** A bot's tabs live in its own partition, the user's in another; never per site (§12.1). A session without a bot has
 *  a partition of its own (ruling R10). `session` is proposed to lane B, not in its pin yet. */
export type TabOwner = { kind: "bot"; bot: string } | { kind: "session"; session: string } | { kind: "user" };

/** Where a tab is: `headless` (drawing for a bot at 1280×800), `shown` (in a browser view at the view's size) or
 *  `resting` (not drawing, until a bot's next command). */
export type TabPlace = "headless" | "shown" | "resting";

export interface Viewport {
  width: number;
  height: number;
}

/** The agent's own size, which a tab returns to when it leaves the view (§12.1). */
export const AGENT_VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });

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

export type ScreenshotFormat = "png" | "jpeg" | "webp";

export interface Screenshot {
  format: ScreenshotFormat;
  /** base64. */
  data: string;
  width: number;
  height: number;
  takenAt: number;
  /** How old the picture's content was when it was taken. */
  contentAgeMs?: number;
}

/** One command the core sends the app for a tab (`app.tab.command`). */
export type AppTabCommand =
  | { kind: "close" }
  | { kind: "navigate"; url: string }
  | { kind: "place"; place: TabPlace; view?: string; viewport?: Viewport }
  | { kind: "screenshot"; format: ScreenshotFormat; quality?: number }
  | { kind: "cdp"; method: string; params?: Record<string, unknown> };

/** What the app reports back (`browser.report`). */
export type AppTabEvent =
  | { kind: "changed"; tab: TabView }
  | { kind: "closed"; id: string; by: "user" | "page" | "crash" }
  | { kind: "cdp"; id: string; method: string; params: unknown }
  | { kind: "stalled"; id: string; sinceMs: number };

/** DevTools domains the API never passes (§12.1). */
export const CDP_DENIED_DOMAINS = ["Target", "Browser", "Storage", "SystemInfo", "Tethering", "ServiceWorker"] as const;
/** DevTools domains the API passes. A method outside these is refused before it reaches a tab. */
export const CDP_ALLOWED_DOMAINS = [
  "Page", "Runtime", "DOM", "Input", "Network", "Emulation", "Log", "Fetch", "IO", "Accessibility", "CSS",
  "DOMSnapshot", "Overlay", "Inspector",
] as const;

export function cdpDomainOf(method: string): string {
  const dot = method.indexOf(".");
  return dot < 0 ? method : method.slice(0, dot);
}

export function isCdpMethodAllowed(method: string): boolean {
  const domain = cdpDomainOf(method);
  return (CDP_ALLOWED_DOMAINS as readonly string[]).includes(domain) && !(CDP_DENIED_DOMAINS as readonly string[]).includes(domain);
}

/** Schemes no browser partition loads, however the load starts. */
export const BROWSER_REFUSED_SCHEMES = [
  "file:", "filesystem:", "chrome:", "chrome-extension:", "chrome-untrusted:", "devtools:", "view-source:",
] as const;
/** The app's and core's own schemes all start with `clover`, so no scheme with this prefix serves a browser
 *  partition. */
export const CLOVER_SCHEME_PREFIX = "clover";

/** Whether a browser partition may load a URL: not a refused scheme, not one of Clover's own, and of `about:` only
 *  `about:blank` and `about:srcdoc`. */
export function isBrowserUrlAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.toLowerCase();
  if ((BROWSER_REFUSED_SCHEMES as readonly string[]).includes(scheme) || scheme.startsWith(CLOVER_SCHEME_PREFIX)) return false;
  if (scheme === "about:") return u.href === "about:blank" || u.href === "about:srcdoc";
  return true;
}

/** The session partition a tab lives in: one per bot, one for the user, never per site (§12.1). A plugin id never
 *  holds `--`, so a child bot's `/` becomes `--` without two bots ever sharing a partition. The core computes the
 *  same name (`packages/core/src/browser/policy.ts`). */
export function partitionFor(owner: TabOwner): string {
  if (owner.kind === "user") return "persist:user";
  if (owner.kind === "session") {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(owner.session)) throw new Error("that is not a session's id");
    return `persist:session-${createHash("sha256").update(owner.session).digest("hex").slice(0, 32)}`;
  }
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*(\/[a-z][a-z0-9]*(-[a-z0-9]+)*)?$/.test(owner.bot) || owner.bot.length > 81) {
    throw new Error(`"${owner.bot}" is not a bot's id`);
  }
  return `persist:bot-${owner.bot.replace("/", "--")}`;
}
