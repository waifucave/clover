// The registry's changes as the protocol's plugin events (spec §5.1): `plugin_changed` on every transition of a
// plugin's state or switch, `plugin_removed` when its record goes, and `plugin_found` when a found plugin's OK card is
// raised. They carry ids and states only, never manifest text (and `plugin_found`'s folder is withheld from layers,
// `core-events.ts`). The registry's own `#update` is the one place its state changes, and its `watch` reports from
// there; this narrows that to what changed for the protocol (a reason alone isn't a transition here).
import type { PluginRecord, PluginRegistry } from "../contracts/plugin-registry";
import type { Unsubscribe } from "../contracts/common";

export interface RegistryEventsOptions {
  registry: Pick<PluginRegistry, "list" | "get" | "watch">;
  /** The registry core's OK cards, as they are raised (`RegistryCore.watchOkCards`). */
  okCards?: (fn: (raised: { id: string; card: string }) => void) => Unsubscribe;
  emit(event: { type: string; [key: string]: unknown }): void;
}

type Seen = Pick<PluginRecord, "state" | "enabled">;

/** Emits the plugin events from now on; what is there at the start is known, not announced. */
export function registryEvents(o: RegistryEventsOptions): () => void {
  const seen = new Map<string, Seen>();
  for (const r of o.registry.list()) seen.set(r.id, { state: r.state, enabled: r.enabled });
  const off = o.registry.watch((c) => {
    if (c.type === "entries") return;
    const r = c.type === "removed" ? undefined : o.registry.get(c.id);
    if (r === undefined) {
      if (seen.delete(c.id)) o.emit({ type: "plugin_removed", id: c.id });
      return;
    }
    const was = seen.get(r.id);
    if (was !== undefined && was.state === r.state && was.enabled === r.enabled) return;
    seen.set(r.id, { state: r.state, enabled: r.enabled });
    o.emit({ type: "plugin_changed", id: r.id, state: r.state, enabled: r.enabled });
  });
  const offCards = o.okCards?.(({ id, card }) => {
    const r = o.registry.get(id);
    if (r === undefined || r.parent !== undefined || r.state !== "found") return;
    o.emit({ type: "plugin_found", id, folder: r.folder, card });
  });
  return () => {
    off();
    offCards?.();
  };
}
