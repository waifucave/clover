// clover/model-google's host half (spec §3.3, §5.2, §5.3 `models`): Google AI Studio's models through the SDK's GenerateContent adapter, keyless in the `clover` plugin host: every request goes through the core's keyed fetch, which adds the key in the `x-goog-api-key` header.
//
// The core calls `adapter` (its manifest's `models[0].adapter`) through the plugin host: `describe`, `streamTurn`,
// `listModels`, `validateCredential`, `countTokens` (provider-runtime's `modelAdapterHandlers`). The adapter is built
// from this folder's own manifest entry and catalog file, so it serves exactly the rows this plugin carries.
import type { ModelEntry } from "@waifucave/clover-provider-catalog";
import { familyModelAdapter, modelAdapterHandlers } from "@waifucave/clover-provider-runtime";
import catalogFile from "../catalog.json" with { type: "json" };
import manifest from "../clover.json" with { type: "json" };

export const PLUGIN_ID = "clover/model-google";

/** This plugin's one `models[]` entry. */
export const ENTRY = manifest.contributes.models[0] as unknown as ModelEntry;

/** The adapter, as a `ModelAdapter` (this plugin's conformance runs on it). */
export const modelAdapter = familyModelAdapter({ pluginId: PLUGIN_ID, entry: ENTRY, catalogFile, credential: { keyed: { name: "api-key", material: "api-key" } } });

/** The handler the core calls. */
export const adapter = modelAdapterHandlers(modelAdapter);
