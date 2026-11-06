// The browser panel: what fills the `panel` spot keyed `browser`. It drives the plugin API's `browser` member (lane B's
// `BrowserApi`, which needs the `browser` capability) and draws the tab row, the toolbar and the frame the browser's
// live view fills (the parts are `BrowserTabs` and `BrowserChrome`; this container holds the state and the calls).
//
// Whose tabs. A bot's tab shows that bot's tabs, a coding session's panel that session's own (ruling R10: a session
// without a bot has a partition of its own; the person's is never a session's by default), and a panel of neither the
// person's own tabs (spec §12.1: never per site). Lane B's `panel` spot hands `{ app, session? }`; this panel also
// reads `bot` from its props (a request to lanes B and F: the host passes the bot's id in a bot's tab).
//
// The live view. Bot tabs are drawn offscreen, and the person sees one through the browser's live view: a native view
// the browser draws above the page's DOM at this frame's place, laid out at the frame's size (§12.1, spike S7). While
// a tab is active and the frame has a size, the panel asks `browser.show(tab, "browser", size)`; the view's name is
// the panel's key, which lane E's runtime maps to where the frame is on screen. Switching tabs hides the old one and
// shows the new one, a resize shows it again at the new size once it settles, and unmounting hides it. Nothing is
// ever drawn over the frame.
//
// Two panels (ruling R8). The panel the person used last has the live view. When another panel takes it, this one's
// tab leaves the view, and the frame holds the tab's last picture, marked as paused. Using the picture brings the live
// view back here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserChrome } from "./BrowserChrome";
import { BrowserTabs } from "./BrowserTabs";
import { readSteps, type Steps } from "./history";
import { useLiveView } from "./live-view";
import { usePluginApi, useViewFrame } from "./sdk";
import { S } from "./strings";
import type { BrowserEntryProps, BrowserTab, TabOwner, TabView, Viewport } from "./types";
import { normalizeAddress, tabName } from "./url";

/** The browser view's name: the panel's key. */
export const VIEW = "browser";
/** The most the browser lays a view out at, either way (lane B's `Viewport`). */
const MAX_SIDE = 16_384;

const sameOwner = (a: TabOwner, b: TabOwner): boolean =>
  a.kind === "bot" ? b.kind === "bot" && a.bot === b.bot : a.kind === "session" ? b.kind === "session" && a.session === b.session : b.kind === "user";

/** The list with `tab` in it: replaced where it is, or added at the end. */
const upsert = (list: TabView[], tab: TabView): TabView[] => (list.some((t) => t.id === tab.id) ? list.map((t) => (t.id === tab.id ? tab : t)) : [...list, tab]);

/** One sentence for a failure: what it was doing, then the browser's own reason when it gave one. */
function describe(lead: string, error: unknown): string {
  const reason = error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  return reason === "" ? lead : `${lead} ${reason}`;
}

export function BrowserPanel({ props }: BrowserEntryProps) {
  const api = usePluginApi()?.browser;
  const bot = props?.bot;
  const session = props?.session;
  const owner = useMemo<TabOwner>(() => (bot ? { kind: "bot", bot } : session ? { kind: "session", session } : { kind: "user" }), [bot, session]);

  const [tabs, setTabs] = useState<TabView[]>([]);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<Steps>({});
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  // The live view's place: the host draws the browser's native view over this frame (lane E's `useViewFrame`).
  const viewFrame = useViewFrame(VIEW);
  const frameRef = useCallback((el: HTMLDivElement | null) => {
    setFrame(el);
    viewFrame(el);
  }, [viewFrame]);
  const [size, setSize] = useState<Viewport | null>(null);
  // The tab this panel last had in the view, and its last picture once another panel took the view (R8).
  const [liveHere, setLiveHere] = useState<string | null>(null);
  const [still, setStill] = useState<{ id: string; picture: string } | null>(null);

  // Tabs this panel closed: a late report about one never brings it back.
  const closed = useRef(new Set<string>());
  // The list request in flight, so a late answer is dropped, and what the watch reported while it was out.
  const load = useRef({ n: 0, open: false, buffered: [] as TabView[] });

  const refresh = useCallback(async () => {
    if (!api) return;
    const mine = ++load.current.n;
    load.current.open = true;
    load.current.buffered = [];
    try {
      const list = await api.tabs({ owner });
      if (mine !== load.current.n) return;
      setTabs(load.current.buffered.reduce(upsert, list));
    } catch (e) {
      if (mine === load.current.n) setError(describe(S.failed.tabs, e));
    } finally {
      if (mine === load.current.n) {
        load.current.open = false;
        load.current.buffered = [];
      }
    }
  }, [api, owner]);

  // The owner's tabs, kept current by the browser's own reports.
  useEffect(() => {
    if (!api) return;
    setTabs([]);
    setPicked(undefined);
    closed.current.clear();
    const unwatch = api.watch((tab) => {
      if (!sameOwner(tab.owner, owner) || closed.current.has(tab.id)) return;
      if (load.current.open) load.current.buffered.push(tab);
      setTabs((cur) => upsert(cur, tab));
    });
    void refresh();
    const state = load.current;
    return () => {
      unwatch();
      state.n++;
      state.open = false;
    };
  }, [api, owner, refresh]);

  // The tab shown: the one picked, else the one already in a view, else the first.
  const active = tabs.find((t) => t.id === picked) ?? tabs.find((t) => t.place === "shown") ?? tabs[0];

  // The frame's size in whole CSS pixels, never larger than the frame; none while it has no area (a hidden panel).
  useEffect(() => {
    if (!frame || typeof ResizeObserver === "undefined") return;
    const measure = (width: number, height: number) => {
      const w = Math.min(Math.floor(width), MAX_SIDE);
      const h = Math.min(Math.floor(height), MAX_SIDE);
      setSize((cur) => (w > 0 && h > 0 ? (cur && cur.width === w && cur.height === h ? cur : { width: w, height: h }) : null));
    };
    const observer = new ResizeObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) measure(last.contentRect.width, last.contentRect.height);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frame]);

  const fail = useCallback(
    (lead: string, e: unknown) => {
      setError(describe(lead, e));
      // A call that failed may have failed because the tab is gone: look again at what is there.
      void refresh();
    },
    [refresh],
  );

  const live = useLiveView(api, VIEW, active && size ? { id: active.id, size } : null, {
    onError: (e) => fail(S.failed.show, e),
    // What the browser says about a tab after it moved it. A tab this panel no longer lists stays gone.
    onTab: (tab) => {
      if (tab.place === "shown") setLiveHere(tab.id);
      setTabs((cur) => (cur.some((t) => t.id === tab.id) ? upsert(cur, tab) : cur));
    },
  });

  // Paused: this panel had the tab in the view, and it has left (another panel took the live view, R8).
  const paused = active !== undefined && size !== null && liveHere === active.id && active.place !== "shown";
  const pausedId = paused ? active.id : undefined;
  useEffect(() => {
    if (!api || pausedId === undefined) return;
    let stale = false;
    api.screenshot(pausedId, { format: "jpeg", quality: 70 }).then(
      (shot) => { if (!stale) setStill({ id: pausedId, picture: `data:image/${shot.format};base64,${shot.data}` }); },
      () => { if (!stale) setStill(null); },
    );
    return () => { stale = true; };
  }, [api, pausedId]);

  // Back and forward from the page's own history. Asked again when the page or its loading changes.
  const activeId = active?.id;
  const activeUrl = active?.url;
  const activeLoading = active?.loading;
  useEffect(() => {
    if (!api || activeId === undefined) {
      setSteps({});
      return;
    }
    let current = true;
    api.cdp(activeId, "Page.getNavigationHistory").then(
      (result) => current && setSteps(readSteps(result)),
      // Without the history there is nothing to go back to; the buttons stay off.
      () => current && setSteps({}),
    );
    return () => {
      current = false;
    };
  }, [api, activeId, activeUrl, activeLoading]);

  const select = (id: string) => {
    setError(null);
    setPicked(id);
  };

  const open = async () => {
    if (!api) return;
    setError(null);
    try {
      const tab = await api.open({ owner, show: true });
      setTabs((cur) => upsert(cur, tab));
      setPicked(tab.id);
    } catch (e) {
      fail(S.failed.open, e);
    }
  };

  const close = async (id: string) => {
    if (!api) return;
    setError(null);
    // The neighbour takes over at once; the browser catches up.
    if (active?.id === id) {
      const at = tabs.findIndex((t) => t.id === id);
      setPicked((tabs[at + 1] ?? tabs[at - 1])?.id);
    }
    closed.current.add(id);
    setTabs((cur) => cur.filter((t) => t.id !== id));
    try {
      await api.close(id);
    } catch (e) {
      closed.current.delete(id);
      fail(S.failed.close, e);
    }
  };

  const navigate = async (input: string): Promise<boolean> => {
    const url = normalizeAddress(input);
    if (!api || !active || url === "") return false;
    setError(null);
    try {
      const tab = await api.navigate(active.id, url);
      setTabs((cur) => (cur.some((t) => t.id === tab.id) ? upsert(cur, tab) : cur));
      return true;
    } catch (e) {
      // The browser refuses what it cannot open, and says why: that goes in the bar as it is.
      setError(describe(S.failed.navigate, e));
      return false;
    }
  };

  /** One DevTools call on the active tab, with its failure said in the bar. */
  const devtools = (lead: string, method: string, params?: Record<string, unknown>) => {
    if (!api || !active) return;
    setError(null);
    api.cdp(active.id, method, params).catch((e) => fail(lead, e));
  };

  const rows: BrowserTab[] = tabs.map((t) => ({
    id: t.id,
    title: tabName(t.title, t.url) || S.newTab,
    // A blank page has no address to show.
    url: t.url === "about:blank" ? "" : t.url,
    loading: t.loading,
    held: t.heldByUser,
  }));
  const current = rows.find((r) => r.id === active?.id);

  return (
    <div className="cl-browser-panel" data-owner={owner.kind}>
      <div className="cl-browser-panel__head">
        <BrowserTabs tabs={rows} active={active?.id} onSelect={select} onClose={(id) => void close(id)} onNew={api ? () => void open() : undefined} />
      </div>
      <BrowserChrome
        tab={current}
        live={active?.place === "shown"}
        paused={paused ? { picture: still?.id === active.id ? still.picture : undefined, onResume: live.claim } : undefined}
        error={error ?? (api ? null : S.unavailable)}
        frameRef={frameRef}
        onBack={steps.back !== undefined ? () => devtools(S.failed.history, "Page.navigateToHistoryEntry", { entryId: steps.back }) : undefined}
        onForward={steps.forward !== undefined ? () => devtools(S.failed.history, "Page.navigateToHistoryEntry", { entryId: steps.forward }) : undefined}
        onReload={active ? () => devtools(S.failed.reload, "Page.reload") : undefined}
        onNavigate={navigate}
      />
    </div>
  );
}
