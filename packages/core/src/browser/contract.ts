// The Clover Browser's contract (spec §12.1): lane B's `packages/protocol/src/browser.ts` (#157, merged), the one
// source of the allow list, the URL rule and the shapes the app, the plugins and the core all check against. This
// file re-exports it, with one addition that waits on lane B: a session's own tabs (ruling R10), so `TabOwner`, and
// `TabView` with it, are B's plus `{ kind: "session" }`. The app's copy (`apps/desktop/src/main/browser/contract.ts`)
// is checked against this one in `apps/desktop/test/browser-unit.test.ts`.
//
// Owner decisions since the pin (items 92–94): bot tabs are drawn offscreen and shown through a viewport, so
// `headless` means "offscreen, drawing at the bots' rate" rather than "in a host window"; while a screen reader is on,
// new bot tabs start as real views in a hidden host window instead (the hybrid). Neither changes a name.
import type { Screenshot as ProtocolScreenshot, TabPlace, Viewport } from "@waifucave/clover-protocol";

export {
  AGENT_VIEWPORT, BROWSER_REFUSED_SCHEMES, CDP_ALLOWED_DOMAINS, CDP_DENIED_DOMAINS, CLOVER_SCHEME_PREFIX, cdpDomainOf,
  isBrowserUrlAllowed, isCdpMethodAllowed,
} from "@waifucave/clover-protocol";
export type { TabPlace, Viewport } from "@waifucave/clover-protocol";

/** A bot's tabs live in its own partition, the user's in another; never per site (§12.1). A session without a bot (a
 *  coding session) has a partition of its own too (ruling R10: the person's is never a session's by default).
 *  `session` is not in lane B's pin yet: proposed to B. */
export type TabOwner = { kind: "bot"; bot: string } | { kind: "session"; session: string } | { kind: "user" };

/** B's `TabView`, with the owner above. */
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

export type Screenshot = ProtocolScreenshot;
export type ScreenshotFormat = Screenshot["format"];

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
