// The other folders plugin code loads from, per Clover home (#234's check 5, K3): the plugin registry's development
// folders and bundled plugins, which `openPluginRegistry` registers, read live by `selfGrantDenyWrite` for the fence's
// `node_modules` denies (`pluginLoadDenies`). Its own module, so the registry needn't import the sandbox's.
import { resolve } from "node:path";

const sources = new Map<string, () => readonly string[]>();

/** Registers where else plugin code loads from for `home`. Returns the unregister. */
export function registerPluginLoadFolders(home: string, folders: () => readonly string[]): () => void {
  const key = resolve(home);
  sources.set(key, folders);
  return () => {
    if (sources.get(key) === folders) sources.delete(key);
  };
}

/** The folders registered for `home`, now. */
export function pluginLoadFoldersOf(home: string): readonly string[] {
  return sources.get(resolve(home))?.() ?? [];
}
