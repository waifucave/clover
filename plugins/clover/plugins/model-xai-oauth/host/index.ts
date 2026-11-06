// clover/model-xai-oauth's host half (spec §3.3, §5.2, §5.3 `models`): Grok (SuperGrok sign-in)'s models through the SDK's xAI subscription adapter, keyless in the `clover` plugin host: the core runs xAI's device sign-in, keeps and refreshes the token, and adds it to each request through its keyed fetch.
//
// The core calls `adapter` (its manifest's `models[0].adapter`) through the plugin host: `describe`, `streamTurn`,
// `listModels`, `validateCredential` (provider-runtime's `modelAdapterHandlers`). The adapter is built
// from this folder's own manifest entry and catalog file, so it serves exactly the rows this plugin carries.
import type { ModelEntry } from "@waifucave/clover-provider-catalog";
import { familyModelAdapter, modelAdapterHandlers } from "@waifucave/clover-provider-runtime";
import catalogFile from "../catalog.json" with { type: "json" };
import manifest from "../clover.json" with { type: "json" };

export const PLUGIN_ID = "clover/model-xai-oauth";

/** This plugin's one `models[]` entry. */
export const ENTRY = manifest.contributes.models[0] as unknown as ModelEntry;

/** The adapter, as a `ModelAdapter` (this plugin's conformance runs on it). */
export const modelAdapter = familyModelAdapter({ pluginId: PLUGIN_ID, entry: ENTRY, catalogFile, credential: { keyed: { name: "signIn", material: "oauth" } } });

/** The handler the core calls. */
export const adapter = modelAdapterHandlers(modelAdapter);

/**
 * The `custom` sign-in its manifest names. Sign-ins stay in the core (spec §3.3): the core runs xAI's device grant
 * itself (`packages/core/src/runtime-sdk/credentials.ts`). Until lane B gives the manifest a method for a sign-in the
 * core runs by a flow of its own, this handler only names that flow, so the welcome guide can start it.
 */
export function signIn(): { flow: "core"; id: "xai-device" } {
  return { flow: "core", id: "xai-device" };
}
