// A turn on each kind of bundled model plugin, each provider at the user's own endpoint on loopback
// (`providers.<id>.baseUrl`): Gemini on the Google plugin's code adapter in the plugin host, through the core's keyed
// fetch (rows 1.42 and 1.92; fake-gemini.ts); OpenAI on the Responses wire and Groq on the Chat Completions wire, the
// declarative plugins' generic adapters (rows 1.41 and 4.38; fake-openai.ts, the provider conformance fakes' streams).
// Each provider has no other way to answer: the fake is its only endpoint. Kept apart from run.ts (which starts a run
// when loaded) so the verdict can be unit-tested.
import type { FakeGeminiRequest } from "./fake-gemini";
import type { FakeOpenAiRequest } from "./fake-openai";

export const CODE_ADAPTER_STEP = "a turn on each kind of model plugin at the user's own endpoint (providers.<id>.baseUrl, loopback fakes): Alpha on Gemini through the bundled Google plugin's code adapter in the plugin host, on OpenAI's Responses wire and on Groq's Chat Completions wire through the declarative plugins, each with the key stored through its sign-in";

/** The OpenAI-wire providers the clause runs: the plugin, the model Alpha is moved to, the wire, and the base URL
 *  path its catalog endpoint has (the user's endpoint keeps it). */
export const OPENAI_WIRE_PROVIDERS = [
  { plugin: "clover/model-openai", provider: "openai", model: "openai/gpt-4.1-mini", wire: "responses", basePath: "/v1" },
  { plugin: "clover/model-groq", provider: "groq", model: "groq/llama-3.3-70b-versatile", wire: "chat/completions", basePath: "/openai/v1" },
] as const;
export const OPENAI_REPLY = "ACCEPTANCE-OPENAI-WIRE-OK from the generic adapter";

/** Why the turn doesn't show the provider's wire serving it, or undefined when it does. */
export function openAiWireWrong(o: { provider: string; wire: string; model: string; replyText: string; requests: readonly FakeOpenAiRequest[]; stop?: string; error?: string }): string | undefined {
  const streamed = o.requests.filter((r) => r.path.endsWith(`/${o.wire}`));
  const upstream = o.model.slice(o.model.indexOf("/") + 1);
  if (streamed.length === 0) return `${o.provider}: the turn never reached its fake's ${o.wire} (${o.requests.map((r) => r.path).join(", ") || "no request"}): stop ${o.stop ?? "?"}${o.error ? `: ${o.error}` : ""}`;
  if (!streamed.some((r) => r.keyMatched)) return `${o.provider}: its fake got the turn without the key (bearer present: ${streamed.some((r) => r.keyPresent)})`;
  if (!streamed.some((r) => r.model === upstream)) return `${o.provider}: its fake was asked for ${streamed.map((r) => r.model ?? "no model").join(", ")}, not ${upstream}`;
  if (!o.replyText.includes("ACCEPTANCE-OPENAI-WIRE-OK")) return `${o.provider}: the fake answered, but its reply isn't in the conversation (stop ${o.stop ?? "?"}${o.error ? `: ${o.error}` : ""})`;
  return undefined;
}

/** The bundled Google model plugin, the model Alpha is moved to, and what the fake answers. */
export const GOOGLE_PLUGIN = "clover/model-google";
export const GEMINI_MODEL = "google/gemini-2.5-flash";
export const GEMINI_REPLY = "ACCEPTANCE-GEMINI-OK from the plugin's adapter";

export const THIRD_PARTY_MODEL_STEP = "a turn on a third-party code model plugin: a folder-installed plugin with its own provider on this computer and its own adapter, its OK approved (naming that address) and its key stored through its sign-in, answers Alpha's turn through the plugin host, reaching its one declared host with that key";
export const THIRD_PARTY_KEY = "acceptance-models-dummy-key-not-a-secret";
export const THIRD_PARTY_REPLY = "ACCEPTANCE-THIRDPARTY-OK from the plugin's own adapter";
export const OAUTH_SIGN_IN_STEP = "an oauth-pkce sign-in through the core's real flow: a folder-installed plugin signs in against the run's OAuth server on this computer (the authorize URL fetched and its redirect delivered to the core's loopback callback by the run, no browser), the code exchanged with the PKCE verifier, and Alpha's turns on its model carry a live token, renewed by the core at the plugin's token endpoint near its expiry and after a 401";
export const OAUTH_PLUGIN = "acceptance-oauth";
export const OAUTH_MODEL = "acceptance-oauth/oauth-fast";
export const OAUTH_REPLY = "ACCEPTANCE-OAUTH-OK over the token the sign-in stored";
/** The third-party fixture, its model, and the folder it installs from. */
export const THIRD_PARTY_PLUGIN = "acceptance-models";
export const THIRD_PARTY_MODEL = "acceptance-models/acceptance-fast";

/** Why the turn doesn't show the plugin's adapter serving it, or undefined when it does: the reply in the conversation,
 *  and a streamed request at the fake for the model carrying the key. */
export function codeAdapterWrong(o: { replyText: string; requests: readonly FakeGeminiRequest[]; stop?: string; error?: string }): string | undefined {
  const streamed = o.requests.filter((r) => r.path.endsWith(":streamGenerateContent"));
  if (streamed.length === 0) return `the turn never reached the Google fake (${o.requests.length} other request(s)): stop ${o.stop ?? "?"}${o.error ? `: ${o.error}` : ""}`;
  if (!streamed.some((r) => r.keyMatched)) return `the Google fake got the turn without the key (key header present: ${streamed.some((r) => r.keyPresent)})`;
  if (!streamed.some((r) => r.model === GEMINI_MODEL.slice("google/".length))) return `the Google fake was asked for ${streamed.map((r) => r.model ?? "no model").join(", ")}, not ${GEMINI_MODEL}`;
  if (!o.replyText.includes("ACCEPTANCE-GEMINI-OK")) return `the fake answered, but its reply isn't in the conversation (stop ${o.stop ?? "?"}${o.error ? `: ${o.error}` : ""})`;
  return undefined;
}
