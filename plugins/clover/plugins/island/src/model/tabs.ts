// Which tab the open island shows (the Swift reference's `IslandTabState`). In Clover the island's tabs are entries of
// the `island.tab` point it declares (spec §5.4); Needs you ships as its own default guest. Pure.

import { english, t } from "../strings";
import { readsAs, shownName } from "./names";

export interface IslandTab {
  id: string;
  title: string;
}

/** Needs you: its title in the user's language, read each time (the language can change while the island runs). */
export const NEEDS_YOU: IslandTab = {
  id: "needs-you",
  get title() {
    return t("clover.island.needsYou");
  },
};

/** The plugin the island and its own children belong to: their tabs are the island's own. */
export const OWN_PLUGIN = "clover";

/** Whether a plugin id is the bundled `clover` tree's: `clover` itself, or a child, which lane B ids
 *  `clover/<folder>` (`clover/usage`, `clover/island`). */
export function isOwnPlugin(pluginId: string | undefined): boolean {
  return pluginId === OWN_PLUGIN || (pluginId?.startsWith(`${OWN_PLUGIN}/`) ?? false);
}

/** An `island.tab` entry, as the spot hands it over. */
export interface GuestTab extends IslandTab {
  /** The plugin the entry comes from; absent counts as another plugin's. */
  pluginId?: string;
  pluginName?: string;
  /** Whether the tab may draw the user's eye (the spot's field); another plugin's never does. */
  attention?: "never" | "badge" | "expand";
}

/** Names no other plugin's tab may carry, as its title or as its plugin's name beside it: Needs you is the island's
 *  own, and Clover is the app's. */
/** In English and in the user's language: a tab can't take either. */
const reservedTitles = () => [english("clover.island.needsYou"), NEEDS_YOU.title];
const reservedPluginNames = () => [...reservedTitles(), "Clover"];

/** Needs you is the island's alone: no entry may take its id or its title, as a reader sees them (`readsAs`: case,
 *  width, accents, invisible characters and lookalike letters folded). */
export function isReservedTab(tab: IslandTab): boolean {
  return readsAs(tab.id, NEEDS_YOU.id) || reservedTitles().some((r) => readsAs(tab.title, r));
}

/** A plugin name the island won't put beside a tab: it would read as Needs you's or as the app's own. */
export function isReservedPluginName(name: string): boolean {
  return reservedPluginNames().some((r) => readsAs(name, r));
}

/**
 * The tabs beside Needs you, as the island shows them: an entry claiming Needs you's id or title is left out, and so
 * is another plugin's tab whose plugin is named as Needs you, as Clover or as one of the bots ("Servers · Alpha" would
 * read as Alpha's); another plugin's tab is titled with its
 * plugin's name ("Servers · Homelab", bidi controls out), never raises attention, and is keyed by its plugin so two
 * plugins' `servers` stay two tabs.
 */
export function guestTabs<T extends GuestTab>(entries: readonly T[], botNames: readonly string[] = []): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (isReservedTab(e)) continue;
    const own = isOwnPlugin(e.pluginId);
    let tab: T = e;
    if (!own) {
      const plugin = shownName(e.pluginName ?? e.pluginId ?? "");
      if (plugin && (isReservedPluginName(plugin) || botNames.some((b) => readsAs(plugin, b)))) continue;
      const title = shownName(e.title);
      tab = { ...e, id: `${e.pluginId ?? "plugin"}#${e.id}`, title: t("clover.island.pluginTab", { title, plugin: plugin || t("clover.island.aPlugin") }), attention: "never" };
    }
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    out.push(tab);
  }
  return out;
}

export interface TabState {
  tabs: readonly IslandTab[];
  selected: number;
}

export function tabState(tabs: readonly IslandTab[], selected = 0): TabState {
  return { tabs, selected: tabs.length === 0 ? 0 : Math.min(Math.max(selected, 0), tabs.length - 1) };
}

export function selectedTab(state: TabState): IslandTab | null {
  return state.tabs[state.selected] ?? null;
}

/** Dots only when there is somewhere to go. */
export function showsDots(state: TabState): boolean {
  return state.tabs.length > 1;
}

/** Fingers to the LEFT show the next tab (the content moves with them), to the RIGHT the previous. No wrap. */
export function swipe(state: TabState, direction: "left" | "right"): TabState {
  const next = direction === "left" ? state.selected + 1 : state.selected - 1;
  return next >= 0 && next < state.tabs.length ? { ...state, selected: next } : state;
}

export function select(state: TabState, id: string): TabState {
  const i = state.tabs.findIndex((t) => t.id === id);
  return i < 0 || i === state.selected ? state : { ...state, selected: i };
}
