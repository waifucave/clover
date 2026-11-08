// The bots' provider fill (`BotDriverDeps.provider`): which provider a bot's model runs on and how its credentials reach
// the runtime, the way a code or chat session's are (session-driver.ts), from the user's settings. Owner: lane A.
//
// From the bot's model tag (`<provider>/<model>`), only the model's own keys (`PROVIDER_FILL_KEYS`, through the guarded
// `fillProvider`, which refuses anything else):
// - `model`: the bare model id, as a session's (`splitTag`);
// - `provider`: the tag's provider and its Keychain locator (`providerFor`), with the user's own endpoint for that
//   provider when the settings name one (`providerBaseUrlFor`, a self-hosted or proxied endpoint);
// - `onCredentialResolve`: the daemon's one credential broker (shared with the sessions, so a renewal is one grant),
//   allowed the bot's provider's item and the catalog slots a cross-provider subagent may resolve: the providers the
//   settings permit and that have a credential stored, as for a session;
// - `modelProviders`: the computer's model plugins, when they're installed (A-M2), as for a session.
// A `winter-test/*` model never reaches it (`fillProvider` skips it), and a provider with no stored credential still
// gets a selection without one: the runtime then refuses with its own provider error.

import type { Options } from "@waifucave/clover-agent-sdk";
import type { SecretStore } from "../../auth/secret-store";
import type { BotSessionContext } from "../../bots/service";
import { permittedProviders, providerBaseUrlFor, type Settings } from "../../settings";
import { sessionCredentialAllowlist, type HostCredentialBroker } from "../host-credentials";
import { credentialPresenceFrom } from "../keychain";
import { splitTag } from "../model-tag";
import { installedModelPlugins } from "../model-plugins";
import type { ModelPlugins } from "../model-plugins/service";
import { providerFor } from "../provider-selection";

export interface BotProviderFillDeps {
  /** The Clover home (`providerFor`'s Keychain locator). */
  home: string;
  /** The daemon's one credential broker, the sessions' too (`createHostCredentialBroker`). */
  broker: HostCredentialBroker;
  /** The daemon's secret store: which providers have a credential stored. */
  secrets: SecretStore;
  /** The user's settings, read at each fill (a provider's own endpoint). */
  settings?(): Settings | null | undefined;
  /** The computer's model plugins; the installed ones when left out (`installedModelPlugins`). */
  modelPlugins?(): ModelPlugins | undefined;
}

/** `BotDriverDeps.provider` over the daemon's broker and the user's settings. Without a session (an in-process
 *  agent's `EmbeddedSessionDeps.provider`), the model plugins are asked for no session in particular. */
export function botProviderFill(deps: BotProviderFillDeps): (model: string, options: Options, ctx?: Pick<BotSessionContext, "sessionId">) => Promise<void> {
  return async (model, options, ctx) => {
    const selection = providerFor(model, deps.home);
    if (selection === undefined) return;
    options.model = splitTag(model).modelId;
    const baseUrl = providerBaseUrlFor(deps.settings?.(), selection.providerId);
    options.provider = baseUrl === undefined ? selection : { ...selection, connection: { baseUrl, endpointOrigin: "user", local: true } };
    // The catalog slots a subagent may resolve: permitted and credentialed now (review r1 (h), as for a session).
    const permitted = new Set(permittedProviders().map((p) => p.providerId));
    const credentials = await credentialPresenceFrom(deps.secrets);
    const slotProviders = new Set(Object.entries(credentials.byProvider).filter(([id, kind]) => kind !== undefined && permitted.has(id)).map(([id]) => id));
    // No MCP sign-ins: a bot's MCP servers are the core's own and its plugins' tools, served in process.
    options.onCredentialResolve = deps.broker.resolverFor(sessionCredentialAllowlist(options, {}, slotProviders));
    const modelProviders = (deps.modelPlugins ?? installedModelPlugins)()?.sessionOption({ caller: { kind: "core" }, ...(ctx === undefined ? {} : { session: ctx.sessionId }) });
    if (modelProviders !== undefined) options.modelProviders = modelProviders;
  };
}
