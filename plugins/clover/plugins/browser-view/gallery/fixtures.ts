import type { BrowserTab, TabView } from "../client/types";

/** Tabs as the row draws them. */
export const TABS: BrowserTab[] = [
  { id: "b1", title: "Docs preview", url: "http://localhost:4321/docs/" },
  { id: "b2", title: "Plugin index", url: "https://plugins.clover.dev/" },
];

/** A tab as the browser reports it: a bot's, headless, at the agent's own size, unless `over` says otherwise. */
export function tabView(id: string, over: Partial<TabView> = {}): TabView {
  return {
    id,
    computer: "Studio",
    owner: { kind: "bot", bot: "alpha" },
    partition: "persist:bot-alpha",
    url: "about:blank",
    title: "",
    place: "headless",
    viewport: { width: 1280, height: 800 },
    loading: false,
    heldByUser: false,
    ...over,
  };
}

/** The same two tabs, as the browser reports them. */
export const TAB_VIEWS: TabView[] = [
  tabView("b1", { title: "Docs preview", url: "http://localhost:4321/docs/" }),
  tabView("b2", { title: "Plugin index", url: "https://plugins.clover.dev/" }),
];
