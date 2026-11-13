// A turn on a model a plugin's code adapter serves (lane A, rows 1.42 and 1.92): the bundled Google model plugin's
// adapter runs in the plugin host and reaches the user's own endpoint for `google` (`providers.google.baseUrl`, the
// run's loopback fake, fake-gemini.ts) through the core's keyed fetch, which adds the key. Google has no other way to
// answer here: the fake is its only endpoint, and the compiled path isn't taken for a provider the plugins serve. Kept
// apart from run.ts (which starts a run when loaded) so the verdict can be unit-tested.
import type { FakeGeminiRequest } from "./fake-gemini";

export const CODE_ADAPTER_STEP = "a turn on a model a plugin's code adapter serves: Alpha on Gemini, the bundled Google plugin's adapter in the plugin host reaching the user's own endpoint (providers.google.baseUrl, a loopback fake) with the key the core adds";

/** The bundled Google model plugin, the model Alpha is moved to, and what the fake answers. */
export const GOOGLE_PLUGIN = "clover/model-google";
export const GEMINI_MODEL = "google/gemini-2.5-flash";
export const GEMINI_REPLY = "ACCEPTANCE-GEMINI-OK from the plugin's adapter";

export const THIRD_PARTY_MODEL_STEP = "a turn on a third-party code model plugin: a folder-installed plugin with its own provider and adapter, its OK approved and its key stored through its sign-in, answers Alpha's turn through the plugin host, reaching its one declared host with that key";
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
