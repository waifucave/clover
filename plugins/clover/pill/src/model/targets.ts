// Who the Dispatch pill messages (spec §10, the `pill.target` spot): every bot, then whatever plugins add to
// `pill.target` (a list spot whose entries have a title, lane B's catalog). The pill remembers the last one picked on
// this device and comes back to it; a target that went away falls back to the first bot. Pure, except the memory's
// default store, which reads and writes the layer's own storage and never fails the pill.

/** A bot, as `bots.read` lists it (lane B's `BotView`, the fields the pill reads). */
export interface PillBot {
  id: string;
  name: string;
  /** An image URL inside the bot's plugin. */
  portrait?: string;
  color?: string;
}

/** A `pill.target` entry, as the spot hands its declaring component the entries it shows (a question for lane B):
 *  the plugin, the entry's id, its title and icon. */
export interface PillTargetEntry {
  pluginId: string;
  /** The plugin's name, for the menu's muted words. */
  pluginName?: string;
  id: string;
  title: string;
  icon?: string;
  /** Position in the list spot; default 500, then the plugin id (§5.5). */
  order?: number;
}

export type TargetRef = { kind: "bot"; bot: string } | { kind: "plugin"; pluginId: string; entry: string };

/** One row of the pill's target menu. */
export interface ResolvedTarget {
  /** `bot:<id>` or `plugin:<plugin>#<entry>`: one namespace, so a bot and an entry never collide. */
  id: string;
  ref: TargetRef;
  name: string;
  portrait?: string;
  color?: string;
  /** Muted words after the name: the plugin a target comes from. */
  detail?: string;
}

export function targetId(ref: TargetRef): string {
  return ref.kind === "bot" ? `bot:${ref.bot}` : `plugin:${ref.pluginId}#${ref.entry}`;
}

/** Bots first, in the order the user keeps them; then the plugins' targets in the spot's order (`order`, then the
 *  plugin id, then the title). */
export function pillTargets(bots: readonly PillBot[], entries: readonly PillTargetEntry[]): ResolvedTarget[] {
  const fromBots = bots.map((b): ResolvedTarget => {
    const ref: TargetRef = { kind: "bot", bot: b.id };
    return { id: targetId(ref), ref, name: b.name, portrait: b.portrait, color: b.color };
  });
  const fromPlugins = [...entries]
    .sort((a, b) => (a.order ?? 500) - (b.order ?? 500) || a.pluginId.localeCompare(b.pluginId) || a.title.localeCompare(b.title))
    .map((e): ResolvedTarget => {
      const ref: TargetRef = { kind: "plugin", pluginId: e.pluginId, entry: e.id };
      return { id: targetId(ref), ref, name: e.title, portrait: e.icon, detail: e.pluginName ?? e.pluginId };
    });
  return [...fromBots, ...fromPlugins];
}

/** The target to show: the remembered one while it exists, else the first bot, else the first target. */
export function chooseTarget(targets: readonly ResolvedTarget[], remembered: string | null): ResolvedTarget | null {
  return targets.find((t) => t.id === remembered) ?? targets.find((t) => t.ref.kind === "bot") ?? targets[0] ?? null;
}

/** Where the pill keeps the last target picked on this device. */
export interface TargetMemory {
  get(): string | null;
  set(id: string): void;
}

const KEY = "clover.pill.target";

/** The layer's own storage; a private window or blocked storage only means the pill forgets. */
export function storageMemory(storage: () => Storage | undefined = () => globalThis.localStorage): TargetMemory {
  let fallback: string | null = null;
  return {
    get() {
      try {
        return storage()?.getItem(KEY) ?? fallback;
      } catch {
        return fallback;
      }
    },
    set(id) {
      fallback = id;
      try {
        storage()?.setItem(KEY, id);
      } catch {
        // Forgotten at the next start: nothing else depends on it.
      }
    },
  };
}

export function memoryOf(initial: string | null = null): TargetMemory {
  let value = initial;
  return { get: () => value, set: (id) => void (value = id) };
}
