// The Clover server's `browser.*` methods (`BROWSER_METHODS`), for the bundled browser panel: its component is a plugin's
// layer, which calls the core on its plugin's own connection (role `layer`, `caller: { kind: "plugin", pluginId }`), and
// the capability gate has already checked that the plugin holds `browser`. This door adds the rest:
//
// * who may reach it: the app's own connection (the person), and the one layer that is the bundled panel
//   (`clover/browser-view`, source bundled), acting for the person. Any other plugin's layer, bundled or not, has no tabs
//   here, and none gets a tab of its own by naming an owner.
// * what a call can do: the nine DevTools methods the browser passes (`TOOL_CDP_METHODS`), whatever the protocol lets
//   through; the tool's own door (`api-handlers.ts`) keeps a bot to its own tab.
// * what the panel hears: the tab changes arrive as core events (`daemon.ts` sends `tab_changed` and `tab_closed` to the
//   app and to this one layer, never to another plugin).
import { BROWSER_METHODS, CLOVER_ERR, ERR } from "@waifucave/clover-protocol";
import { CloverRpcError, type CloverConn, type CloverHandler } from "../ipc/clover";
import { BrowserError } from "./policy";
import type { BrowserCaller, BrowserService } from "./service";
import { PANEL_PLUGIN, TOOL_CDP_METHODS } from "./api-handlers";

/** Whom a connection's calls act for: the person's app, or the bundled panel's layer. */
export function panelCaller(conn: Pick<CloverConn, "role" | "caller">, bundled: (pluginId: string) => boolean): BrowserCaller {
  if (conn.role === "app" && conn.caller.kind === "user") return { kind: "user" };
  if (conn.role === "layer" && conn.caller.kind === "plugin" && conn.caller.pluginId === PANEL_PLUGIN && bundled(PANEL_PLUGIN)) return { kind: "user" };
  throw new CloverRpcError(CLOVER_ERR.ROLE_REFUSED, "the Clover Browser's tabs are the person's: only the app and the bundled browser panel reach them");
}

/** The connections a tab change goes to: the app, and the one layer that is the bundled panel. No other plugin hears a tab. */
export const hearsTabs = (conn: Pick<CloverConn, "role" | "caller">): boolean =>
  conn.role === "app" || (conn.role === "layer" && conn.caller.kind === "plugin" && conn.caller.pluginId === PANEL_PLUGIN);

const M = BROWSER_METHODS;

export function browserRpcHandlers(getService: () => BrowserService | undefined, bundled: (pluginId: string) => boolean): Record<string, CloverHandler> {
  const svc = (): BrowserService => {
    const s = getService();
    if (s === undefined) throw new CloverRpcError(ERR.RETRY, "the browser isn't up yet");
    return s;
  };
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (e) {
      if (e instanceof BrowserError) throw new CloverRpcError(ERR.INVALID_PARAMS, e.message, { code: e.code });
      throw e;
    }
  };
  const parse = <S extends { parse(v: unknown): unknown }>(schema: S, raw: unknown): ReturnType<S["parse"]> => {
    try {
      return schema.parse(raw) as ReturnType<S["parse"]>;
    } catch {
      throw new CloverRpcError(ERR.INVALID_PARAMS, "the browser call's parameters aren't what it takes");
    }
  };
  return {
    [M.browserTabs.name]: (conn, raw) => {
      const caller = panelCaller(conn, bundled);
      const p = parse(M.browserTabs.params, raw) as { owner?: Parameters<BrowserService["list"]>[1] extends infer F ? (F extends { owner?: infer O } ? O : never) : never; computer?: string };
      return guard(async () => ({ tabs: await svc().list(caller, { ...(p.owner !== undefined ? { owner: p.owner } : {}), ...(p.computer !== undefined ? { computer: p.computer } : {}) }) }));
    },
    [M.browserOpen.name]: (conn, raw) => {
      const caller = panelCaller(conn, bundled);
      const p = parse(M.browserOpen.params, raw) as Parameters<BrowserService["open"]>[1];
      return guard(async () => ({ tab: await svc().open(caller, p) }));
    },
    [M.browserClose.name]: (conn, raw) => {
      const caller = panelCaller(conn, bundled);
      const p = parse(M.browserClose.params, raw) as { id: string };
      return guard(async () => { await svc().close(caller, p.id); return { ok: true }; });
    },
    [M.browserNavigate.name]: (conn, raw) => {
      const caller = panelCaller(conn, bundled);
      const p = parse(M.browserNavigate.params, raw) as { id: string; url: string };
      return guard(async () => ({ tab: await svc().navigate(caller, p.id, p.url) }));
    },
    [M.browserShow.name]: (conn, raw) => {
      const caller = panelCaller(conn, bundled);
      const p = parse(M.browserShow.params, raw) as { id: string; view: string; viewport: { width: number; height: number } };
      return guard(async () => ({ tab: await svc().show(caller, p.id, p.view, p.viewport) }));
    },
    [M.browserHide.name]: (conn, raw) => {
      const caller = panelCaller(conn, bundled);
      const p = parse(M.browserHide.params, raw) as { id: string };
      return guard(async () => ({ tab: await svc().hide(caller, p.id) }));
    },
    [M.browserScreenshot.name]: (conn, raw) => {
      const caller = panelCaller(conn, bundled);
      const p = parse(M.browserScreenshot.params, raw) as { id: string; format?: "png" | "jpeg" | "webp"; quality?: number };
      return guard(() => svc().screenshot(caller, p.id, { ...(p.format !== undefined ? { format: p.format } : {}), ...(p.quality !== undefined ? { quality: p.quality } : {}) }));
    },
    [M.browserCdp.name]: (conn, raw) => {
      const caller = panelCaller(conn, bundled);
      const p = parse(M.browserCdp.params, raw) as { id: string; method: string; params?: Record<string, unknown>; viewport?: { width: number; height: number } };
      if (!TOOL_CDP_METHODS.includes(p.method)) throw new CloverRpcError(ERR.INVALID_PARAMS, `${p.method} isn't one the Browser uses`, { code: "method_refused" });
      return guard(async () => ({ result: await svc().cdp(caller, p.id, p.method, p.params, p.viewport !== undefined ? { viewport: p.viewport } : {}) }));
    },
  };
}
