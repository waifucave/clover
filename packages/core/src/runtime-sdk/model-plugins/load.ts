// Reading the enabled model plugins (spec §3.3, §5.3 `models`): every active `models` entry of the plugin registry
// (lane B's contract; its fake until B-M1 lands a real one), with its catalog read from the plugin's folder, built
// into the one catalog the sessions resolve against (provider-catalog's `catalogFromModelPlugins`). Owner: lane A.
//
// * Only `active` entries count: one waiting for a setting or refused by the registry (a provider id another plugin
//   took first, §5.1 "Entry ids") is not a provider the sessions have.
// * A `catalog` path is read from inside the plugin's folder, never outside it (the manifest validator already
//   refuses a path that leaves it; this re-checks the resolved path, as every folder read does).
// * The bundled `clover` tree is TRUSTED: its code plugins' adapter ids are the ones their catalog files name, which
//   the core's own logic keys on (`TOOLS_GATED_ADAPTER_IDS`). Any other plugin's adapter is namespaced by its id.
// * The model families (the curated slot lineups) stay the SDK's; the builder keeps the slots the plugins serve.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { BUNDLED_ROOT_PLUGIN, topPluginIdOf } from "@waifucave/clover-protocol";
import { canonicalJson, catalogFromModelPlugins, loadCatalog, type CatalogFromModelPluginsResult, type ModelEntry, type ModelPluginInput, type ModelPluginRefusal } from "@waifucave/clover-provider-catalog";
import type { PluginRecord, PluginRegistry } from "../../contracts/plugin-registry";

/** One enabled entry, read: what the builder takes, and where it came from. */
export interface ReadModelEntry {
  input: ModelPluginInput;
  record: PluginRecord;
}

export interface ReadModelPlugins {
  entries: ReadModelEntry[];
  /** Entries whose catalog could not be read at all. */
  unreadable: ModelPluginRefusal[];
}

/** Whether a plugin is of the bundled `clover` tree, by its install record (never by what it says of itself). */
export function isBundledClover(record: Pick<PluginRecord, "id" | "source">): boolean {
  return record.source === "bundled" && topPluginIdOf(record.id) === BUNDLED_ROOT_PLUGIN;
}

/** Reads every active `models` entry and its catalog. `readFile` is a test seam. */
export function readModelPlugins(registry: PluginRegistry, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): ReadModelPlugins {
  const entries: ReadModelEntry[] = [];
  const unreadable: ModelPluginRefusal[] = [];
  for (const c of registry.entries("models")) {
    if (c.state !== "active") continue;
    const record = registry.get(c.pluginId);
    if (record === undefined) continue;
    const entry = c.value as unknown as ModelEntry & { catalog: string | unknown[] };
    let catalog: unknown = entry.catalog;
    if (typeof entry.catalog === "string") {
      const folder = resolve(record.folder);
      const path = resolve(folder, entry.catalog);
      const rel = relative(folder, path);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        unreadable.push({ pluginId: c.pluginId, ref: c.ref, provider: entry.provider, code: "catalog-outside", message: "the catalog path leaves the plugin's folder" });
        continue;
      }
      try {
        catalog = JSON.parse(readFile(path));
      } catch (err) {
        unreadable.push({ pluginId: c.pluginId, ref: c.ref, provider: entry.provider, code: "catalog-unreadable", message: `the catalog file could not be read as JSON (${err instanceof Error ? err.name : "error"})` });
        continue;
      }
    }
    entries.push({ record, input: { pluginId: c.pluginId, ref: c.ref, entry, catalog, trusted: isBundledClover(record) } });
  }
  return { entries, unreadable };
}

export interface ModelPluginSet extends CatalogFromModelPluginsResult {
  /** The read entries that made it, by provider id. */
  byProvider: Map<string, ReadModelEntry>;
  /** A digest of everything the catalog was built from. */
  digest: string;
}

/** The catalog of the enabled model plugins. Its version names the digest of what it was built from. */
export function buildModelPluginSet(read: ReadModelPlugins): ModelPluginSet {
  const sdk = loadCatalog();
  const digest = createHash("sha256").update(canonicalJson(read.entries.map((e) => e.input))).digest("hex");
  const built = catalogFromModelPlugins(read.entries.map((e) => e.input), { families: sdk.families, catalogVersion: `plugins.${digest.slice(0, 16)}`, upstream: sdk.upstream });
  const byProvider = new Map<string, ReadModelEntry>();
  for (const e of read.entries) if (built.adapters.get(e.input.entry.provider)?.pluginId === e.input.pluginId) byProvider.set(e.input.entry.provider, e);
  return { ...built, refused: [...read.unreadable, ...built.refused], byProvider, digest };
}
