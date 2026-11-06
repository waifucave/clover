// Who the Dispatch pill messages (spec §10, the `pill.target` spot): every bot, then whatever plugins add to
// `pill.target` (a list spot whose entries have a title, lane B's catalog). The pill remembers the last one picked on
// this device and comes back to it; a target that went away falls back to the first bot. Pure, except the memory's
// default store, which reads and writes the layer's own storage and never fails the pill.

import { readsAs, shownName } from "@waifucave/clover-plugin-island/names";

/** A bot, as `bots.read` lists it (lane B's `BotView`, the fields the pill reads). */
export interface PillBot {
  id: string;
  name: string;
  /** An image URL inside the bot's plugin. */
  portrait?: string;
  color?: string;
}

/** A `pill.target` entry, as `useSpotEntries` lists it for the pill (lane B's `SpotEntryView`): its ref, the plugin,
 *  the entry's id, its title and icon. */
export interface PillTargetEntry {
  /** The entry's ref (`SpotEntryView.ref`): what `useUserSend` takes as `{ target }`. */
  ref: string;
  pluginId: string;
  /** The plugin's name, for the menu's muted words. */
  pluginName?: string;
  id: string;
  title: string;
  icon?: string;
  /** Position in the list spot; default 500, then the plugin id (§5.5). */
  order?: number;
}

export type TargetRef = { kind: "bot"; bot: string } | { kind: "plugin"; pluginId: string; entry: string; ref: string };

/** Where `useUserSend` sends (lane B's `UserSendTarget`, mirrored): a bot by id, or a `pill.target` entry by its ref. */
export type UserSendTarget = { bot: string } | { target: string } | { session: string };

export function userSendTarget(ref: TargetRef): UserSendTarget {
  return ref.kind === "bot" ? { bot: ref.bot } : { target: ref.ref };
}

/** Whether two names read the same: the island's skeleton (`readsAs`: case, width, accents, invisible characters,
 *  spaces and lookalike letters folded), so "Ꮮuna" or "Lu\u200Bna" is Luna. */
export function sameName(a: string, b: string): boolean {
  return readsAs(a, b);
}

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
  /** What the compact pill calls it: a plugin's target carries its plugin's name ("Lights · Home"), so an entry can
   *  never read as a bot. */
  label?: string;
}

export function targetId(ref: TargetRef): string {
  return ref.kind === "bot" ? `bot:${ref.bot}` : `plugin:${ref.pluginId}#${ref.entry}`;
}

/** Bots first, in the order the user keeps them; then the plugins' targets in the spot's order (`order`, then the
 *  plugin id, then the title). An entry titled as one of the bots is left out: "Message Alpha" means the bot. */
export function pillTargets(bots: readonly PillBot[], entries: readonly PillTargetEntry[]): ResolvedTarget[] {
  const fromBots = bots.map((b): ResolvedTarget => {
    const ref: TargetRef = { kind: "bot", bot: b.id };
    return { id: targetId(ref), ref, name: b.name, portrait: b.portrait, color: b.color };
  });
  const fromPlugins = entries
    .filter((e) => !bots.some((b) => sameName(b.name, e.title) || sameName(b.id, e.title)))
    .sort((a, b) => (a.order ?? 500) - (b.order ?? 500) || a.pluginId.localeCompare(b.pluginId) || a.title.localeCompare(b.title))
    .map((e): ResolvedTarget => {
      const ref: TargetRef = { kind: "plugin", pluginId: e.pluginId, entry: e.id, ref: e.ref };
      const plugin = shownName(e.pluginName ?? "") || e.pluginId;
      const title = shownName(e.title);
      return { id: targetId(ref), ref, name: title, portrait: e.icon, detail: plugin, label: `${title} · ${plugin}` };
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
