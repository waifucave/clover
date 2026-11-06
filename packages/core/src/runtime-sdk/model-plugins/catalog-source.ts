// The one catalog the core's own readers use (the model tag rules, provider selection, credential slots, the
// session driver): the installed model plugins' catalog (`installModelPlugins`), else the SDK's compiled one, which
// the bundled plugins are generated from. Owner: lane A.
//
// Readers that memoise something derived from the catalog key it by `activeCatalogGeneration()`, which moves
// whenever the catalog does, so a plugin switched off is gone from them at their next read.
import { loadCatalog, type WinterCatalog } from "@waifucave/clover-provider-catalog";

let source: (() => WinterCatalog | undefined) | undefined;
let last: WinterCatalog | undefined;
let generation = 0;

export function setActiveCatalogSource(fn: (() => WinterCatalog | undefined) | undefined): void {
  source = fn;
}

/** The catalog the sessions resolve against now. */
export function activeCatalog(): WinterCatalog {
  const catalog = source?.() ?? loadCatalog();
  if (catalog !== last) {
    last = catalog;
    generation += 1;
  }
  return catalog;
}

/** A number that moves whenever `activeCatalog()` returns another catalog. */
export function activeCatalogGeneration(): number {
  activeCatalog();
  return generation;
}
