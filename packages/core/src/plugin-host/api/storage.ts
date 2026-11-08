// Storage (spec §5.4 "Storage"): each plugin's data folder on each computer and its synced store.
//
// * The data folder is `<home>/plugin-data/<id>/` (a child's under its parent's, `plugin-data/clover/web/`), never
//   synced, kept when the plugin is removed, and fenced from bots' writes (§9.1, the fence's `plugin-data`). The core
//   makes it (0700) when a host half asks for it.
// * The synced store holds up to 1 MB of JSON per plugin (`SYNCED_STORE_LIMIT_BYTES`, counted as UTF-8 of the whole
//   store), keyed by strings of at most 256 characters. It sits in the fenced settings folder
//   (`<home>/settings/plugin-stores/`), never in the plugin's folder or its data folder: a plugin's own `stdio`
//   server can write its data folder, and the store is where add-on hashes a user OK'd live (§5.4 "Add-ons"). Lane H
//   syncs these files with the account's settings; here they are this computer's copy.
// * A plugin reaches only its own store and folder: the plugin is the one the host stamped (review S3), never one an
//   argument names.
import { SYNCED_STORE_LIMIT_BYTES } from "@waifucave/clover-plugin-sdk";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ContractError, Listeners, type Unsubscribe } from "../../contracts/common";
import { listenerArg, stringArg, type ApiHandlers } from "./router";
import { pluginDataFolder, pluginPath } from "../paths";

export { pluginDataFolder, pluginPath };

export interface SyncedStoreBackend {
  read(pluginId: string): Record<string, unknown>;
  write(pluginId: string, values: Record<string, unknown>): void;
}

/** The store files under `<home>/settings/plugin-stores/<id>.json`, written whole through a temp file. */
export function fileSyncedStores(cloverHome: string): SyncedStoreBackend {
  const file = (id: string) => `${pluginPath(join(cloverHome, "settings", "plugin-stores"), id)}.json`;
  return {
    read(id) {
      const f = file(id);
      if (!existsSync(f)) return {};
      try {
        const v = JSON.parse(readFileSync(f, "utf8"));
        return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
      } catch {
        return {};
      }
    },
    write(id, values) {
      const f = file(id);
      mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(values), { mode: 0o600 });
      renameSync(tmp, f);
    },
  };
}

export function memorySyncedStores(): SyncedStoreBackend & { data: Map<string, Record<string, unknown>> } {
  const data = new Map<string, Record<string, unknown>>();
  return { data, read: (id) => structuredClone(data.get(id) ?? {}), write: (id, v) => void data.set(id, structuredClone(v)) };
}

/** JSON data only: what the store keeps is what comes back, on every computer. */
function jsonValue(value: unknown): unknown {
  if (value === undefined) throw new ContractError("invalid", "the synced store takes JSON values; delete a key instead of storing undefined");
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (text === undefined) throw new ContractError("invalid", "the synced store takes JSON values");
  const back = JSON.parse(text);
  if (!sameJson(back, value)) throw new ContractError("invalid", "the synced store takes JSON values (no bytes, dates, maps or undefined)");
  return back;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (!Array.isArray(b) && Object.getPrototypeOf(b) !== Object.prototype) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export class SyncedStores {
  readonly #backend: SyncedStoreBackend;
  readonly #listeners = new Map<string, Listeners<string>>();

  constructor(backend: SyncedStoreBackend) {
    this.#backend = backend;
  }

  get(pluginId: string, key: string): unknown {
    const values = this.#backend.read(pluginId);
    return Object.hasOwn(values, key) ? values[key] : undefined;
  }

  set(pluginId: string, key: string, value: unknown): void {
    const values = this.#backend.read(pluginId);
    values[key] = jsonValue(value);
    const size = new TextEncoder().encode(JSON.stringify(values)).length;
    if (size > SYNCED_STORE_LIMIT_BYTES) throw new ContractError("refused", `the synced store holds up to ${SYNCED_STORE_LIMIT_BYTES} bytes; this would make it ${size}`);
    this.#backend.write(pluginId, values);
    this.#listeners.get(pluginId)?.emit(key);
  }

  delete(pluginId: string, key: string): void {
    const values = this.#backend.read(pluginId);
    if (!Object.hasOwn(values, key)) return;
    delete values[key];
    this.#backend.write(pluginId, values);
    this.#listeners.get(pluginId)?.emit(key);
  }

  keys(pluginId: string): string[] {
    return Object.keys(this.#backend.read(pluginId)).sort();
  }

  /** A key changed, here or (once lane H syncs it) from another computer: `changed` tells the listeners. */
  watch(pluginId: string, fn: (key: string) => void): Unsubscribe {
    let l = this.#listeners.get(pluginId);
    if (l === undefined) this.#listeners.set(pluginId, (l = new Listeners<string>()));
    return l.add(fn);
  }

  changed(pluginId: string, key: string): void {
    this.#listeners.get(pluginId)?.emit(key);
  }
}

export function storageApi(stores: SyncedStores): ApiHandlers {
  const key = (args: readonly unknown[]) => stringArg(args, 0, "a store key");
  return {
    "storage.synced.get": (ctx, args) => stores.get(ctx.pluginId, key(args)),
    "storage.synced.set": (ctx, args) => void stores.set(ctx.pluginId, key(args), args[1]),
    "storage.synced.delete": (ctx, args) => void stores.delete(ctx.pluginId, key(args)),
    "storage.synced.keys": (ctx) => stores.keys(ctx.pluginId),
    "storage.synced.watch": (ctx, args) => stores.watch(ctx.pluginId, listenerArg<string>(args, 0)),
  };
}
