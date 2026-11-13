// The slice of lane B's contract this plugin uses, mirrored until `lane/b-m0` merges; then this file becomes a
// re-export of `@waifucave/clover-protocol` and `@waifucave/clover-plugin-sdk`, and the copies go. Nothing here is
// renamed, and only the fields the tool reads are kept where a type is large. The plugin API itself is the SDK's
// (`HostPluginApi`): this file never declares a member of it.
//
// Where each piece comes from (on `lane/b-m0`):
//   packages/protocol/src/browser.ts          TabOwner, TabPlace, Viewport, AGENT_VIEWPORT, TabView, Screenshot,
//                                             the DevTools allow list and the URL rule
//   packages/protocol/src/common.ts           Caller, SessionKind, ClientKind
//   packages/plugin-sdk/src/api/plugin-api.ts BrowserApi, McpServerTransport, HostModule's `mcp`, PluginSelf

import type { BrowserApi as SdkBrowserApi, HostPluginApi, McpServerTransport } from "@waifucave/clover-plugin-sdk";

// ---- packages/protocol/src/browser.ts ----------------------------------------------------------------------------

/** A bot's tabs live in its own partition, the user's in another; never per site (§12.1). A session without a bot has
 *  a partition of its own (ruling R10); `session` is proposed to lane B, as in the core's mirror. */
export type TabOwner = { kind: "bot"; bot: string } | { kind: "session"; session: string } | { kind: "plugin"; plugin: string } | { kind: "user" };

/** `headless` drawing offscreen at the agent's 1280×800, `shown` in a browser view at the view's size, `resting` not
 *  drawing until a bot's next command. */
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
  /** The user holds it in the view; an agent's commands are refused meanwhile (the inherited control lease). */
  heldByUser: boolean;
}

export type ScreenshotFormat = "png" | "jpeg" | "webp";

export interface Screenshot {
  format: ScreenshotFormat;
  /** base64. */
  data: string;
  /** The picture's own size, in pixels. */
  width: number;
  height: number;
  takenAt: number;
  contentAgeMs?: number;
}

/** DevTools domains the API never passes. */
export const CDP_DENIED_DOMAINS = ["Target", "Browser", "Storage", "SystemInfo", "Tethering", "ServiceWorker"] as const;
/** DevTools domains the API passes. Every call this tool makes stays inside them (a test holds it to that). */
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
/** The app's and core's own schemes all start with `clover`. */
export const CLOVER_SCHEME_PREFIX = "clover";

/** Whether a browser partition may load a URL (the core's rule; the tool's own is narrower, see `floor.ts`). */
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

// ---- packages/protocol/src/common.ts -----------------------------------------------------------------------------

export type SessionKind = "bot" | "side-thread" | "agent" | "coding";
export type ClientKind = "app" | "cli" | "ios" | "web";

/** Who called (§5.4 "The caller"). */
export type Caller =
  | { kind: "user"; client: ClientKind; device?: string }
  | { kind: "session"; sessionId: string; sessionKind: SessionKind; bot?: string }
  | { kind: "plugin"; pluginId: string }
  | { kind: "core" }
  | { kind: "peer"; device: string; sessionId?: string; bot?: string };

// ---- packages/plugin-sdk/src/api/plugin-api.ts (the SDK's own types, not a copy) ---------------------------------

export type Unsubscribe = () => void;

export type { McpServerTransport, PluginSelf } from "@waifucave/clover-plugin-sdk";

/** `browser`: the Clover Browser's API (§12.1), less what the core doesn't serve a host half (`show`, `hide`,
 *  `onCdpEvent`, `watch`), from the SDK's own `BrowserApi`. */
export type BrowserApi = Omit<SdkBrowserApi, "show" | "hide" | "onCdpEvent" | "watch">;

/** The members of the plugin API this plugin reads. `browser` is there only with the `browser` capability. */
export type PluginApi = Partial<Pick<HostPluginApi, "plugin">> & { readonly browser?: BrowserApi };

/** A `HostModule`'s `mcp` entry: serves one `host` MCP server on the transport the SDK provides. */
export type McpServerFactory = (transport: McpServerTransport, api: PluginApi) => void | Promise<void>;
