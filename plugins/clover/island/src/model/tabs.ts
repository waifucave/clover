// Which tab the open island shows (Winter's `IslandTabState`). In Clover the island's tabs are entries of
// the `island.tab` point it declares (spec §5.4); Needs you ships as its own default guest. Pure.

import { t } from "../strings";

export interface IslandTab {
  id: string;
  title: string;
}

export const NEEDS_YOU: IslandTab = { id: "needs-you", title: t("clover.island.needsYou") };

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
