// The daemon's one call for the model plugins (A-M2): given lane B's plugin registry and plugin host, it adds the
// model plugins' `net.fetch` and `secrets.get` to B's API router as handlers (`addApiHandlers`, never a router of
// its own: #302's review B1), loads every model plugin (`ModelPlugins`), and installs it, so every embedded session
// and the core's catalog readers run on the plugins, merged with the SDK's compiled catalog (`mergeWithCompiled`).
// `stop` takes the handlers away and puts the SDK's compiled catalog back; a first load that fails rolls back the
// same way (S5). Owner: lane A.
//
// A host without `addApiHandlers` (B's 2f not landed) can't carry a code plugin's keyed fetch: no code adapter is
// served then, and every code provider stays on the compiled path.
import type { PluginHost } from "../../contracts/plugin-host";
import type { ApiHandlers } from "../../plugin-host/api/router";
import type { PluginRegistry } from "../../contracts/plugin-registry";
import { ContractError } from "../../contracts/common";
import type { SecretStore as ContractSecretStore } from "../../contracts/secret-store";
import type { PluginSecrets } from "../../plugin-host/daemon-host";
import type { SecretStore as DaemonSecretStore } from "../../auth/secret-store";
import type { ProviderRefresher } from "../host-credentials";
import { installModelPlugins } from "./index";
import { keychainModelPluginCredentials } from "./keychain-tokens";
import { modelPluginApiHandlers, secretStoreCredentials } from "./plugin-api";
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
  /** A plugin's own items (lane C's store, through the plugin host's `pluginSecrets`), for the plugins that aren't
   *  bundled: by plugin and name only. */
  pluginSecrets?: PluginSecrets;
  log?: (line: string) => void;
  /** B's `DaemonPluginHost.addApiHandlers`: adds the model plugins' two calls behind B's gate; returns their removal.
   *  Absent (a host without it): no code adapter is served, and code providers stay on the compiled path. */
  addApiHandlers?: (handlers: ApiHandlers) => () => void;
  /** The platform fetch under the keyed fetch (a test seam). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** A `network:public` fetch's audit sink and the user's dangerous-domain additions (public-fetch.ts). */
  audit?: (line: Record<string, unknown>) => void;
  dangerousAdded?: () => readonly string[];
  /** Serve the code plugins' adapters through the plugin host. Off by default: the plugin API's `net.fetch` doesn't
   *  cross a real plugin host yet (its `RequestInit` carries an `AbortSignal`, `Headers` and maybe a stream, which a
   *  worker's `postMessage` can't copy, and the `Response` it answers with doesn't survive the JSON link to the host
   *  process), so every code provider stays on this build's own compiled adapter, in process, through the broker, as
   *  Bedrock and Vertex do. An in-process host that carries live objects (the fake, the conformance loopback) may
   *  turn it on. */
  serveCodeAdapters?: boolean;
}

export interface StartedModelPlugins {
  plugins: ModelPlugins;
  stop(): void;
}

/** The plugin items `secretStoreCredentials` reads, through `PluginSecrets`: a plugin's own, by its id (the router's,
 *  never the call's) and name; any other owner is refused. */
function ownItemsStore(secrets: PluginSecrets): Pick<ContractSecretStore, "get"> {
  return {
    get: (ref) => ref.owner.kind === "plugin"
      ? secrets.forPlugin(ref.owner.pluginId).get(ref.name)
      : Promise.reject(new ContractError("refused", "a model plugin reads its own items only")),
  };
}

export async function startModelPlugins(opts: StartModelPluginsOptions): Promise<StartedModelPlugins> {
  const credentials = keychainModelPluginCredentials({
    registry: opts.registry,
    secrets: opts.secrets,
    ...(opts.refreshers !== undefined ? { refreshers: opts.refreshers } : {}),
    ...(opts.pluginSecrets !== undefined ? { fallback: secretStoreCredentials(ownItemsStore(opts.pluginSecrets)) } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
  await credentials.prime();
  const removeHandlers = opts.addApiHandlers?.(modelPluginApiHandlers({
    registry: opts.registry, tokens: credentials.tokens, secret: credentials.secret, ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(opts.audit !== undefined ? { audit: opts.audit } : {}), ...(opts.dangerousAdded !== undefined ? { dangerousAdded: opts.dangerousAdded } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  }));
  if (removeHandlers === undefined || opts.serveCodeAdapters !== true) opts.log?.("[model-plugins] the plugin host can't carry a keyed fetch yet: code providers stay on the compiled path");
  const plugins = new ModelPlugins({
    registry: opts.registry,
    host: opts.host,
    home: opts.home,
    connectionFor: (pluginId, connection) => credentials.connectionFor(pluginId, connection),
    ...(removeHandlers === undefined || opts.serveCodeAdapters !== true ? { serveCodeAdapters: false } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
  try {
    await plugins.start();
  } catch (err) {
    // S5: a failed first load leaves nothing behind: no watch, no handlers, the compiled catalog.
    plugins.stop();
    removeHandlers?.();
    throw err;
  }
  installModelPlugins(plugins);
  let stopped = false;
  return {
    plugins,
    stop() {
      if (stopped) return;
      stopped = true;
      installModelPlugins(undefined);
      plugins.stop();
      removeHandlers?.();
    },
  };
}
