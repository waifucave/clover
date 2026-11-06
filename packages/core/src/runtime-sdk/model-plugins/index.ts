// Every provider a model plugin (spec §3.3, A-M2). The pieces:
//   bundled.ts     the plugins Clover bundles, one per provider, and the six code plugins' templates
//   generate.ts    their generator and the check that the committed folders match the SDK's catalog
//   load.ts        the enabled `models` entries read from the plugin registry, built into one catalog
//   host-adapter.ts  a code plugin's adapter through the plugin host
//   plugin-api.ts  the interim `net.fetch` and `secrets.get` a model plugin calls (lane B's router replaces it)
//   service.ts     `ModelPlugins`: the catalog file and served adapters, followed live, and each session's option
//
// The daemon installs one `ModelPlugins` once it has a plugin registry and host (`installModelPlugins`); every
// embedded session then runs on it (`Options.modelProviders`), and the core's own catalog readers read its catalog
// (`activeCatalog`). Until then both fall back to the SDK's compiled catalog, which the bundled plugins are
// generated from, so nothing differs.
import type { WinterCatalog } from "@waifucave/clover-provider-catalog";
import { setActiveCatalogSource } from "./catalog-source";
import type { ModelPlugins } from "./service";

export { activeCatalog, activeCatalogGeneration } from "./catalog-source";
export { ModelPlugins } from "./service";
export type { ModelPluginsOptions, ModelPluginsSnapshot, ServedModelAdapter } from "./service";

let installed: ModelPlugins | undefined;

/** Installs (or with undefined, removes) the computer's model plugins: sessions and the catalog readers use it. */
export function installModelPlugins(plugins: ModelPlugins | undefined): void {
  installed = plugins;
  setActiveCatalogSource(plugins === undefined ? undefined : (): WinterCatalog | undefined => plugins.catalog);
}

/** The installed model plugins, if any. */
export function installedModelPlugins(): ModelPlugins | undefined {
  return installed;
}
