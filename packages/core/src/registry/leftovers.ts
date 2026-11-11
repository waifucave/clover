// What a plugin leaves when it goes: its secrets, its settings and synced store, its secret files and its data folder.
// `plugin.remove` forgets them at once (`forgetRemovedPlugin`). A folder that goes any other way (deleted by hand, or by
// a sync) leaves them, with a small "left by" record in the MAC'd state (the controller's ruling, 2026-11-11); deleting
// nothing yet. The controller's amended rule: a forget happens only (a) in `plugin.remove`, or (b) when a tree comes
// under an id that HAS a left-by record and its tree and source both differ (another tree hash; another index, by URL
// and its signing keys, or another npm package; a local or wrapped plugin is the same only by its tree). Then it is
// forgotten first, before the new tree is put, and a forget that fails stops it with the reason. With no record,
// nothing is forgotten, ever: records read as empty (a bad MAC, a counter rolled back, a missing key, a home restored
// from a backup) must never cost a plugin its keys. And while the records weren't trusted at start, no left-by record
// is written that run. Accepted residual: what a plugin left in a home from before these records, with no record, stays
// for whatever tree next comes under its id (it asks for its OK as any new tree does).
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginProvenance } from "@waifucave/clover-protocol";
import { ContractError } from "../contracts/common";
import type { PluginRecord } from "../contracts/plugin-registry";
import type { SecretStore } from "../contracts/secret-store";
import { pluginPath } from "../plugin-host/paths";
import type { IndexClient } from "./indexes/client";
import { PluginSecretFiles } from "./secret-files";

/** What removing a plugin leaves behind, and where (#332's review): its secrets, its settings file and its synced store
 *  are deleted, for it and each of its children, so a later plugin installed under the same id inherits none of them.
 *  Its data folder is kept, as the spec says (§5.4), but moved out of the id's path to
 *  `<home>/plugin-data/.removed/<id>/<when>-<tree hash>/`, keyed to that install, so another publisher's plugin with
 *  the same id starts with an empty one. No plugin id starts with a dot. */
export async function forgetRemovedPlugin(o: { home: string; secrets?: Pick<SecretStore, "list" | "delete">; record: Pick<PluginRecord, "id" | "source" | "treeHash" | "okHash" | "provenance">; children: readonly string[]; now?: () => number }): Promise<{ dataKeptAt?: string }> {
  const ids = [o.record.id, ...o.children];
  for (const pluginId of ids) {
    if (o.secrets !== undefined) for (const meta of await o.secrets.list({ kind: "plugin", pluginId })) await o.secrets.delete(meta.ref);
    rmSync(`${pluginPath(join(o.home, "settings", "plugins"), pluginId)}.json`, { force: true });
    rmSync(`${pluginPath(join(o.home, "settings", "plugin-stores"), pluginId)}.json`, { force: true });
  }
  // Its secrets' files (`${secretFile:…}`) go with it.
  new PluginSecretFiles(o.home).releasePlugin(o.record.id);
  const data = pluginPath(join(o.home, "plugin-data"), o.record.id);
  if (!existsSync(data)) return {};
  const hash = (o.record.okHash ?? o.record.treeHash ?? "unknown").replace(/^sha256:/, "").slice(0, 16);
  const kept = join(o.home, "plugin-data", ".removed", ...o.record.id.split("/"), `${new Date(o.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, "-")}-${hash}`);
  mkdirSync(join(kept, ".."), { recursive: true, mode: 0o700 });
  renameSync(data, kept);
  writeFileSync(join(kept, ".clover-removed.json"), JSON.stringify({ id: o.record.id, source: o.record.source, treeHash: o.record.treeHash, okHash: o.record.okHash, provenance: o.record.provenance, removedAt: o.now?.() ?? Date.now() }), { mode: 0o600 });
  return { dataKeptAt: kept };
}


/** Whether two provenances are the same source and identity: the same index URL with at least one of its signing keys
 *  in common (the same URL with all-new keys is another source), or the same npm package (the owner's call, on the
 *  sign-off list). A local folder or a wrapped item is never: only its tree hash says it is the same. */
export function sameSource(a: PluginProvenance | undefined, b: PluginProvenance | undefined, keys: { a?: readonly string[]; b?: readonly string[] } = {}): boolean {
  if (a?.index !== undefined || b?.index !== undefined) {
    if (a?.index === undefined || b?.index === undefined || a.index.url !== b.index.url) return false;
    return (keys.a ?? []).some((k) => (keys.b ?? []).includes(k));
  }
  if (a?.npm !== undefined || b?.npm !== undefined) return a?.npm !== undefined && b?.npm !== undefined && a.npm.name === b.npm.name;
  return false;
}

export class Leftovers {
  readonly #o: { home: string; secrets?: Pick<SecretStore, "list" | "delete">; client: IndexClient; trusted?: () => boolean; now?: () => number; log?: (line: string) => void };
  /** The ids settled since they last went away, in this run: a folder read again before its install's record lands
   *  (the watcher's read beside `plugin.install`'s) isn't settled twice, so a wrapper's keys just stored stay. */
  readonly #settled = new Set<string>();
  #untrustedSaid = false;

  /** `trusted`: whether the records read at start were trusted (no bad MAC, no counter rolled back); false, no left-by
   *  record is written this run. */
  constructor(o: { home: string; secrets?: Pick<SecretStore, "list" | "delete">; client: IndexClient; trusted?: () => boolean; now?: () => number; log?: (line: string) => void }) {
    this.#o = o;
  }

  settled(id: string): boolean {
    return this.#settled.has(id);
  }

  /** The index's signing keys this computer trusts now, for a provenance from an index. */
  #keysOf(p: PluginProvenance | undefined): string[] | undefined {
    const url = p?.index?.url;
    return url === undefined ? undefined : [...(this.#o.client.trusts().find((t) => t.url === url)?.keys ?? [])];
  }

  /** A plugin's folder went without `plugin.remove`: what it leaves stays, recorded. Not while an update of it is coming
   *  up (its previous version is kept and comes back), and not in a run whose records weren't trusted. */
  left(r: Pick<PluginRecord, "id" | "source" | "treeHash" | "okHash" | "provenance">, children: readonly string[]): void {
    this.#settled.delete(r.id);
    if (this.#o.client.updating()[r.id] !== undefined) return;
    if (this.#o.trusted?.() === false) {
      if (!this.#untrustedSaid) this.#o.log?.("plugins: the records weren't trusted at start (changed outside Clover, or an older copy put back), so no plugin's leftovers are recorded this run; nothing is deleted");
      this.#untrustedSaid = true;
      return;
    }
    const keys = this.#keysOf(r.provenance);
    this.#o.client.setLeftBy(r.id, {
      source: r.source, provenance: r.provenance as Record<string, unknown>, at: (this.#o.now ?? Date.now)(), children: [...children],
      ...(r.treeHash !== undefined ? { treeHash: r.treeHash } : {}), ...(r.okHash !== undefined ? { okHash: r.okHash } : {}),
      ...(keys !== undefined ? { keys } : {}),
    });
  }

  /** `plugin.remove` forgot what it left: nothing to record. */
  cleared(id: string): void {
    this.#settled.delete(id);
    if (this.#o.client.leftBy(id) !== undefined) this.#o.client.setLeftBy(id, undefined);
  }

  /** A tree comes under `id`: with a left-by record whose tree and source both differ, what was left is forgotten first
   *  (it and the children the record names); otherwise nothing is touched. Throws when the forget fails (a key that
   *  can't be deleted): the tree isn't put. */
  async settle(id: string, incoming: { treeHash?: string; provenance: PluginProvenance }): Promise<void> {
    // Settled already in this run (a wrapper settles before storing its keys, then again as its folder lands).
    if (this.#settled.has(id)) return;
    const rec = this.#o.client.leftBy(id);
    this.#settled.add(id);
    // No record: nothing is forgotten, ever (the amended rule).
    if (rec === undefined) return;
    const prov = rec.provenance as PluginProvenance;
    const same = (rec.treeHash !== undefined && rec.treeHash === incoming.treeHash)
      || sameSource(prov, incoming.provenance, { a: rec.keys ?? [], b: this.#keysOf(incoming.provenance) ?? [] });
    if (same) {
      this.#o.client.setLeftBy(id, undefined);
      return;
    }
    try {
      await forgetRemovedPlugin({
        home: this.#o.home, ...(this.#o.secrets !== undefined ? { secrets: this.#o.secrets } : {}), children: rec.children,
        record: { id, source: rec.source as PluginRecord["source"], treeHash: rec.treeHash, okHash: rec.okHash, provenance: prov },
        ...(this.#o.now ? { now: this.#o.now } : {}),
      });
    } catch (err) {
      this.#settled.delete(id);
      throw new ContractError("failed", `what the plugin removed earlier under ${id} left (its keys, settings and data) couldn't be cleared for this one: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
    this.#o.client.setLeftBy(id, undefined);
    this.#o.log?.(`plugins: ${id} comes from another source than the plugin that left its keys, settings and data; they were cleared (its data kept under plugin-data/.removed)`);
  }
}
