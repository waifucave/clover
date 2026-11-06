// The daemon's one call for the model plugins (A-M2): given lane B's plugin registry and plugin host, it serves the
// model plugins' `net.fetch` and `secrets.get` (the interim `plugin-api.ts` router, over today's keychain slots,
// `keychain-tokens.ts`), loads every model plugin (`ModelPlugins`), and installs it, so every embedded session and
// the core's catalog readers run on the plugins. `stop` puts the SDK's compiled catalog back. Owner: lane A.
//
// Until B-M2 the model plugins' router is the host's whole router (`serveApi`): B-M2's router serves the whole plugin
// API, these two calls included, and replaces it.
//
// The daemon calls it where it starts (`daemon.ts`, right after its secret store), only when it was handed a registry
// and a host: until lane B's (B-M1's registry, B-M2's host) exist there is none, and the SDK's compiled catalog,
// which the bundled plugins are generated from, serves exactly the same providers.
import { guardApiRouter, type PluginHost } from "../../contracts/plugin-host";
import type { PluginRegistry } from "../../contracts/plugin-registry";
import type { SecretStore as ContractSecretStore } from "../../contracts/secret-store";
import type { SecretStore as DaemonSecretStore } from "../../auth/secret-store";
import type { ProviderRefresher } from "../host-credentials";
import { installModelPlugins } from "./index";
import { keychainModelPluginCredentials } from "./keychain-tokens";
import { modelPluginApiRouter, secretStoreCredentials } from "./plugin-api";
import { ModelPlugins } from "./service";

export interface StartModelPluginsOptions {
  registry: PluginRegistry;
  host: PluginHost;
  /** The Clover home (the catalog file goes in `<home>/run/models/`). */
  home: string;
  /** The daemon's own secret store: the provider keychain slots. */
  secrets: DaemonSecretStore;
  /** Per slot account, its renewal (`daemon.ts`'s `credentialRefreshers`). */
  refreshers?: Readonly<Record<string, ProviderRefresher>>;
  /** A plugin's own items (lane C's store), for the plugins that aren't bundled. */
  pluginSecrets?: Pick<ContractSecretStore, "get">;
  log?: (line: string) => void;
  /** The platform fetch under the keyed fetch (a test seam). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface StartedModelPlugins {
  plugins: ModelPlugins;
  stop(): void;
}

export async function startModelPlugins(opts: StartModelPluginsOptions): Promise<StartedModelPlugins> {
  const credentials = keychainModelPluginCredentials({
    registry: opts.registry,
    secrets: opts.secrets,
    ...(opts.refreshers !== undefined ? { refreshers: opts.refreshers } : {}),
    ...(opts.pluginSecrets !== undefined ? { fallback: secretStoreCredentials(opts.pluginSecrets) } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
  await credentials.prime();
  opts.host.serveApi(
    guardApiRouter(modelPluginApiRouter({ registry: opts.registry, tokens: credentials.tokens, secret: credentials.secret, ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}) }), (id) => {
      const r = opts.registry.get(id);
      return r === undefined ? undefined : { id: r.id, source: r.source, ...(r.manifest?.host?.runtime ? { runtime: r.manifest.host.runtime } : {}) };
    }),
  );
  const plugins = new ModelPlugins({
    registry: opts.registry,
    host: opts.host,
    home: opts.home,
    connectionFor: (pluginId, connection) => credentials.connectionFor(pluginId, connection),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
  await plugins.start();
  installModelPlugins(plugins);
  return {
    plugins,
    stop() {
      installModelPlugins(undefined);
      plugins.stop();
    },
  };
}
