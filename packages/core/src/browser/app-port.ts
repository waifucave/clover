// The app's side of the browser, as the daemon reaches it: this computer's app connection, asked with `app.tab.open`,
// `app.tab.command` and `app.tab.list` (the daemon→app requests the MOSS server's `ask` carries; the app answers from
// its browser host, `apps/desktop/src/main/browser`). The connection is the pages' owner (`host/tab-frames.ts`'s
// `pagesOwner`, the one switch): the background host when one is connected with the browser (spec revision 19, item
// 111), else today's app (MOSS Code's window); never MOSS's window. With none connected the port is absent, and the
// service answers that the app isn't running (it starts again by itself).
// The app reports back with `browser.report` and `browser.hold` (`browserAppHandlers`, from the app role only).
import { BROWSER_METHODS, MOSS_ERR, ERR } from "@waifucave/moss-protocol";
import type { BrowserNetworkConfig } from "./contract";
import { MossRpcError, type MossConn, type MossHandler } from "../ipc/moss";
import type { AppTabPort, BrowserService } from "./service";
import { pagesOwner } from "../host/tab-frames";
import { BrowserError } from "./policy";

/** The feature an app lists in its hello when it serves `app.tab.*`. */
export const APP_BROWSER_FEATURE = "browser";
/** How long the app has to answer one tab request (a page's first load and a picture are the slow ones). */
export const APP_TAB_TIMEOUT_MS = 30_000;

export interface AppTabDeps {
  connections(): readonly MossConn[];
  /** Whether a background host owns the screen (`pagesOwner`'s rule: the window then runs no pages). */
  hostOwnsScreen?(): boolean;
  ask(conn: MossConn, method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

/** The port to this computer's app while one that serves tabs is connected; undefined otherwise. */
export function appTabPort(deps: AppTabDeps): () => AppTabPort | undefined {
  return () => {
    const held = deps.hostOwnsScreen?.() ?? false;
    const app = pagesOwner(deps.connections(), { hostOwnsScreen: held });
    if (app === undefined) return held ? hostDownPort() : undefined;
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

/** While the background host owns the screen and isn't connected (starting, restarting): every call says so. */
function hostDownPort(): AppTabPort {
  const down = (): never => { throw new BrowserError("no_app", "the background host that runs the browser's pages isn't running; it starts again by itself"); };
  return { open: async () => down(), command: async () => down(), list: async () => down(), configure: async () => {} };
}

/** `browser.report` and `browser.hold`: only the pages' owner's connection (the server's role list has checked the app
 *  role; lane HS: and it must be the connection that runs the pages, `pagesOwner`). */
export function browserAppHandlers(getService: () => BrowserService | undefined, owner: (conn: MossConn) => boolean = () => true): Record<"browser.report" | "browser.hold", MossHandler> {
  const service = (conn: MossConn): BrowserService => {
    if (conn.role !== "app" || !owner(conn)) throw new MossRpcError(MOSS_ERR.NOT_THE_USER, "only the program that runs the browser's pages reports them");
    const s = getService();
    if (s === undefined) throw new MossRpcError(ERR.RETRY, "the browser isn't up yet");
    return s;
  };
  return {
    "browser.report": async (conn, raw) => {
      const p = BROWSER_METHODS.browserReport.params.safeParse(raw);
      if (!p.success) throw new MossRpcError(ERR.INVALID_PARAMS, "browser.report takes events");
      service(conn).report(p.data.events as Parameters<BrowserService["report"]>[0]);
      return { ok: true };
    },
    "browser.hold": async (conn, raw) => {
      const p = BROWSER_METHODS.browserHold.params.safeParse(raw);
      if (!p.success) throw new MossRpcError(ERR.INVALID_PARAMS, "browser.hold takes a tab id and held");
      service(conn).hold(p.data.id, p.data.held);
      return { ok: true };
    },
  };
}
