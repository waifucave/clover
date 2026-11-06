// clover/model-bedrock's host half (spec §3.3, §5.2, §5.3 `models`): AWS Bedrock's models through the SDK's Bedrock Converse adapter, which signs every request with SigV4, so it runs in a process of its own (`host.runtime`), the only place `secrets.get` exists (spec §5.2): it reads the `aws` secret there and nowhere else.
//
// The core calls `adapter` (its manifest's `models[0].adapter`) through the plugin host: `describe`, `streamTurn`,
// `listModels`, `validateCredential` (provider-runtime's `modelAdapterHandlers`). The adapter is built
// from this folder's own manifest entry and catalog file, so it serves exactly the rows this plugin carries.
import type { ModelEntry } from "@waifucave/clover-provider-catalog";
import { familyModelAdapter, modelAdapterHandlers } from "@waifucave/clover-provider-runtime";
import catalogFile from "../catalog.json" with { type: "json" };
import manifest from "../clover.json" with { type: "json" };

export const PLUGIN_ID = "clover/model-bedrock";

/** This plugin's one `models[]` entry. */
export const ENTRY = manifest.contributes.models[0] as unknown as ModelEntry;

/** The adapter, as a `ModelAdapter` (this plugin's conformance runs on it). */
export const modelAdapter = familyModelAdapter({ pluginId: PLUGIN_ID, entry: ENTRY, catalogFile, credential: { signing: "aws" } });

/** The handler the core calls. */
export const adapter = modelAdapterHandlers(modelAdapter);
