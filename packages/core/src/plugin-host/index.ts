// The plugin host's core side (lane B, B-M2; spec §5.2, §5.4): the plugin API's router and its areas, the caller
// binding and the pipe's API channel. The processes themselves (the two plugin-host processes on clover-plugin-bun,
// their workers, crashes, heartbeat and logs) come with #234's plugin Bun.
import { guardApiRouter, type ApiRouter, type InstallRecord } from "../contracts/plugin-host";
import { createApiRouter, type ApiHandlers, type ApiRouterOptions } from "./api/router";

export * from "./api/confirm";
export * from "./api/points";
export * from "./api/router";
export * from "./api/settings";
export * from "./api/storage";
export * from "./api-channel";
export * from "./invocations";

/** The router a plugin-host connection serves: the process check (S4) in front of the capability gate, in front of
 *  the areas' handlers. `recordOf` reads the core's install records, never anything a plugin says. */
export function pluginApiRouter(o: ApiRouterOptions & { recordOf: (pluginId: string) => InstallRecord | undefined; handlers: readonly ApiHandlers[] }): ApiRouter {
  return guardApiRouter(createApiRouter(o), o.recordOf);
}
