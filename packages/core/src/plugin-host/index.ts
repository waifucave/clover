// The plugin host's core side (lane B, B-M2; spec §5.2, §5.4): the plugin API's router (the capability gate), the caller
// binding and the pipe's API channel. The areas the router serves come in B-M2's API PR.
import { guardApiRouter, type ApiRouter, type InstallRecord } from "../contracts/plugin-host";
import { createApiRouter, type ApiHandlers, type ApiRouterOptions } from "./api/router";

export * from "./api/router";
export * from "./api-channel";
export * from "./invocations";

/** The router a plugin-host connection serves: the process check (S4) in front of the capability gate, in front of
 *  the areas' handlers. `recordOf` reads the core's install records, never anything a plugin says. */
export function pluginApiRouter(o: ApiRouterOptions & { recordOf: (pluginId: string) => InstallRecord | undefined; handlers: readonly ApiHandlers[] }): ApiRouter {
  return guardApiRouter(createApiRouter(o), o.recordOf);
}
