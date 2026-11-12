// `app.capture` (the owner's ask for 14d: "a way for you to remotely screenshot the running app window"): the user's
// own CLI asks the daemon, and the daemon asks this computer's app (`app.window.capture`), whose main process takes
// Electron's own picture of the window's page (`webContents.capturePage`), never the screen: no Screen Recording
// permission, no privacy prompt, and no window shown, raised, focused or resized. The protocol lets only a `cli`
// connection that counts as the user call it (`userOnly`); a bot's or agent's session, a plugin, a layer, a remote
// device and another computer's `peer.call` are refused before this runs. The handler checks it once more. No card,
// no setting.
import { AppCaptureParams, AppCaptureResult, CLOVER_ERR, ERR } from "@waifucave/clover-protocol";
import { CloverRpcError, type CloverConn, type CloverHandler } from "./clover";

/** The feature an app lists in its hello when it answers `app.window.capture`. */
export const APP_CAPTURE_FEATURE = "app.capture";
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

export function appCaptureHandler(deps: AppCaptureDeps): CloverHandler {
  return async (conn, raw) => {
    if (!mayCapture(conn)) throw new CloverRpcError(CLOVER_ERR.NOT_THE_USER, "app.capture is the user's own, from this computer's CLI");
    const parsed = AppCaptureParams.safeParse(raw);
    if (!parsed.success) throw new CloverRpcError(ERR.INVALID_PARAMS, "app.capture takes a window (main, a surface's name, or all), and image and frames as true or false");
    const apps = deps.connections().filter((c) => c.role === "app");
    const app = apps.find((c) => c.features.includes(APP_CAPTURE_FEATURE));
    if (app === undefined) {
      throw new CloverRpcError(ERR.NOT_FOUND, apps.length > 0 ? "the app on this computer is older than app.capture: update it" : "the app isn't running on this computer");
    }
    const answer = await deps.ask(app, "app.window.capture", parsed.data, APP_CAPTURE_TIMEOUT_MS);
    const result = AppCaptureResult.safeParse(answer);
    if (!result.success) throw new CloverRpcError(ERR.INTERNAL, "the app's answer to app.window.capture isn't one");
    return result.data;
  };
}
