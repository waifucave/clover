// Which tab the open island shows (the Swift reference's `IslandTabState`). In Clover the island's tabs are entries of
// the `island.tab` point it declares (spec §5.4); Needs you ships as its own default guest. Pure.

import { t } from "../strings";

export interface IslandTab {
  id: string;
  title: string;
}

export const NEEDS_YOU: IslandTab = { id: "needs-you", title: t("clover.island.needsYou") };

/** The plugin the island and its own children belong to: their tabs are the island's own. */
export const OWN_PLUGIN = "clover";

/** An `island.tab` entry, as the spot hands it over. */
export interface GuestTab extends IslandTab {
  /** The plugin the entry comes from; absent counts as another plugin's. */
  pluginId?: string;
  pluginName?: string;
  /** Whether the tab may draw the user's eye (the spot's field); another plugin's never does. */
  attention?: "never" | "badge" | "expand";
}

function folded(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/** Needs you is the island's alone: no entry may take its id or its title, in any case or width. */
export function isReservedTab(tab: IslandTab): boolean {
  return folded(tab.id) === NEEDS_YOU.id || folded(tab.title) === folded(NEEDS_YOU.title);
}

/**
 * The tabs beside Needs you, as the island shows them: an entry claiming Needs you's id or title is left out; another
 * plugin's tab is titled with its plugin's name ("Servers · Homelab"), never raises attention, and is keyed by its
 * plugin so two plugins' `servers` stay two tabs.
 */
export function guestTabs<T extends GuestTab>(entries: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (isReservedTab(e)) continue;
    const own = e.pluginId === OWN_PLUGIN;
    const tab: T = own
      ? e
      : { ...e, id: `${e.pluginId ?? "plugin"}#${e.id}`, title: t("clover.island.pluginTab", { title: e.title, plugin: e.pluginName ?? e.pluginId ?? t("clover.island.aPlugin") }), attention: "never" };
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
