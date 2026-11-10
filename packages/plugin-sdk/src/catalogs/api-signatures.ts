// The plugin API's calls as typed signatures: each dotted path (`ApiCallPath`) to its arguments (a tuple) and its result,
// read from `PluginApi` itself, so they can't drift from it. The app's layers (lane E) build `plugin.layer.api` calls
// with `layerApiCall`, and the core reads them back with the same types: a mismatch fails the typecheck, not a call.
//
// On the wire a call is `{ call, args }`: `args` is the method's parameters in order, as a JSON array (structured clone
// for a host half). A listener argument can't cross it: a call that takes one (`*.watch`, `host.on`) is made where its
// listener lives (`pluginHost.api` turns it into a subscription; a layer's `host.on` listens to `plugin_ui_message`).
import type { PluginApi } from "../api/plugin-api";
import type { ApiCallPath } from "./api-calls";

/** The function at a dotted path of `T` (`storage.synced.get` → `PluginApi["storage"]["synced"]["get"]`). */
type FnAt<T, P extends string> =
  P extends `${infer Head}.${infer Rest}`
    ? Head extends keyof T ? FnAt<NonNullable<T[Head]>, Rest> : never
    : P extends keyof T ? NonNullable<T[P]> : never;

/** Every plugin API call: its arguments, in order, and what it resolves to. */
export type ApiCallSignatures = {
  [P in ApiCallPath]: FnAt<PluginApi, P> extends (...args: infer A) => infer R ? { args: A; result: Awaited<R> } : never;
};

/** A call's arguments, as the tuple its `args` carries. */
export type ApiCallArgs<P extends ApiCallPath> = ApiCallSignatures[P]["args"];
/** What a call resolves to (`plugin.layer.api`'s `result`). */
export type ApiCallResult<P extends ApiCallPath> = ApiCallSignatures[P]["result"];

/** One call, typed: `{ call, args }` as `plugin.layer.api` and `pluginHost.api` carry it. */
export interface TypedApiCall<P extends ApiCallPath = ApiCallPath> {
  call: P;
  args: ApiCallArgs<P>;
}

/** Builds a call with its arguments checked against the API: `layerApiCall("storage.synced.set", "deck", ["fool"])`. */
export function layerApiCall<P extends ApiCallPath>(call: P, ...args: ApiCallArgs<P>): TypedApiCall<P> {
  return { call, args };
}
