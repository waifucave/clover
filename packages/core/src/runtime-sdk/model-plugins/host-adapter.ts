// A code model plugin's adapter, reached through the plugin host (spec §5.2 "Where adapters run: in the plugin host";
// lane B's `PluginHost` contract, its fake until B-M2). Owner: lane A.
//
// The plugin's `models[].adapter` names an export of its host module, an object of handlers (provider-runtime's
// `modelAdapterHandlers`): `describe`, `streamTurn`, `listModels`, `validateCredential`, `countTokens`. This module is
// the core's side of that: `describeModelAdapter` asks once, when the plugin loads, and `pluginHostModelAdapter` is
// the `HostModelAdapter` the core serves to sessions (provider-runtime's `createHostModelAdapterServer`), each call a
// `PluginHost.invoke` or, for a turn, a `PluginHost.stream`.
//
// * A turn has no time limit while it streams: the stream keeps its own limit (`ownLimit`), as a tool call does, and
//   the session's abort cancels it. Discovery and credential checks keep the plugin API's own limits.
// * The caller is the session the call is for (R7: a call a plugin makes while it serves one acts as that session);
//   the core stamps it, never the plugin.
// * Everything that crosses is structured-clone data: the turn's request without its signal, the connection, the
//   events. The plugin's key never does: the plugin reaches its provider through the core's keyed fetch (§5.4).
import type { Caller } from "@waifucave/clover-protocol";
import { MODEL_ADAPTER_INTERFACE_VERSION, type HostModelAdapter, type HostModelAdapterContext, type ModelAdapterDescription, type ProviderEvent, type TurnRequest } from "@waifucave/clover-provider-runtime";
import { ContractError } from "../../contracts/common";
import type { PluginHost } from "../../contracts/plugin-host";

/** A turn may stream this long at most before the host gives up on it (the adapter's own stall watchdog ends a silent one far sooner). */
export const MODEL_TURN_LIMIT_MS = 6 * 60 * 60_000;

export interface PluginAdapterRef {
  pluginId: string;
  /** The export the manifest names (`models[].adapter`). */
  handler: string;
}

/** Asks the plugin's adapter who it is. Refuses an adapter on another interface version than this core's. */
export async function describeModelAdapter(host: PluginHost, ref: PluginAdapterRef): Promise<ModelAdapterDescription> {
  const d = await host.invoke<ModelAdapterDescription>({ pluginId: ref.pluginId, handler: ref.handler, method: "describe", args: undefined, caller: { kind: "core" } });
  if (d === null || typeof d !== "object" || typeof d.id !== "string" || typeof d.version !== "string") throw new ContractError("failed", `${ref.pluginId}'s adapter did not describe itself`);
  if (d.interfaceVersion !== MODEL_ADAPTER_INTERFACE_VERSION) throw new ContractError("failed", `${ref.pluginId}'s adapter speaks model adapter interface ${String(d.interfaceVersion)}, and this core speaks ${MODEL_ADAPTER_INTERFACE_VERSION}`);
  return d;
}

function withoutSignal(req: TurnRequest): Omit<TurnRequest, "signal"> {
  const { signal: _signal, ...rest } = req;
  return rest;
}

/** The plugin's adapter as the core serves it to one session. */
export function pluginHostModelAdapter(host: PluginHost, ref: PluginAdapterRef, opts: { caller: Caller; session?: string; countTokens?: boolean }): HostModelAdapter {
  const base = { pluginId: ref.pluginId, handler: ref.handler, caller: opts.caller, ...(opts.session !== undefined ? { session: opts.session } : {}) };
  const callArgs = (ctx: HostModelAdapterContext) => ({ connection: ctx.connection, stallTimeoutMs: ctx.stallTimeoutMs });
  const adapter: HostModelAdapter = {
    streamTurn(req: TurnRequest, ctx: HostModelAdapterContext): AsyncIterable<ProviderEvent> {
      return host.stream<ProviderEvent, void>({ ...base, method: "streamTurn", args: { ...callArgs(ctx), req: withoutSignal(req) }, signal: ctx.signal, timeoutMs: MODEL_TURN_LIMIT_MS, ownLimit: true });
    },
    listModels: (ctx) => host.invoke({ ...base, method: "listModels", args: { ...callArgs(ctx), limits: ctx.limits }, signal: ctx.signal, timeoutMs: ctx.limits.timeoutMs }),
    validateCredential: (ctx) => host.invoke({ ...base, method: "validateCredential", args: callArgs(ctx), signal: ctx.signal }),
  };
  if (opts.countTokens === true) adapter.countTokens = (req, ctx) => host.invoke<number>({ ...base, method: "countTokens", args: { ...callArgs(ctx), req: withoutSignal(req) }, signal: ctx.signal });
  return adapter;
}
