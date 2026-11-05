// Clover protocol area: the Clover Browser (spec §12.1). Owner: lane L. Pinned by lane B at M0, from spike S7 (lane
// L's report of November 5).
//
// Each computer runs its own browser. On desktops it lives in the app's Electron: a tab is a `WebContentsView` in
// its bot's own partition (the user's tabs in another), headless in a host window the user never sees, shown in the
// browser view, or resting in a window that is never shown, and it moves between them without reloading (S7 §1–§2;
// the host window is the owner's decision, S7 edit 1). Where no app runs, the daemon drives Chrome for Testing's
// headless shell over the DevTools pipe. Plugins with `browser` drive it through this API, which passes only
// allowlisted DevTools domains; while the user holds a tab, an agent's commands on it are refused.
import { z } from "zod";
import { BotId, ComputerName, Ok, Timestamp } from "./common";
import { coreEvent, defineEvent, defineMethod } from "./rpc";

/** DevTools domains the API never passes (§12.1). */
export const CDP_DENIED_DOMAINS = ["Target", "Browser", "Storage", "SystemInfo", "Tethering", "ServiceWorker"] as const;
/** DevTools domains the API passes, method by method within lane L's allow list (from Winter's `cdp-allowlist.ts`,
 *  less `Target`). A method outside these domains is refused before it reaches a tab. */
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

/** A bot's tabs live in its own partition, the user's in another; never per site (§12.1). */
export const TabOwner = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), bot: BotId }),
  z.object({ kind: z.literal("user") }),
]);
export type TabOwner = z.infer<typeof TabOwner>;

/** Where a tab is (S7): `headless` in the host window at the agent's 1280×800, `shown` in the browser view at the
 *  view's size, `resting` in the never-shown window, throttled, until a bot's next command. */
export const TabPlace = z.enum(["headless", "shown", "resting"]);
export type TabPlace = z.infer<typeof TabPlace>;

export const Viewport = z.object({ width: z.number().int().positive().max(16_384), height: z.number().int().positive().max(16_384) });
export type Viewport = z.infer<typeof Viewport>;
/** The agent's own size, which a tab returns to when it leaves the view (§12.1). */
export const AGENT_VIEWPORT: Viewport = { width: 1280, height: 800 };

export const TabView = z.object({
  id: z.string().min(1).max(128),
  computer: ComputerName,
  owner: TabOwner,
  partition: z.string().max(256),
  url: z.string().max(8192),
  title: z.string().max(1024),
  place: TabPlace,
  viewport: Viewport,
  loading: z.boolean(),
  /** The user holds it in the view; an agent's commands are refused meanwhile (Winter's control lease). */
  heldByUser: z.boolean(),
});
export type TabView = z.infer<typeof TabView>;

export const Screenshot = z.object({
  format: z.enum(["png", "jpeg", "webp"]),
  /** base64. */
  data: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** When the picture was asked for and how old its content was; a host that stopped drawing gives an error, never
   *  a stale picture (S7, "What M1 should start with" item 4). */
  takenAt: Timestamp,
  contentAgeMs: z.number().nonnegative().optional(),
});
export type Screenshot = z.infer<typeof Screenshot>;

const Tab = z.object({ id: z.string().min(1).max(128) });
const API = { roles: ["app", "layer", "plugin-host"] as const, capability: "browser" };

export const BROWSER_METHODS = {
  // For plugins with `browser`, and the browser view.
  browserTabs: defineMethod({
    name: "browser.tabs", owner: "L", ...API,
    params: z.object({ owner: TabOwner.optional(), computer: ComputerName.optional() }),
    result: z.object({ tabs: z.array(TabView) }),
    doc: "Open tabs, a bot's or the user's.",
  }),
  browserOpen: defineMethod({
    name: "browser.open", owner: "L", ...API,
    params: z.object({ owner: TabOwner, url: z.string().max(8192).optional(), show: z.boolean().optional(), computer: ComputerName.optional() }),
    result: z.object({ tab: TabView }),
    doc: "Opens a tab in its owner's partition, headless unless shown.",
  }),
  browserClose: defineMethod({
    name: "browser.close", owner: "L", ...API, params: Tab, result: Ok,
    doc: "Closes a tab, whoever opened it.",
  }),
  browserNavigate: defineMethod({
    name: "browser.navigate", owner: "L", ...API,
    params: z.object({ id: z.string().min(1).max(128), url: z.string().min(1).max(8192) }),
    result: z.object({ tab: TabView }),
    doc: "Loads a URL in a tab.",
  }),
  browserShow: defineMethod({
    name: "browser.show", owner: "L", ...API,
    params: z.object({ id: z.string().min(1).max(128), view: z.string().min(1).max(128), viewport: Viewport }),
    result: z.object({ tab: TabView }),
    doc: "Moves a tab into a browser view without reloading; it lays out at the view's size.",
  }),
  browserHide: defineMethod({
    name: "browser.hide", owner: "L", ...API, params: Tab, result: z.object({ tab: TabView }),
    doc: "Moves a tab back to headless, at the agent's 1280×800.",
  }),
  browserHold: defineMethod({
    /** From the app only: its main process sees the user's gesture in the view (§5.5's rule for sends, applied to
     *  taking a tab). */
    name: "browser.hold", owner: "L", roles: ["app"], userOnly: true,
    params: z.object({ id: z.string().min(1).max(128), held: z.boolean() }), result: Ok,
    doc: "The user takes or gives back a tab in the view; an agent's commands on it are refused while held.",
  }),
  browserScreenshot: defineMethod({
    name: "browser.screenshot", owner: "L", ...API,
    params: z.object({ id: z.string().min(1).max(128), format: z.enum(["png", "jpeg", "webp"]).optional(), quality: z.number().int().min(1).max(100).optional() }),
    result: Screenshot,
    doc: "A picture of a tab, taken without showing it.",
  }),
  browserCdp: defineMethod({
    name: "browser.cdp", owner: "L", ...API,
    params: z.object({
      id: z.string().min(1).max(128),
      method: z.string().min(3).max(128),
      params: z.record(z.string(), z.unknown()).optional(),
      /** The viewport a Point came from; refused if the tab's is different now (§12.1). */
      viewport: Viewport.optional(),
    }),
    result: z.object({ result: z.unknown() }),
    doc: "One DevTools call on a tab's own debugger, if its domain is allowed.",
  }),
  browserStream: defineMethod({
    name: "browser.stream", owner: "L", roles: ["app", "remote", "peer"],
    params: z.object({ id: z.string().min(1).max(128), on: z.boolean(), maxKbps: z.number().int().min(50).max(50_000).optional() }),
    result: z.object({ stream: z.string().max(128).optional() }),
    doc: "Streams a tab to another device as video on a link stream of its own (S7 edit 3).",
  }),

  // The daemon drives the app's tabs (desktops). The app reports back with `browser.report`.
  appTabOpen: defineMethod({
    name: "app.tab.open", owner: "L", roles: ["app"], direction: "from-daemon",
    params: z.object({ id: z.string().min(1).max(128), owner: TabOwner, url: z.string().max(8192).optional(), place: TabPlace }),
    result: z.object({ tab: TabView }),
    doc: "Opens a `WebContentsView` in the owner's partition.",
  }),
  appTabCommand: defineMethod({
    name: "app.tab.command", owner: "L", roles: ["app"], direction: "from-daemon",
    params: z.object({
      id: z.string().min(1).max(128),
      command: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("close") }),
        z.object({ kind: z.literal("navigate"), url: z.string().min(1).max(8192) }),
        z.object({ kind: z.literal("place"), place: TabPlace, view: z.string().max(128).optional(), viewport: Viewport.optional() }),
        z.object({ kind: z.literal("screenshot"), format: z.enum(["png", "jpeg", "webp"]), quality: z.number().int().min(1).max(100).optional() }),
        z.object({ kind: z.literal("cdp"), method: z.string().min(3).max(128), params: z.record(z.string(), z.unknown()).optional() }),
      ]),
    }),
    result: z.object({ result: z.unknown() }),
    doc: "One command on a tab in the app.",
  }),
  appTabList: defineMethod({
    name: "app.tab.list", owner: "L", roles: ["app"], direction: "from-daemon",
    params: z.object({}), result: z.object({ tabs: z.array(TabView) }),
    doc: "The app's tabs, after either side restarted.",
  }),
  browserReport: defineMethod({
    name: "browser.report", owner: "L", roles: ["app"],
    params: z.object({
      events: z.array(z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("changed"), tab: TabView }),
        z.object({ kind: z.literal("closed"), id: z.string().min(1).max(128), by: z.enum(["user", "page", "crash"]) }),
        z.object({ kind: z.literal("cdp"), id: z.string().min(1).max(128), method: z.string().max(128), params: z.unknown() }),
        z.object({ kind: z.literal("stalled"), id: z.string().min(1).max(128), sinceMs: z.number().nonnegative() }),
      ])).max(1000),
    }),
    result: Ok,
    doc: "The app reports what happened to its tabs; DevTools events only for subscribed, allowlisted methods.",
  }),
} as const;

export const TabChangedEvent = coreEvent("tab_changed", { tab: TabView });
export const TabClosedEvent = coreEvent("tab_closed", { id: z.string().min(1).max(128), computer: ComputerName });
export const CdpEventEvent = coreEvent("cdp_event", { tab: z.string().min(1).max(128), method: z.string().max(128), params: z.unknown() });

export const BROWSER_EVENTS = {
  tabChanged: defineEvent({
    type: "tab_changed", owner: "L", roles: ["app", "layer", "plugin-host"], capability: "browser", schema: TabChangedEvent,
    fixture: { type: "tab_changed", ts: 1781270000000, tab: { id: "tab_1", computer: "Studio", owner: { kind: "bot", bot: "alpha" }, partition: "persist:bot-alpha", url: "https://example.com/", title: "Example Domain", place: "headless", viewport: { width: 1280, height: 800 }, loading: false, heldByUser: false } },
    doc: "A tab opened, loaded, moved or was taken by the user.",
  }),
  tabClosed: defineEvent({
    type: "tab_closed", owner: "L", roles: ["app", "layer", "plugin-host"], capability: "browser", schema: TabClosedEvent,
    fixture: { type: "tab_closed", ts: 1781270000000, id: "tab_1", computer: "Studio" },
    doc: "A tab closed, by its owner, the page or a crash.",
  }),
  cdpEvent: defineEvent({
    type: "cdp_event", owner: "L", roles: ["layer", "plugin-host"], capability: "browser", schema: CdpEventEvent, transient: true,
    fixture: { type: "cdp_event", ts: 1781270000000, tab: "tab_1", method: "Page.loadEventFired", params: { timestamp: 1234.5 } },
    doc: "An allowlisted DevTools event from a tab the plugin follows.",
  }),
} as const;
