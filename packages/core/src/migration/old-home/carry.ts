// The old plugin registry's records, carried (ruling 5). They are MAC'd with a key in the old secret store, which MOSS
// never reads, so none of them can be verified here; copied as files, each would read as changed outside MOSS and every
// plugin would ask again, its switches lost. So the copy takes from them only what no one gains by forging, maps the
// ids, and this engine writes it through the registry's own store with ITS key, as any write of the registry would:
//
//   * the order of the list, each plugin's switch (`enabled`) and its "parts beside its bot" switch (`appParts`), and
//     the one-at-a-time picks: a parked plugin stays parked, one switched off stays off;
//   * never an OK: a hash the user approved (`okHash`), a refusal, a held card, a dev folder, an OK snapshot, the adult
//     confirmation, the added indexes or a picked file's grant. A third-party plugin (whose tree the copy changed
//     anyway) asks for its OK again on the normal card; a bundled plugin approves itself.
//
// Applied once, when the registry first opens after the swap (`applyCarry`, called from `registry/open.ts`'s caller),
// over what the fresh home's registry already holds; the carry file is removed after.
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { RegistryStateFile, RegistryStore } from "../../registry/state";
import { mapPluginId, mapPointName } from "./names";
import { oldHomePaths } from "./paths";

export interface RegistryCarry {
  v: 1;
  order: string[];
  plugins: Record<string, { enabled?: boolean; appParts?: false }>;
  active: Record<string, { pluginId: string; entryId: string }>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}(?:\/[a-z0-9][a-z0-9-]{0,63})?$/;

/** The carry from the old `installed.json`'s text (its envelope's body, unverified), or an empty carry. */
export function carryFromOldRegistry(text: string | undefined): RegistryCarry {
  const empty: RegistryCarry = { v: 1, order: [], plugins: {}, active: {} };
  if (text === undefined) return empty;
  let body: unknown;
  try {
    const env = JSON.parse(text) as { body?: unknown };
    body = typeof env?.body === "string" ? JSON.parse(env.body) : env;
  } catch {
    return empty;
  }
  const s = body as Partial<RegistryStateFile> | null;
  if (s === null || typeof s !== "object") return empty;
  const out = empty;
  if (Array.isArray(s.order)) for (const id of s.order.slice(0, 4096)) if (typeof id === "string" && ID.test(id)) out.order.push(mapPluginId(id));
  if (s.plugins !== null && typeof s.plugins === "object") {
    for (const [id, rec] of Object.entries(s.plugins).slice(0, 4096)) {
      if (!ID.test(id) || rec === null || typeof rec !== "object") continue;
      const r = rec as { enabled?: unknown; appParts?: unknown };
      const kept: { enabled?: boolean; appParts?: false } = {};
      if (typeof r.enabled === "boolean") kept.enabled = r.enabled;
      if (r.appParts === false) kept.appParts = false;
      if (Object.keys(kept).length > 0) out.plugins[mapPluginId(id)] = kept;
    }
  }
  if (s.active !== null && typeof s.active === "object" && s.active !== undefined) {
    for (const [point, pick] of Object.entries(s.active).slice(0, 1024)) {
      const p = pick as { pluginId?: unknown; entryId?: unknown } | null;
      if (p === null || typeof p !== "object" || typeof p.pluginId !== "string" || !ID.test(p.pluginId) || typeof p.entryId !== "string" || p.entryId.length > 256 || point.length > 256) continue;
      out.active[mapPointName(point)] = { pluginId: mapPluginId(p.pluginId), entryId: p.entryId };
    }
  }
  return out;
}

/** Writes a waiting carry through `store` (the registry's signed store) and removes it. Each carried switch and pick
 *  replaces the fresh home's; order: the carried ids first, in their order, then the fresh ones not among them. True
 *  when there was one. */
export function applyCarry(home: string, store: Pick<RegistryStore, "load" | "save">, log?: (line: string) => void): boolean {
  const file = oldHomePaths(home).carry;
  if (!existsSync(file)) return false;
  let carry: RegistryCarry;
  try {
    carry = JSON.parse(readFileSync(file, "utf8")) as RegistryCarry;
  } catch {
    rmSync(file, { force: true });
    log?.("old home: the registry's carried records didn't read; plugins keep this home's switches");
    return false;
  }
  const state = store.load();
  const order = [...new Set([...carry.order.filter((id) => ID.test(id)), ...state.order])];
  const plugins = { ...state.plugins };
  for (const [id, rec] of Object.entries(carry.plugins ?? {})) {
    if (!ID.test(id)) continue;
    const prev = plugins[id] ?? {};
    const next = { ...prev };
    if (typeof rec.enabled === "boolean") next.enabled = rec.enabled;
    if (rec.appParts === false) next.appParts = false;
    plugins[id] = next;
  }
  const active = { ...(state.active ?? {}), ...(carry.active ?? {}) };
  store.save({ ...state, order, plugins, ...(Object.keys(active).length > 0 ? { active } : {}) });
  rmSync(file, { force: true });
  log?.(`old home: carried ${Object.keys(carry.plugins ?? {}).length} plugin switches and ${Object.keys(carry.active ?? {}).length} picks into the registry, signed with this engine's key`);
  return true;
}
