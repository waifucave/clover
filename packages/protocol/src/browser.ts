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
import { utf16 } from "./strings";
import { AnyPluginId, BotId, ComputerName, Ok, SessionId, Timestamp } from "./common";
import { coreEvent, defineEvent, defineMethod } from "./rpc";
import { NDJSON_MAX_LINE_BYTES } from "./ndjson";

/** DevTools domains the API never passes (§12.1). */
export const CDP_DENIED_DOMAINS = ["Target", "Browser", "Storage", "SystemInfo", "Tethering", "ServiceWorker"] as const;
/** DevTools domains the API passes, method by method within lane L's allow list (from the inherited `cdp-allowlist.ts`,
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

/** Schemes no browser partition loads, for any request or navigation however it starts: `browser.open` or
 *  `browser.navigate`, a page's link or redirect, a frame, or `Page.navigate` through DevTools (review S17). Lane L
 *  enforces them in each partition's own session (Electron's session handlers, the headless shell's request
 *  interception), never by reading DevTools parameters. `file:` would read what the fence keeps from Bash, a headless
 *  computer's key file included. */
export const BROWSER_REFUSED_SCHEMES = [
  "file:", "filesystem:", "chrome:", "chrome-extension:", "chrome-untrusted:", "devtools:", "view-source:",
] as const;
/** The app's and core's own schemes all start with `clover` (plugin assets, layers' origins, sealed frames), so no
 *  scheme with this prefix serves a browser partition (§12.1). */
export const CLOVER_SCHEME_PREFIX = "clover";

/** Whether a browser partition may load a URL: not a refused scheme, not one of Clover's own, and of `about:` only
 *  `about:blank` and `about:srcdoc` (the others are the browser's own pages). */
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

/** A bot's tabs live in its own partition, the user's in another; never per site (§12.1). */
/** Whose tab it is. A session without a bot (a coding session) has a partition of its own (ruling R10); the
 *  person's own logged-in partition (`user`) needs an explicit card per session, and is never the default. A plugin
 *  acting as itself opens tabs only in its own partition, `plugin-<id>` (#179's review, S1). */
export const TabOwner = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), bot: BotId }),
  z.object({ kind: z.literal("session"), session: SessionId }),
  z.object({ kind: z.literal("plugin"), plugin: AnyPluginId }),
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
  id: utf16(128, 1),
  computer: ComputerName,
  owner: TabOwner,
  partition: utf16(256),
  url: utf16(8192),
  title: utf16(1024),
  place: TabPlace,
  viewport: Viewport,
  loading: z.boolean(),
  /** The user holds it in the view; an agent's commands are refused meanwhile (the inherited control lease). */
  heldByUser: z.boolean(),
  /** The view showing it live, when it is `shown`. Two panels showing one tab: the one the person used last has the
   *  live view, and any other shows its last still frame, marked paused (ruling R8). */
  view: utf16(256).optional(),
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

/** The proxy setting, as Settings stores it (`browser.proxy`): mirrors the core's and the app's
 *  `BrowserProxySetting` (R14). */
export const BrowserProxySetting = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("system") }),
  z.object({
    mode: z.literal("explicit"),
    url: utf16(2048, 1),
    bypass: z.array(utf16(256, 1)).max(1024).optional(),
  }),
]);
export type BrowserProxySetting = z.infer<typeof BrowserProxySetting>;

/** The network settings the core sends whoever runs the tabs (`app.browser.configure`): the proxy
 *  setting (R14) and the bots whose LAN setting is on. */
export const BrowserNetworkConfig = z.object({
  proxy: BrowserProxySetting,
  lanBots: z.array(BotId).max(10_000),
});
export type BrowserNetworkConfig = z.infer<typeof BrowserNetworkConfig>;

/** Room kept under the daemon's NDJSON line cap for everything in a `browser.streamData` request
 *  that is not the frame: the JSON envelope and the stream id. The real envelope is a few hundred
 *  bytes; this is deliberately generous, well under `NDJSON_MAX_LINE_BYTES`. */
export const STREAM_FRAME_LINE_HEADROOM_BYTES = 256 * 1024;
/** The longest base64 `data` a frame may carry: the line cap less the headroom, a whole number of
 *  4-char groups. Longer data is refused before it is decoded, so one frame always fits one NDJSON
 *  line (the app drops over-cap frames before sending; S3). */
export const STREAM_FRAME_B64_MAX_LENGTH = Math.floor((NDJSON_MAX_LINE_BYTES - STREAM_FRAME_LINE_HEADROOM_BYTES) / 4) * 4;

/** Strict standard base64: the alphabet, the padding and the length (`Buffer.from(s, "base64")`
 *  silently skips characters it does not know, so the wire is checked first — the handler decodes). */
const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export function isStrictBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && STRICT_BASE64.test(s);
}

/** One piece of a tab's stream, from the app to the daemon (`browser.streamData`), which frames it onto
 *  each viewer's link stream. A frame's bytes ride base64 (JSON-RPC carries no binary). */
export const StreamChunk = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("config"),
    codec: z.enum(["h264", "vp8", "jpeg"]),
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
    /** The codec string, e.g. `avc1.42E01F`. */
    codecString: utf16(256, 1),
  }),
  z.object({
    kind: z.literal("frame"),
    key: z.boolean(),
    /** Microseconds. */
    timestamp: z.number().nonnegative(),
    /** The encoded chunk, base64, under one NDJSON line. */
    data: z.string().max(STREAM_FRAME_B64_MAX_LENGTH).refine(isStrictBase64, "the frame data is not valid base64"),
  }),
  z.object({ kind: z.literal("ended"), reason: z.enum(["stopped", "closed", "failed"]), message: utf16(1024).optional() }),
]);
export type StreamChunk = z.infer<typeof StreamChunk>;

const Tab = z.object({ id: utf16(128, 1) });
const API = { roles: ["app", "layer"] as const, capability: "browser" };

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
    params: z.object({
      owner: TabOwner, url: utf16(8192).optional(), computer: ComputerName.optional(),
      /** Shows it at once in that view at that size (L's question: `show` names the view); headless otherwise. */
      show: z.object({ view: utf16(256, 1), viewport: Viewport }).optional(),
    }),
    result: z.object({ tab: TabView }),
    doc: "Opens a tab in its owner's partition, headless unless `show` names a view.",
  }),
  browserClose: defineMethod({
    name: "browser.close", owner: "L", ...API, params: Tab, result: Ok,
    doc: "Closes a tab, whoever opened it.",
  }),
  browserNavigate: defineMethod({
    name: "browser.navigate", owner: "L", ...API,
    params: z.object({ id: utf16(128, 1), url: utf16(8192, 1) }),
    result: z.object({ tab: TabView }),
    doc: "Loads a URL in a tab.",
  }),
  browserShow: defineMethod({
    name: "browser.show", owner: "L", ...API,
    params: z.object({ id: utf16(128, 1), view: utf16(128, 1), viewport: Viewport }),
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
    params: z.object({ id: utf16(128, 1), held: z.boolean() }), result: Ok,
    doc: "The user takes or gives back a tab in the view; an agent's commands on it are refused while held.",
  }),
  browserScreenshot: defineMethod({
    name: "browser.screenshot", owner: "L", ...API,
    params: z.object({ id: utf16(128, 1), format: z.enum(["png", "jpeg", "webp"]).optional(), quality: z.number().int().min(1).max(100).optional() }),
    result: Screenshot,
    doc: "A picture of a tab, taken without showing it.",
  }),
  browserCdp: defineMethod({
    name: "browser.cdp", owner: "L", ...API,
    params: z.object({
      id: utf16(128, 1),
      method: utf16(128, 3),
      params: z.record(z.string(), z.unknown()).optional(),
      /** The viewport a Point came from; refused if the tab's is different now (§12.1). */
      viewport: Viewport.optional(),
    }),
    result: z.object({ result: z.unknown() }),
    doc: "One DevTools call on a tab's own debugger, if its domain is allowed.",
  }),
  browserStream: defineMethod({
    /** Another device's view of a tab, as video. The core's wiring takes the viewer's device from the authenticated
     *  link the call came on, never from these params, and refuses the app role: the app shows its own tabs through
     *  the browser view. `codecs` says what the viewer decodes (iOS decodes H.264, never VP8; lane I's receivers):
     *  H.264 where the sending computer has a hardware encoder, VP8 otherwise, software H.264 only when the viewer
     *  names H.264 and not VP8, and whole JPEG pictures where no video encoder suits. The answer's `stream` is the
     *  link stream's `meta.stream` (the frame format: `packages/core/src/browser/stream.ts`). */
    name: "browser.stream", owner: "L", roles: ["remote", "peer"], capability: "browser",
    params: z.object({
      id: utf16(128, 1),
      on: z.boolean(),
      maxKbps: z.number().int().min(50).max(50_000).optional(),
      codecs: z.array(z.enum(["h264", "vp8", "jpeg"])).min(1).max(3).optional(),
    }),
    result: z.object({ stream: utf16(128).optional() }),
    doc: "Streams a tab to another device as video on a link stream of its own (S7 edit 3).",
  }),

  // The daemon drives the app's tabs (desktops). The app reports back with `browser.report`.
  appTabOpen: defineMethod({
    name: "app.tab.open", owner: "L", roles: ["app"], direction: "from-daemon",
    params: z.object({ id: utf16(128, 1), owner: TabOwner, url: utf16(8192).optional(), place: TabPlace }),
    result: z.object({ tab: TabView }),
    doc: "Opens a `WebContentsView` in the owner's partition.",
  }),
  appTabCommand: defineMethod({
    name: "app.tab.command", owner: "L", roles: ["app"], direction: "from-daemon",
    params: z.object({
      id: utf16(128, 1),
      command: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("close") }),
        z.object({ kind: z.literal("navigate"), url: utf16(8192, 1) }),
        z.object({ kind: z.literal("place"), place: TabPlace, view: utf16(128).optional(), viewport: Viewport.optional() }),
        z.object({ kind: z.literal("screenshot"), format: z.enum(["png", "jpeg", "webp"]), quality: z.number().int().min(1).max(100).optional() }),
        z.object({ kind: z.literal("cdp"), method: utf16(128, 3), params: z.record(z.string(), z.unknown()).optional() }),
        z.object({
          kind: z.literal("stream"), stream: utf16(128, 1), on: z.boolean(),
          maxKbps: z.number().int().min(50).max(50_000).optional(),
          codecs: z.array(z.enum(["h264", "vp8", "jpeg"])).min(1).max(3).optional(),
        }),
        z.object({ kind: z.literal("stream-control"), stream: utf16(128, 1), keyframe: z.boolean().optional(), kbps: z.number().int().positive().max(50_000).optional() }),
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
        z.object({ kind: z.literal("closed"), id: utf16(128, 1), by: z.enum(["user", "page", "crash"]) }),
        z.object({ kind: z.literal("cdp"), id: utf16(128, 1), method: utf16(128), params: z.unknown() }),
        z.object({ kind: z.literal("stalled"), id: utf16(128, 1), sinceMs: z.number().nonnegative() }),
      ])).max(1000),
    }),
    result: Ok,
    doc: "The app reports what happened to its tabs; DevTools events only for subscribed, allowlisted methods.",
  }),
  appBrowserConfigure: defineMethod({
    name: "app.browser.configure", owner: "L", roles: ["app"], direction: "from-daemon",
    params: BrowserNetworkConfig,
    result: Ok,
    doc: "The core's network settings for whoever runs the tabs: the proxy setting and the bots whose LAN is on. New connections take the proxy at once; a bot whose LAN changed has its partition re-pointed first.",
  }),
  browserStreamData: defineMethod({
    name: "browser.streamData", owner: "L", roles: ["app"],
    params: z.object({ stream: utf16(128, 1), chunk: StreamChunk }),
    result: Ok,
    doc: "One piece of a tab's stream, from the app to the daemon, tagged with the stream the core named in its `stream` command: a `config`, then frames, then `ended`.",
  }),
} as const;

export const TabChangedEvent = coreEvent("tab_changed", { tab: TabView });
export const TabClosedEvent = coreEvent("tab_closed", { id: utf16(128, 1), computer: ComputerName });
export const CdpEventEvent = coreEvent("cdp_event", { tab: utf16(128, 1), method: utf16(128), params: z.unknown() });

export const BROWSER_EVENTS = {
  tabChanged: defineEvent({
    type: "tab_changed", owner: "L", roles: ["app", "layer"], capability: "browser", schema: TabChangedEvent,
    fixture: { type: "tab_changed", ts: 1781270000000, tab: { id: "tab_1", computer: "Studio", owner: { kind: "bot", bot: "alpha" }, partition: "persist:bot-alpha", url: "https://example.com/", title: "Example Domain", place: "headless", viewport: { width: 1280, height: 800 }, loading: false, heldByUser: false } },
    doc: "A tab opened, loaded, moved or was taken by the user.",
  }),
  tabClosed: defineEvent({
    type: "tab_closed", owner: "L", roles: ["app", "layer"], capability: "browser", schema: TabClosedEvent,
    fixture: { type: "tab_closed", ts: 1781270000000, id: "tab_1", computer: "Studio" },
    doc: "A tab closed, by its owner, the page or a crash.",
  }),
  cdpEvent: defineEvent({
    type: "cdp_event", owner: "L", roles: ["layer"], capability: "browser", schema: CdpEventEvent, transient: true,
    fixture: { type: "cdp_event", ts: 1781270000000, tab: "tab_1", method: "Page.loadEventFired", params: { timestamp: 1234.5 } },
    doc: "An allowlisted DevTools event from a tab the plugin follows.",
  }),
} as const;
