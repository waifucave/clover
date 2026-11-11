// A fake plugin API for Alpha's server: an in-memory store, the messages sent to her tab, settings, and her scenes
// point's entries; and timers the test runs by hand.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { StageApi } from "../store";

export const ALPHA = join(import.meta.dir, "..", "..");

export function fakeApi(o: { settings?: Record<string, unknown>; scenes?: { pluginId: string; value: Record<string, unknown> }[] } = {}) {
  const store = new Map<string, unknown>();
  const sent: { event: string; data: unknown }[] = [];
  const writes: string[] = [];
  const api: StageApi & { settings: { get(key: string): Promise<unknown> }; plugin: { id: string } } = {
    plugin: { id: "alpha" },
    storage: {
      synced: {
        get: async (k) => structuredClone(store.get(k)),
        set: async (k, v) => { writes.push(k); store.set(k, structuredClone(v)); },
      },
    },
    ui: { send: (event, data) => void sent.push({ event, data: structuredClone(data) }) },
    settings: { get: async (k) => o.settings?.[k] },
    points: { entries: async () => o.scenes ?? [] },
  };
  return { api, store, sent, writes };
}

export function diskReader(dir: string) {
  const at = (p: string) => join(dir, ...p.split("/"));
  return {
    readText: (p: string) => (existsSync(at(p)) && statSync(at(p)).isFile() ? readFileSync(at(p), "utf8") : undefined),
    exists: (p: string) => existsSync(at(p)),
    listDirs: (p: string) => (existsSync(at(p)) ? readdirSync(at(p), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []),
    insideFolder: (p: string) => {
      const real = realpathSync(at(p));
      const root = realpathSync(dir);
      return real === root || real.startsWith(root + sep);
    },
  };
}
