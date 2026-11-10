// Test support: B's router as far as the model plugins need it, over a fake plugin host. `addApiHandlers` adds
// handlers (last one wins per path, as B's router), and the router calls them with the calling plugin's own record,
// behind the contract's guard. B's real gate (enabled, state, granted, allowNetwork) is B's tests' to cover.
import { ContractError } from "../../../src/contracts/common";
import { guardApiRouter, type PluginHost } from "../../../src/contracts/plugin-host";
import type { PluginRegistry } from "../../../src/contracts/plugin-registry";
import type { ApiCallPath } from "@waifucave/clover-plugin-sdk";
import type { ApiHandlers } from "../../../src/plugin-host/api/router";

export function serveApiHandlers(host: Pick<PluginHost, "serveApi">, registry: Pick<PluginRegistry, "get">): { addApiHandlers(h: ApiHandlers): () => void; served(): number } {
  const list: ApiHandlers[] = [];
  host.serveApi(guardApiRouter(async (call) => {
    const record = registry.get(call.pluginId);
    if (record === undefined) throw new ContractError("not_installed", `${call.pluginId} isn't installed`);
    let fn: ApiHandlers[ApiCallPath] | undefined;
    for (const h of list) fn = h[call.path as ApiCallPath] ?? fn;
    if (fn === undefined) throw new ContractError("refused", `${call.path} is not served on this computer`);
    return fn({ pluginId: call.pluginId, process: call.process, caller: call.caller, record, path: call.path as ApiCallPath }, call.args);
  }, (id) => {
    const r = registry.get(id);
    return r === undefined ? undefined : { id: r.id, source: r.source, ...(r.manifest?.host?.runtime ? { runtime: r.manifest.host.runtime } : {}) };
  }));
  return {
    addApiHandlers(h) {
      list.push(h);
      return () => {
        const i = list.indexOf(h);
        if (i >= 0) list.splice(i, 1);
      };
    },
    served: () => list.length,
  };
}
