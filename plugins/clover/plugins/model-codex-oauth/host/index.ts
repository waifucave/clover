// clover/model-codex-oauth's host half (spec §3.3, §5.2, §5.3 `models`): Codex (ChatGPT sign-in)'s models through the SDK's Codex adapter, keyless in the `clover` plugin host: the core holds the ChatGPT sign-in (its `oauth-pkce` entry), refreshes it, and adds the access token to each request through its keyed fetch; the account id rides the connection (`ConnectionProfile.account`). Its `originator` is `"clover"` (spec §3.3), set here, whatever identity the plugin host has.
//
// The core calls `adapter` (its manifest's `models[0].adapter`) through the plugin host: `describe`, `streamTurn`,
// `listModels`, `validateCredential` (provider-runtime's `modelAdapterHandlers`). The adapter is built
// from this folder's own manifest entry and catalog file, so it serves exactly the rows this plugin carries.
import type { ModelEntry } from "@waifucave/clover-provider-catalog";
import { familyModelAdapter, modelAdapterHandlers } from "@waifucave/clover-provider-runtime";
import catalogFile from "../catalog.json" with { type: "json" };
import manifest from "../clover.json" with { type: "json" };

export const PLUGIN_ID = "clover/model-codex-oauth";

/** The `originator` this plugin sends (spec §3.3; a first party never). */
export const CODEX_ORIGINATOR = "clover";

/** This plugin's one `models[]` entry. */
export const ENTRY = manifest.contributes.models[0] as unknown as ModelEntry;

/** The adapter, as a `ModelAdapter` (this plugin's conformance runs on it). */
export const modelAdapter = familyModelAdapter({ pluginId: PLUGIN_ID, entry: ENTRY, catalogFile, codexOriginator: CODEX_ORIGINATOR, credential: { keyed: { name: "chatgpt", material: "oauth" } } });

/** The handler the core calls. */
export const adapter = modelAdapterHandlers(modelAdapter);
