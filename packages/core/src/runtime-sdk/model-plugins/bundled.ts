// The model plugins Clover bundles (spec §3.3, §5.1 "What ships": "one model plugin per current provider"). Owner:
// lane A.
//
// Every provider of the SDK's catalog is a child of the bundled `clover` plugin, `plugins/clover/plugins/model-<id>/`,
// GENERATED from that catalog (`generate.ts`) and committed, like the protocol's codegen; a test fails while the
// committed folders and the catalog disagree. Each folder holds:
//   * `clover.json`: one `models[]` entry, minimal (provider, name, catalog, auth and an endpoint or an adapter);
//   * `catalog.json`: the provider's rows and the rest of its record (provider-catalog's catalog file, format 1).
//
// DECLARATIVE (data, no code): every provider on one of the SDK's generic adapters, 212 of 218. Its entry names a
// compatible `endpoint` and the core runs it on the generic adapter for that protocol.
//
// CODE: the six providers whose adapter is their own (`CODE_PLUGINS`). Each has a host module exporting `adapter`,
// the SDK's family adapter for it as a `ModelAdapter`, which the core calls through the plugin host:
//   * keyless on the keyed fetch (`modelAdapterFromProviderAdapter`): Azure OpenAI, Google, Codex, xAI's subscription;
//   * signing with its secret in a process of its own (`modelAdapterFromSigningAdapter`): Bedrock (SigV4) and Vertex
//     (a service account's JWT), declared `host.runtime: "node"`, the manifest's one way to say "a process of its
//     own" until lane B gives Bun one (the report's ask).
// Their `host/` folders are hand-written; the generator writes and checks only `clover.json` and `catalog.json`.
//
// SIGN-INS stay in the core (§3.3). An API key is an `api-key` entry whose placement is the header its protocol's
// generic adapter sends; Codex's ChatGPT sign-in is `oauth-pkce` with Codex's public client; the sign-ins the core
// runs by flows of its own (xAI's device grant) are a `custom` entry until lane B has a method for a core-run flow.
// A provider whose sign-in is only such a flow and has no code (Anthropic Console's `ant` profile, the key-less
// `uncloseai`) keeps its sign-in in its catalog record (`authKinds`) and declares no `auth` entry for now.
import { join } from "node:path";
import { CODEX } from "@waifucave/clover-provider-runtime";

/** Where the bundled `clover` tree keeps its children: the one place lane A's code and tests resolve them from. */
export const BUNDLED_CHILDREN_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "plugins", "clover", "plugins");

/** The folder (and child id) of a provider's plugin: `model-<provider>`. */
export function modelPluginFolder(providerId: string): string {
  return `model-${providerId}`;
}

/** The plugin id of a provider's bundled plugin. */
export function modelPluginId(providerId: string): string {
  return `clover/${modelPluginFolder(providerId)}`;
}

/** The `auth` secret every key-taking provider keeps its key under. */
export const API_KEY_SECRET = "api-key";

export type AuthEntry =
  | { method: "api-key"; secret: string; help?: string; placement?: { header: "authorization"; scheme?: string } | { header: "x-api-key" | "api-key" | "x-goog-api-key" } }
  | { method: "oauth-pkce"; authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[]; secret: string }
  | { method: "custom"; handler: string };

export interface CodePluginTemplate {
  /** `bun`: a worker in the `clover` plugin host; `node`: a process of its own (it signs with its secret). */
  runtime: "bun" | "node";
  capabilities: string[];
  auth: AuthEntry[];
}

const keyHelp = (name: string): string => `Your ${name} API key. Clover keeps it in your credential store and adds it to ${name}'s requests itself; this plugin never sees it.`;

/** The six providers whose adapter is their own, by provider id. */
export const CODE_PLUGINS: Readonly<Record<string, CodePluginTemplate>> = {
  "azure-openai": {
    runtime: "bun",
    capabilities: ["network:*.openai.azure.com", "network:*.cognitiveservices.azure.com"],
    auth: [{ method: "api-key", secret: API_KEY_SECRET, help: keyHelp("Azure OpenAI"), placement: { header: "api-key" } }],
  },
  google: {
    runtime: "bun",
    capabilities: ["network:generativelanguage.googleapis.com"],
    auth: [{ method: "api-key", secret: API_KEY_SECRET, help: keyHelp("Google AI Studio"), placement: { header: "x-goog-api-key" } }],
  },
  "codex-oauth": {
    runtime: "bun",
    capabilities: ["network:chatgpt.com"],
    // Codex's own public client (codex-rs), redirecting to a loopback port its registration allows.
    auth: [{ method: "oauth-pkce", authorizeUrl: CODEX.authorizeUrl, tokenUrl: CODEX.tokenUrl, clientId: CODEX.clientId, scopes: CODEX.scope.split(" "), secret: "chatgpt" }],
  },
  "xai-oauth": {
    runtime: "bun",
    capabilities: ["network:cli-chat-proxy.grok.com"],
    auth: [{ method: "custom", handler: "signIn" }],
  },
  bedrock: {
    runtime: "node",
    // The process reaches exactly `bedrock-runtime.<region>` and `bedrock.<region>` for the connection's region
    // (`bedrockNetworkHosts`); the manifest can't name a host from a setting yet (the report's ask).
    capabilities: ["network:*.amazonaws.com"],
    auth: [{ method: "api-key", secret: "aws", help: "An AWS access key for Bedrock, as JSON ({\"kind\":\"aws\",\"accessKeyId\":…,\"secretAccessKey\":…}). Only this plugin's own process reads it, to sign each request." }],
  },
  vertex: {
    runtime: "node",
    // `<location>-aiplatform.googleapis.com` and Google's token endpoint, for the connection's location.
    capabilities: ["network:*.googleapis.com"],
    auth: [{ method: "api-key", secret: "gcp-service-account", help: "A Google Cloud service account key for Vertex AI, as JSON. Only this plugin's own process reads it, to sign its token requests." }],
  },
};

/** The header each generic protocol's adapter puts an API key in: Bearer for the OpenAI shapes (the default, left
 *  unsaid), `x-api-key` for Messages. */
export function keyPlacementFor(protocol: "openai-chat" | "openai-responses" | "anthropic-messages"): { header: "x-api-key" } | undefined {
  return protocol === "anthropic-messages" ? { header: "x-api-key" } : undefined;
}
