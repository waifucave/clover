// `app.capture` (the owner's ask for 14d: "a way for you to remotely screenshot the running app window"): the user's
// own CLI asks the daemon, and the daemon asks this computer's app (`app.window.capture`), whose main process takes
// Electron's own picture of the window's page (`webContents.capturePage`), never the screen: no Screen Recording
// permission, no privacy prompt, and no window shown, raised, focused or resized. The protocol lets only a `cli`
// connection that counts as the user call it (`userOnly`); a bot's or agent's session, a plugin, a layer, a remote
// device and another computer's `peer.call` are refused before this runs. The handler checks it once more. No card,
// no setting.
import { AppCaptureParams, AppCaptureResult, AppOpenParams, AppOpenResult, AppWhereParams, CLOVER_ERR, ERR } from "@waifucave/clover-protocol";
import type { z } from "zod";
import { CloverRpcError, type CloverConn, type CloverHandler } from "./clover";

/** The feature an app lists in its hello when it answers `app.window.capture`. */
export const APP_CAPTURE_FEATURE = "app.capture";
/** The feature an app lists when it answers `app.window.open` (`app.open`, `app.where`). */
export const APP_OPEN_FEATURE = "app.open";
/** How long the app has to answer one window's picture. */
export const APP_CAPTURE_TIMEOUT_MS = 20_000;

export interface AppCaptureDeps {
  /** This daemon's connections (the server's `connections()`). */
  connections(): readonly CloverConn[];
  /** The server's `ask`: a request to the app and its answer. */
  ask(conn: CloverConn, method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

/** Only the user's own CLI on this computer: a `cli` connection whose caller is the user. */
export function mayCapture(conn: Pick<CloverConn, "role" | "caller">): boolean {
  return conn.role === "cli" && conn.caller.kind === "user";
}

/** A door of the user's CLI to this computer's app: the caller checked, the params parsed, the app that serves
 *  `feature` asked `fromDaemon`, and its answer held to `result`. */
function appDoor(deps: AppCaptureDeps, door: { method: string; feature: string; fromDaemon: string; usage: string; params: z.ZodType; result: z.ZodType; toApp?: (p: Record<string, unknown>) => unknown }): CloverHandler {
  return async (conn, raw) => {
    if (!mayCapture(conn)) throw new CloverRpcError(CLOVER_ERR.NOT_THE_USER, `${door.method} is the user's own, from this computer's CLI`);
    const parsed = door.params.safeParse(raw);
    if (!parsed.success) throw new CloverRpcError(ERR.INVALID_PARAMS, door.usage);
    const apps = deps.connections().filter((c) => c.role === "app");
    const app = apps.find((c) => c.features.includes(door.feature));
    if (app === undefined) {
      throw new CloverRpcError(ERR.NOT_FOUND, apps.length > 0 ? `the app on this computer is older than ${door.method}: update it` : "the app isn't running on this computer");
    }
    const data = parsed.data as Record<string, unknown>;
    const answer = await deps.ask(app, door.fromDaemon, door.toApp ? door.toApp(data) : data, APP_CAPTURE_TIMEOUT_MS);
    const result = door.result.safeParse(answer);
    if (!result.success) throw new CloverRpcError(ERR.INTERNAL, `the app's answer to ${door.fromDaemon} isn't one`);
    return result.data;
  };
}

export function appCaptureHandler(deps: AppCaptureDeps): CloverHandler {
  return appDoor(deps, { method: "app.capture", feature: APP_CAPTURE_FEATURE, fromDaemon: "app.window.capture", usage: "app.capture takes a window (main, a surface's name, or all), and image and frames as true or false", params: AppCaptureParams, result: AppCaptureResult });
}

/** `app.open` (a target) and `app.where` (none): the app's own navigation of its main window, by the route its sidebar
 *  uses, and where it is. */
export function appOpenHandlers(deps: AppCaptureDeps): Record<"app.open" | "app.where", CloverHandler> {
  const usage = "app.open takes a target: bot:<id>, app:<key> or a page's key, settings[:<section>], plugins, archive or code";
  return {
    "app.open": appDoor(deps, { method: "app.open", feature: APP_OPEN_FEATURE, fromDaemon: "app.window.open", usage, params: AppOpenParams, result: AppOpenResult }),
    "app.where": appDoor(deps, { method: "app.where", feature: APP_OPEN_FEATURE, fromDaemon: "app.window.open", usage: "app.where takes frames as true or false", params: AppWhereParams, result: AppOpenResult }),
  };
}
