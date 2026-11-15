// The plugin API's `browser.*` for the bundled `clover` tree's Browser tool (spec §12.1, ruling R7): the session whose
// tool call the tool is serving drives the Clover Browser, under the browser's own rules. The router has already checked
// that the call came from the `clover` host process and that the plugin holds `browser` (API_CALLS); this door adds:
//
// * a caller. Only the session the core bound to the tool call (`caller.kind === "session"`) gets anything: a plugin
//   acting as itself, the core, a peer or the user get a refusal here, never a guess.
// * that caller's own tabs. A bot's session drives its bot's tab, a session with no bot its own; the owner is the
//   caller's, never a parameter's. The person's own browser is never reached from here, at any level, and no card is
//   raised for it.
// * one tab per bot: `open` with a tab already open is refused with the tab's id, so the tool navigates it.
// * DevTools only through the tool's own short list (`TOOL_CDP_METHODS`): the nine methods the tool calls, nothing
//   wider, whatever the core's wider allow list passes for the browser view.
// * nothing of a network filter's is loosened: a bot's tab still reaches no loopback or private address (network.ts).
import type { Caller } from "@waifucave/clover-protocol";
import type { ApiCallContext, ApiHandlers } from "../plugin-host/api/router";
import { ContractError } from "../contracts/common";
import type { TabOwner, TabView, Screenshot } from "./contract";
import { BrowserError } from "./policy";
import { takeCheckedHost } from "./checked-hosts";
import { browserCallerOf, type BrowserCaller, type BrowserService, type ProtocolCaller } from "./service";

/** The DevTools methods the Browser tool calls, and so the only ones a session's call may pass. */
export const TOOL_CDP_METHODS: readonly string[] = [
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Page.createIsolatedWorld",
  "Page.getFrameTree",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.reload",
  "Runtime.evaluate",
];

/** What the tool is told of its caller: the session, its kind and its bot, nothing the core keeps to itself. */
export interface ToolCaller {
  kind: "session";
  sessionId: string;
  sessionKind: string;
  bot?: string;
  /** The site the approval check judged this call's tab to be on: the tool acts only while the page is still on it. */
  checkedHost?: string;
}

type SessionCaller = Extract<Caller, { kind: "session" }>;

/** The bundled tool's plugin (session callers, in the `clover` host process) and the bundled panel's (the person, in the
 *  panel's own component): the only two plugins `browser.*` is served to. */
export const TOOL_PLUGIN = "clover/browser";
/** The DevTools events a component hears of a tab: the page's own domain. */
export const PANEL_CDP_EVENT_DOMAIN = "Page.";
export const PANEL_PLUGIN = "clover/browser-view";

/** Who a call acts for. The tool acts for the session whose tool call it serves, on that session's own tabs. The panel
 *  acts for the person, who sees any owner's tabs here and chooses which owner a tab opens for. */
interface Actor {
  caller: BrowserCaller;
  /** The tool's: the owner every tab is held to. Absent for the person's panel. */
  own?: TabOwner;
  session?: SessionCaller;
}

function actorOf(ctx: ApiCallContext): Actor {
  const bundled = ctx.record?.source === "bundled";
  if (ctx.process === "ui") {
    // A component's call reaches the router from `plugin.layer.api`/`plugin.layer.call` as its plugin
    // (`caller: { kind: "plugin", pluginId }`: a component never acts as the user on its own word). The bundled panel is
    // the one component that drives the browser for the person, so its call, from its own mount, acts as the person to
    // the service; any other component, bundled or not, has no tabs here.
    if (ctx.pluginId !== PANEL_PLUGIN || !bundled) throw new ContractError("refused", `${ctx.path} is served to the Clover Browser panel only`);
    if (ctx.caller.kind !== "plugin" || ctx.caller.pluginId !== ctx.pluginId) throw new ContractError("refused", `${ctx.path} from the panel is the panel's own call; a call made as ${ctx.caller.kind} has no tabs here`);
    return { caller: { kind: "user" } };
  }
  if (ctx.pluginId !== TOOL_PLUGIN || !bundled) throw new ContractError("refused", `${ctx.path} is served to the Clover Browser tool only`);
  const c = sessionOf(ctx);
  return { caller: browserCallerOf(c as ProtocolCaller), own: ownerOfSession(c), session: c };
}

/** The session a call acts for, or the refusal the tool reads: no call without one. */
function sessionOf(ctx: ApiCallContext): SessionCaller {
  const c = ctx.caller;
  if (c.kind !== "session") {
    throw new ContractError("refused", `${ctx.path} works for the session whose tool call the plugin is serving; a call made as ${c.kind === "plugin" ? "the plugin itself" : c.kind === "core" ? "the core" : `a ${c.kind}`} has no tabs here`);
  }
  return c;
}

/** The tab owner a session's own tabs are kept under: its bot's, or its own for a session with no bot. */
export function ownerOfSession(c: SessionCaller): TabOwner {
  return c.bot !== undefined ? { kind: "bot", bot: c.bot } : { kind: "session", session: c.sessionId };
}

function failNotRunning(): never {
  throw new ContractError("refused", "the Clover Browser isn't running on this computer");
}

function failure(e: unknown): never {
  if (e instanceof BrowserError) throw new ContractError("refused", e.message, { code: e.code });
  throw e;
}

async function run<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (e) {
    return failure(e);
  }
}

const str = (v: unknown, what: string, max = 8192): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new ContractError("invalid", `${what} is a string of 1 to ${max} characters`);
  return v;
};

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const listener = <T>(v: unknown): ((value: T) => void) => {
  if (typeof v !== "function") throw new ContractError("invalid", "a watch takes a listener");
  return v as (value: T) => void;
};

/** An owner the panel names, as the protocol writes one. */
function ownerArg(v: unknown): TabOwner {
  const o = obj(v);
  if (o.kind === "bot" && typeof o.bot === "string") return { kind: "bot", bot: str(o.bot, "the bot", 128) };
  if (o.kind === "session" && typeof o.session === "string") return { kind: "session", session: str(o.session, "the session", 128) };
  if (o.kind === "user") return { kind: "user" };
  throw new ContractError("invalid", "an owner is { kind: \"bot\", bot }, { kind: \"session\", session } or { kind: \"user\" }");
}

/** The handlers for the calls the Browser tool uses and `browser.toolCaller` (which tells the tool whose tool call it is
 *  serving: the tool refuses every call it can't tell), and `show` and `hide`, which the person's panel's own call
 *  reaches (`plugin.layer.api`'s route; the panel's component calls the core's `browser.*` methods, `rpc-handlers.ts`,
 *  on its layer connection, and hears the tabs change as core events). */
export function browserApiHandlers(getService: () => BrowserService | undefined): ApiHandlers {
  // Read at each call: the browser comes up with the daemon's parts, after the plugin host.
  const svc = (): BrowserService => getService() ?? failNotRunning();
  const panelOnly = (ctx: ApiCallContext): Actor => {
    const a = actorOf(ctx);
    if (a.own !== undefined) throw new ContractError("refused", "where a tab shows is the person's: the Browser tool draws its tab out of sight");
    return a;
  };
  return {
    "browser.toolCaller": (ctx) => {
      const c = sessionOf(ctx);
      if (ctx.pluginId !== TOOL_PLUGIN || ctx.process === "ui" || ctx.record?.source !== "bundled") throw new ContractError("refused", "browser.toolCaller is served to the Clover Browser tool only");
      const checkedHost = takeCheckedHost(c.sessionId);
      const out: ToolCaller = { kind: "session", sessionId: c.sessionId, sessionKind: c.sessionKind, ...(c.bot !== undefined ? { bot: c.bot } : {}), ...(checkedHost !== undefined ? { checkedHost } : {}) };
      return out;
    },
    "browser.tabs": async (ctx, args) => {
      const a = actorOf(ctx);
      const filter = obj(args[0]);
      if (a.own !== undefined) {
        if (filter.owner !== undefined) assertOwn(a.session!, filter.owner);
        if (typeof filter.computer === "string" && filter.computer !== svc().computerName) throw new ContractError("refused", "the Browser tool works on this computer's tabs only", { code: "not_yours" });
        return run(() => svc().list(a.caller, { owner: a.own! }));
      }
      const computer = typeof filter.computer === "string" ? filter.computer : undefined;
      return run(() => svc().list(a.caller, { ...(filter.owner !== undefined ? { owner: ownerArg(filter.owner) } : {}), ...(computer !== undefined ? { computer } : {}) }));
    },
    "browser.open": async (ctx, args) => {
      const a = actorOf(ctx);
      const o = obj(args[0]);
      const url = o.url === undefined ? undefined : str(o.url, "url");
      if (a.own === undefined) {
        // The person's panel opens a tab for the owner it shows (a bot's, a session's or the person's), in a view at once or out of sight.
        const show = o.show === undefined ? undefined : (() => { const sh = obj(o.show); return { view: str(sh.view, "the view", 64), viewport: sh.viewport as { width: number; height: number } }; })();
        const computer = typeof o.computer === "string" ? o.computer : undefined;
        const tab: TabView = await run(() => svc().open(a.caller, { owner: ownerArg(o.owner), ...(url !== undefined ? { url } : {}), ...(computer !== undefined ? { computer } : {}), ...(show !== undefined ? { show } : {}) } as Parameters<BrowserService["open"]>[1]));
        return tab;
      }
      if (o.owner !== undefined) assertOwn(a.session!, o.owner);
      // A tab on another computer (no peers are served), or shown at once in a view, is not the tool's to ask for; this
      // computer, named as the tool names it, is the one place it opens.
      if ((o.computer !== undefined && o.computer !== svc().computerName) || o.show !== undefined) throw new ContractError("refused", "the Browser tool opens a tab on this computer, drawn out of sight");
      const mine = await run(() => svc().list(a.caller, { owner: a.own! }));
      if (mine.length > 0) throw new ContractError("refused", `${a.session!.bot !== undefined ? `${a.session!.bot} has` : "this session has"} a tab open already (${mine[0]!.id}): navigate it instead of opening another`, { code: "one_tab" });
      const tab: TabView = await run(() => svc().open(a.caller, { owner: a.own!, ...(url !== undefined ? { url } : {}) }));
      return tab;
    },
    "browser.close": async (ctx, args) => {
      const a = actorOf(ctx);
      await run(() => svc().close(a.caller, str(args[0], "the tab id", 128)));
    },
    "browser.navigate": async (ctx, args) => {
      const a = actorOf(ctx);
      return run(() => svc().navigate(a.caller, str(args[0], "the tab id", 128), str(args[1], "url")));
    },
    "browser.screenshot": async (ctx, args) => {
      const a = actorOf(ctx);
      const o = obj(args[1]);
      const format = o.format === "png" || o.format === "jpeg" || o.format === "webp" ? o.format : undefined;
      const quality = typeof o.quality === "number" ? o.quality : undefined;
      const shot: Screenshot = await run(() => svc().screenshot(a.caller, str(args[0], "the tab id", 128), { ...(format !== undefined ? { format } : {}), ...(quality !== undefined ? { quality } : {}) }));
      return shot;
    },
    "browser.cdp": async (ctx, args) => {
      const a = actorOf(ctx);
      const method = str(args[1], "the DevTools method", 128);
      if (!TOOL_CDP_METHODS.includes(method)) throw new ContractError("refused", `${method} isn't one the Browser uses; it passes only: ${TOOL_CDP_METHODS.join(", ")}`, { code: "method_refused" });
      const params = args[2] === undefined ? undefined : obj(args[2]);
      const opts = obj(args[3]);
      const viewport = opts.viewport as { width: number; height: number } | undefined;
      return run(() => svc().cdp(a.caller, str(args[0], "the tab id", 128), method, params, viewport !== undefined ? { viewport } : {}));
    },
    "browser.show": async (ctx, args) => {
      const a = panelOnly(ctx);
      const vp = obj(args[2]);
      return run(() => svc().show(a.caller, str(args[0], "the tab id", 128), str(args[1], "the view", 64), { width: vp.width as number, height: vp.height as number }));
    },
    "browser.hide": async (ctx, args) => {
      const a = panelOnly(ctx);
      return run(() => svc().hide(a.caller, str(args[0], "the tab id", 128)));
    },
    // The person's panel hears a tab's DevTools events, the page's own (`Page.*`: a load, a navigation, a dialog opening,
    // a file chooser). Only the panel (`panelOnly`, then the service's own tab lookup for the person); a listener is a
    // component's watch (`plugin.layer.watch`), each event one `{ method, params }`, ended with the watch or the tab. The
    // other domains the app forwards (a page's network and console traffic) are not streamed to a component.
    "browser.onCdpEvent": async (ctx, args) => {
      const a = panelOnly(ctx);
      const fn = listener<{ method: string; params: unknown }>(args[1]);
      return run(() => svc().watchCdp(a.caller, str(args[0], "the tab id", 128), (method, params) => {
        if (method.startsWith(PANEL_CDP_EVENT_DOMAIN)) fn({ method, params });
      }));
    },
  };
}

/** A tab owner a call names must be the caller's own (the tool says it; the core doesn't take its word for another). */
function assertOwn(c: SessionCaller, named: unknown): void {
  const own = ownerOfSession(c);
  const n = obj(named);
  const same = n.kind === own.kind && (own.kind === "bot" ? n.bot === own.bot : own.kind === "session" ? n.session === own.session : false);
  if (!same) throw new ContractError("refused", "the Browser tool drives the calling session's own tabs only; the person's own browser and anyone else's are not reachable from it", { code: "not_yours" });
}
