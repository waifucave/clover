// Every provider a model plugin (spec §3.3, A-M2). The pieces:
//   bundled.ts     the plugins Clover bundles, one per provider, and the six code plugins' templates
//   generate.ts    their generator and the check that the committed folders match the SDK's catalog
//   load.ts        the enabled `models` entries read from the plugin registry, built into one catalog
//   host-adapter.ts  a code plugin's adapter through the plugin host
//   plugin-api.ts  the interim `net.fetch` and `secrets.get` a model plugin calls (lane B's router replaces it)
//   service.ts     `ModelPlugins`: the catalog file and served adapters, followed live, and each session's option
//   keychain-tokens.ts  a bundled plugin's keys from today's provider keychain slots
//   start.ts       the daemon's one call: the router, the credentials, `ModelPlugins`, installed
//
// The daemon installs one `ModelPlugins` once it has a plugin registry and host (`installModelPlugins`); every
// embedded session then runs on it (`Options.modelProviders`), and the core's own catalog readers read its catalog
// (`activeCatalog`). Until then both fall back to the SDK's compiled catalog, which the bundled plugins are
// generated from, so nothing differs.
import type { WinterCatalog } from "@waifucave/clover-provider-catalog";
import { setInternalCodeAdapterSource } from "../../providers/internal-adapters";
import { setActiveCatalogSource } from "./catalog-source";
import { compiledProviderKey, type ModelPlugins } from "./service";

export { activeCatalog, activeCatalogGeneration } from "./catalog-source";
export { ModelPlugins } from "./service";
export type { ModelPluginsOptions, ModelPluginsSnapshot, ServedModelAdapter } from "./service";

let installed: ModelPlugins | undefined;
const catalogListeners = new Set<(change: ModelCatalogChange) => void>();
let lastKey = "compiled";
let lastPlugins = new Set<string>();

/** A change to what the sessions are given: the whole key moved, with the model plugins whose served adapter or
 *  presence changed (to say which plugin's change caused a replacement). Each session compares its own provider's key
 *  (`modelProviderKey`) and is left alone when that didn't move. */
export interface ModelCatalogChange {
  key: string;
  plugins: string[];
}

/** What a session on `provider` is given now: the installed model plugins' (`ModelPlugins.providerKey`), else the
 *  compiled catalog's. */
export function modelProviderKey(provider: string): string {
  return installed?.providerKey(provider) ?? compiledProviderKey(provider);
}

/** Calls `fn` whenever what the sessions are given may have changed: the model plugins installed or removed, or their
 *  catalog or served adapters rebuilt. */
export function onModelCatalogChange(fn: (change: ModelCatalogChange) => void): () => void {
  catalogListeners.add(fn);
  return () => { catalogListeners.delete(fn); };
}

/** Tells the listeners when the installed model plugins' key moved (`ModelPlugins` after a rebuild). */
export function modelCatalogMaybeChanged(): void {
  const key = installed?.sessionKey() ?? "compiled";
  if (key === lastKey) return;
  lastKey = key;
  const now = new Set<string>([...(installed?.snapshot?.served.values() ?? [])].map((s) => `${s.pluginId}@${s.description.version}`));
  const plugins = [...new Set([...now, ...lastPlugins].filter((p) => !(now.has(p) && lastPlugins.has(p))).map((p) => p.slice(0, p.lastIndexOf("@"))))].sort();
  lastPlugins = now;
  for (const fn of [...catalogListeners]) {
    try { fn({ key, plugins }); } catch { /* a listener's own failure is its own */ }
  }
}

/** Installs (or with undefined, removes) the computer's model plugins: sessions and the catalog readers use it. */
export function installModelPlugins(plugins: ModelPlugins | undefined): void {
  installed = plugins;
  setActiveCatalogSource(plugins === undefined ? undefined : (): WinterCatalog | undefined => plugins.catalog);
  // The core's internal jobs run a code plugin's provider on the plugin, as the core (`internal-adapters.ts`).
  setInternalCodeAdapterSource(plugins === undefined ? undefined : (providerId) => plugins.providerAdapterFor(providerId, { caller: { kind: "core" } }));
  modelCatalogMaybeChanged();
}

/** The installed model plugins, if any. */
export function installedModelPlugins(): ModelPlugins | undefined {
  return installed;
}
