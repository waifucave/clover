// A stand-in for the plugin API's `browser` member, for the tests and the gallery: no browser, no network, no window.
// It keeps tabs in memory, answers like lane B's contract says (`show` moves a tab to the view, `hide` back to headless,
// `navigate` changes its address), and writes every call down so a test can say what was asked, in order.
import type { BrowserApi, TabOwner, TabView, Viewport } from "../client/types";
import { tabView } from "./fixtures";

export interface Call {
  method: string;
  args: unknown[];
}

export interface FakeBrowser extends BrowserApi {
  /** Every call so far, in order. */
  readonly calls: Call[];
  /** The calls of one kind. */
  of(method: string): unknown[][];
  /** The tabs it holds now. */
  readonly all: TabView[];
  /** The listeners `watch` has now. */
  readonly watchers: number;
  /** Tells every watcher a tab changed (and keeps it, as the browser would). */
  emit(tab: TabView): void;
  /** Makes the next call of `method` (`"cdp:Page.reload"` for one DevTools method) fail with `message`. */
  failNext(method: string, message: string): void;
  /** What `Page.getNavigationHistory` answers, per tab. */
  history: Record<string, { currentIndex: number; entries: { id: number; url: string }[] }>;
}

const sameOwner = (a: TabOwner, b: TabOwner): boolean =>
  a.kind === "bot" ? b.kind === "bot" && a.bot === b.bot : a.kind === "session" ? b.kind === "session" && a.session === b.session : a.kind === "plugin" ? b.kind === "plugin" && a.plugin === b.plugin : b.kind === "user";

export function fakeBrowser(initial: TabView[] = [], opts: { shows?: boolean } = {}): FakeBrowser {
  const shows = opts.shows ?? true;
  let tabs = [...initial];
  let next = 1;
  const calls: Call[] = [];
  const watchers = new Set<(tab: TabView) => void>();
  const failures = new Map<string, string>();
  const history: FakeBrowser["history"] = {};

  const record = (method: string, args: unknown[], failKey = method) => {
    calls.push({ method, args });
    const message = failures.get(failKey);
    if (message !== undefined) {
      failures.delete(failKey);
      throw new Error(message);
    }
  };
  const find = (id: string): TabView => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) throw new Error(`No tab ${id}`);
    return tab;
  };
  const put = (tab: TabView): TabView => {
    tabs = tabs.map((t) => (t.id === tab.id ? tab : t));
    return tab;
  };

  return {
    calls,
    of: (method) => calls.filter((c) => c.method === method).map((c) => c.args),
    get all() {
      return tabs;
    },
    get watchers() {
      return watchers.size;
    },
    history,
    emit(tab) {
      tabs = tabs.some((t) => t.id === tab.id) ? tabs.map((t) => (t.id === tab.id ? tab : t)) : [...tabs, tab];
      for (const w of [...watchers]) w(tab);
    },
    failNext(method, message) {
      failures.set(method, message);
    },
    async tabs(filter) {
      record("tabs", [filter]);
      return tabs.filter((t) => !filter?.owner || sameOwner(t.owner, filter.owner));
    },
    async open(o) {
      record("open", [o]);
      const tab = tabView(`t${next++}`, { owner: o.owner, url: o.url ?? "about:blank", place: o.show ? "shown" : "headless", ...(o.show ? { viewport: o.show.viewport } : {}) });
      tabs = [...tabs, tab];
      return tab;
    },
    async close(id) {
      record("close", [id]);
      find(id);
      tabs = tabs.filter((t) => t.id !== id);
    },
    async navigate(id, url) {
      record("navigate", [id, url]);
      return put({ ...find(id), url });
    },
    async show(id, view, viewport: Viewport) {
      record("show", [id, view, viewport]);
      const tab = find(id);
      return put(shows ? { ...tab, place: "shown", viewport } : tab);
    },
    async hide(id) {
      record("hide", [id]);
      return put({ ...find(id), place: "headless", viewport: { width: 1280, height: 800 } });
    },
    async cdp<R>(id: string, method: string, params?: Record<string, unknown>) {
      record("cdp", [id, method, params], `cdp:${method}`);
      find(id);
      if (method === "Page.getNavigationHistory") {
        const h = history[id] ?? { currentIndex: 0, entries: [{ id: 1, url: find(id).url }] };
        return h as R;
      }
      return {} as R;
    },
    async screenshot(id, opts) {
      record("screenshot", [id, opts]);
      find(id);
      // A 1×1 JPEG: enough for an <img> to have something to show.
      return { format: "jpeg", data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=", width: 1280, height: 800, takenAt: Date.now() };
    },
    watch(listener) {
      record("watch", []);
      watchers.add(listener);
      return () => {
        watchers.delete(listener);
        calls.push({ method: "unwatch", args: [] });
      };
    },
  };
}
