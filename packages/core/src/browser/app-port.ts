// The app's side of the browser, as the daemon reaches it: this computer's app connection, asked with `app.tab.open`,
// `app.tab.command` and `app.tab.list` (the daemon→app requests the Clover server's `ask` carries; the app answers from
// its browser host, `apps/desktop/src/main/browser`). The app is the one whose hello lists `APP_BROWSER_FEATURE`; with
// none connected the port is absent, and the service answers that the app isn't running (it starts again by itself).
// The app reports back with `browser.report` and `browser.hold` (`browserAppHandlers`, from the app role only).
import { BROWSER_METHODS, CLOVER_ERR, ERR } from "@waifucave/clover-protocol";
import type { BrowserNetworkConfig } from "./contract";
import { CloverRpcError, type CloverConn, type CloverHandler } from "../ipc/clover";
import type { AppTabPort, BrowserService } from "./service";

/** The feature an app lists in its hello when it serves `app.tab.*`. */
export const APP_BROWSER_FEATURE = "browser";
/** How long the app has to answer one tab request (a page's first load and a picture are the slow ones). */
export const APP_TAB_TIMEOUT_MS = 30_000;

export interface AppTabDeps {
  connections(): readonly CloverConn[];
  ask(conn: CloverConn, method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

/** The port to this computer's app while one that serves tabs is connected; undefined otherwise. */
export function appTabPort(deps: AppTabDeps): () => AppTabPort | undefined {
  return () => {
    const app = deps.connections().find((c) => c.role === "app" && c.features.includes(APP_BROWSER_FEATURE));
    if (app === undefined) return undefined;
    const ask = (method: string, params: unknown) => deps.ask(app, method, params, APP_TAB_TIMEOUT_MS);
    return {
      async open(args) {
        const out = BROWSER_METHODS.appTabOpen.result.parse(await ask("app.tab.open", args));
        return out.tab;
      },
      async command(id, command) {
        return BROWSER_METHODS.appTabCommand.result.parse(await ask("app.tab.command", { id, command })).result;
      },
      async list() {
        return BROWSER_METHODS.appTabList.result.parse(await ask("app.tab.list", {})).tabs;
      },
      // The app's own defaults hold until `app.browser.configure` is a method of the protocol: the strictest policy for
      // a bot's tabs (no LAN) and the default proxy setting.
      async configure(_config: BrowserNetworkConfig) {},
    };
  };
}

/** `browser.report` and `browser.hold`: only the app's own connection (the server's role list has checked it, and the
 *  handlers check again). */
export function browserAppHandlers(getService: () => BrowserService | undefined): Record<"browser.report" | "browser.hold", CloverHandler> {
  const service = (conn: CloverConn): BrowserService => {
    if (conn.role !== "app") throw new CloverRpcError(CLOVER_ERR.NOT_THE_USER, "only the app reports its browser");
    const s = getService();
    if (s === undefined) throw new CloverRpcError(ERR.RETRY, "the browser isn't up yet");
    return s;
  };
  return {
    "browser.report": async (conn, raw) => {
      const p = BROWSER_METHODS.browserReport.params.safeParse(raw);
      if (!p.success) throw new CloverRpcError(ERR.INVALID_PARAMS, "browser.report takes events");
      service(conn).report(p.data.events as Parameters<BrowserService["report"]>[0]);
      return { ok: true };
    },
    "browser.hold": async (conn, raw) => {
      const p = BROWSER_METHODS.browserHold.params.safeParse(raw);
      if (!p.success) throw new CloverRpcError(ERR.INVALID_PARAMS, "browser.hold takes a tab id and held");
      service(conn).hold(p.data.id, p.data.held);
      return { ok: true };
    },
  };
}
