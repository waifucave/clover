// The Clover Browser in the app's main process (spec §12.1, lane L; the owner's decisions 92–94). The daemon drives
// it (`app.tab.open`, `app.tab.command`, `app.tab.list`) and it reports back (`browser.report`, `browser.hold`); the
// transport is lane E's always-on pair. Lane E's runtime also tells it where each browser view's frame is
// (`setView`), so the person sees a tab there without it reloading.
//
//   const browser = createBrowserHost({ computer, report, hold, assets });
//   transport.handle("app.tab.open", (p) => browser.open(p));            // and command, list
//   runtime.onViewMoved("browser", (target) => browser.setView("browser", target));
//   app.on("web-contents-created", (_e, wc) => { if (!isBrowserContents(wc)) guardContents(wc); });
//
// Its webContents (tabs, the windows pages open, the viewport pages) get the browser's own policy (`session.ts`), and
// the app's window guards leave them alone: `isBrowserContents` tells them apart from the moment each is made.
import { app, BrowserWindow, dialog, Menu, type BaseWindow, type ContextMenuParams, type Rectangle } from "electron";
import { randomBytes } from "node:crypto";
import { AGENT_VIEWPORT, isBrowserUrlAllowed, partitionFor, type AppTabCommand, type AppTabEvent, type TabOwner, type TabPlace, type TabView, type Viewport as Size } from "./contract";
import { HostWindow } from "./host-window";
import { choosePopup } from "./popups";
import { ScreenReaderSwitch, type ScreenReaderProbe } from "./screen-reader";
import { NetworkFilter, policyFor, type AddressPolicy, type NetworkFilterOptions } from "./network";
import { guardPage, isSessionReady, prepareTabSession, resetViewportSession } from "./session";
import { BrowserTab, HostTab, OffscreenTab, tabWebPreferences, type TabEnv } from "./tab";
import { Viewport, type ViewportAssets } from "./viewport";

export { BROWSER_ASSETS } from "./assets";
export { BROWSER_WEBRTC_POLICY, isBrowserContents, isBrowserTab } from "./session";
export { BOT_POLICY, PERSON_POLICY, SESSION_POLICY, type AddressPolicy } from "./network";
export type { AppTabCommand, AppTabEvent, TabOwner, TabPlace, TabView } from "./contract";
export type { ViewportAssets } from "./viewport";

/** Where a browser view's frame is: its window, and the frame's rectangle in the window's content. */
export interface ViewTarget {
  window: BaseWindow;
  bounds: Rectangle;
}

/** What the person can do from a tab's menu; the default menu offers them, a test or another menu calls them. */
export interface TabMenuActions {
  copy(): void;
  cut(): void;
  paste(): void;
  selectAll(): void;
  back(): void;
  forward(): void;
  reload(): void;
}

export interface BrowserHostOptions {
  /** This computer's name, for the tabs' views. */
  computer: string;
  /** To the daemon (`browser.report`), batched. */
  report(events: AppTabEvent[]): void;
  /** To the daemon (`browser.hold`): the person took a tab in the view. */
  hold?(id: string, held: boolean): void;
  assets: ViewportAssets;
  screenReader?: { override?: boolean; probes?: ScreenReaderProbe[]; pollMs?: number };
  /** The tab's menu while it's shown; by default a native menu at the point. */
  contextMenu?(tab: TabView, params: ContextMenuParams, actions: TabMenuActions, at: { window: BaseWindow; x: number; y: number }): void;
  /** Files the person picks for a page's file chooser; by default the OS's open dialog. */
  pickFiles?(window: BaseWindow, multiple: boolean): Promise<string[]>;
  newId?(): string;
  /** Which addresses an owner's tabs may reach (R13; by default `policyFor`: no loopback or private address for a bot,
   *  loopback for a coding session, never the metadata address), and the filter's resolver and dialer, for tests. */
  network?: { policyFor?(owner: TabOwner): AddressPolicy } & Pick<NetworkFilterOptions, "lookup" | "dial" | "log">;
}

export class BrowserHost {
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly views = new Map<string, { target?: ViewTarget; viewport?: Viewport; tab?: string }>();
  private readonly hostWindow = new HostWindow();
  private readonly screenReader: ScreenReaderSwitch;
  private pending: AppTabEvent[] = [];
  private flushing = false;
  private readonly env: TabEnv;
  private readonly network: NetworkFilter;

  constructor(private readonly opts: BrowserHostOptions) {
    this.screenReader = new ScreenReaderSwitch({ electron: app, ...opts.screenReader });
    this.network = new NetworkFilter({ lookup: opts.network?.lookup, dial: opts.network?.dial, log: opts.network?.log });
    const host = this;
    this.env = {
      computer: opts.computer,
      report: (event) => host.queue(event),
      windowOpen: (tab, details) => host.windowOpen(tab, details),
      windowCreated: (tab, child, details) => host.windowCreated(tab, child, details),
      contextMenu: (tab, params) => host.contextMenu(tab, params),
      fileChooser: (tab, chooser) => void host.fileChooser(tab, chooser),
      cursor: (tab, type) => { if (tab instanceof OffscreenTab) host.viewportOf(tab)?.cursor(tab, type); },
      paint: (tab, dirty, image) => { if (tab instanceof OffscreenTab && tab.place === "shown") host.viewportOf(tab)?.paint(tab, dirty, image); },
      dragIntercepted: (tab, data) => { if (tab instanceof OffscreenTab) host.viewportOf(tab)?.dragIntercepted(tab, data); },
    };
  }

  /** Starts watching for a screen reader. Call once the app is ready. */
  async start(): Promise<void> {
    await this.screenReader.start();
  }

  /** Whether a bot's new tab would start as a real view (the hybrid). */
  get screenReaderOn(): boolean {
    return this.screenReader.on;
  }

  // -----------------------------------------------------------------------------------------------
  // From the daemon
  // -----------------------------------------------------------------------------------------------

  /** `app.tab.open`. */
  async open(args: { id: string; owner: TabOwner; url?: string; place: TabPlace }): Promise<TabView> {
    if (this.tabs.has(args.id)) throw new Error(`there's already a tab ${args.id}`);
    const partition = partitionFor(args.owner); // refuses a bad owner before anything is made
    if (args.url !== undefined && !isBrowserUrlAllowed(args.url)) throw new Error(`the browser doesn't open ${args.url}`);
    // Locked down, its traffic through the network filter for its owner (R13), before the tab exists: `isBrowserTab`
    // holds from `web-contents-created` on, and no page loads before its proxy is set.
    const policy = this.opts.network?.policyFor?.(args.owner) ?? policyFor(args.owner);
    await prepareTabSession(partition, await this.network.proxyFor(policy));
    if (this.tabs.has(args.id)) throw new Error(`there's already a tab ${args.id}`);
    // The switch decides where a NEW tab starts, and never moves one (decision 93).
    const tab = this.screenReader.on
      ? HostTab.create(args.id, args.owner, this.hostWindow.get(), this.env)
      : OffscreenTab.create(args.id, args.owner, this.env);
    this.tabs.set(args.id, tab);
    tab.contents.once("destroyed", () => this.forget(args.id));
    if (tab instanceof HostTab) this.hostWindow.tabStarting(tab.contents);
    if (args.url !== undefined) await tab.navigate(args.url);
    if (args.place === "resting") tab.setPlace("resting", AGENT_VIEWPORT);
    return tab.toView();
  }

  /** `app.tab.command`. */
  async command(id: string, command: AppTabCommand): Promise<unknown> {
    const tab = this.tabs.get(id);
    if (tab === undefined || tab.closed) throw new Error(`there's no tab ${id}`);
    switch (command.kind) {
      case "close":
        tab.close();
        return null;
      case "navigate":
        await tab.navigate(command.url);
        return null;
      case "place":
        this.place(tab, command.place, command.view, command.viewport);
        return null;
      case "screenshot":
        return tab.screenshot(command.format, command.quality);
      case "cdp":
        return tab.cdp(command.method, command.params);
    }
  }

  /** `app.tab.list`. */
  list(): TabView[] {
    return [...this.tabs.values()].filter((t) => !t.closed).map((t) => t.toView());
  }

  // -----------------------------------------------------------------------------------------------
  // From lane E's runtime: where a browser view's frame is
  // -----------------------------------------------------------------------------------------------

  /** A browser view's frame appeared, moved or went away (undefined). A tab shown there follows it. */
  setView(view: string, target: ViewTarget | undefined): void {
    const slot = this.views.get(view) ?? {};
    this.views.set(view, slot);
    slot.target = target;
    const tab = slot.tab !== undefined ? this.tabs.get(slot.tab) : undefined;
    if (tab === undefined || tab.closed) return;
    if (target === undefined) {
      slot.viewport?.detach();
      if (tab instanceof HostTab) tab.setPlace("shown", tab.viewport); // stays laid out; back in the host until it returns
      return;
    }
    this.show(tab, view, tab.viewport);
  }

  shutdown(): void {
    this.screenReader.stop();
    for (const tab of this.tabs.values()) tab.close();
    for (const slot of this.views.values()) slot.viewport?.destroy();
    this.views.clear();
    this.hostWindow.closeIfEmpty();
    resetViewportSession();
    void this.network.close();
  }

  // -----------------------------------------------------------------------------------------------

  private place(tab: BrowserTab, place: TabPlace, view: string | undefined, viewport: Size | undefined): void {
    if (place === "shown") {
      if (view === undefined || viewport === undefined) throw new Error("showing a tab needs a view and its size");
      this.show(tab, view, viewport);
      return;
    }
    this.unshow(tab);
    tab.setPlace(place, viewport ?? AGENT_VIEWPORT);
  }

  private show(tab: BrowserTab, view: string, viewport: Size): void {
    // One tab per view: the one there before goes back to drawing for its bot.
    const slot = this.views.get(view) ?? {};
    this.views.set(view, slot);
    if (slot.tab !== undefined && slot.tab !== tab.id) {
      const before = this.tabs.get(slot.tab);
      if (before !== undefined && !before.closed) {
        this.unshow(before);
        before.setPlace("headless", AGENT_VIEWPORT);
      }
    }
    if (tab.view !== undefined && tab.view !== view) this.unshow(tab);
    slot.tab = tab.id;
    tab.view = view;
    if (tab instanceof OffscreenTab) {
      tab.setPlace("shown", viewport);
      if (slot.target !== undefined) {
        slot.viewport ??= new Viewport(this.opts.assets, { took: (t) => this.took(t.id) });
        slot.viewport.attach(tab, slot.target);
      }
    } else {
      tab.setPlace("shown", viewport, slot.target);
    }
  }

  private unshow(tab: BrowserTab): void {
    const view = tab.view;
    tab.view = undefined;
    if (view === undefined) return;
    const slot = this.views.get(view);
    if (slot?.tab !== tab.id) return;
    slot.tab = undefined;
    if (slot.viewport?.attached === tab) slot.viewport.detach();
  }

  private viewportOf(tab: BrowserTab): Viewport | undefined {
    if (tab.view === undefined) return undefined;
    const vp = this.views.get(tab.view)?.viewport;
    return vp?.attached === tab ? vp : undefined;
  }

  private took(id: string): void {
    try {
      this.opts.hold?.(id, true);
    } catch {
      // The daemon hears it again on the next input.
    }
  }

  private forget(id: string): void {
    const tab = this.tabs.get(id);
    if (tab === undefined) return;
    this.unshow(tab);
    this.tabs.delete(id);
    if (tab instanceof HostTab) this.hostWindow.closeIfEmpty();
  }

  private queue(event: AppTabEvent): void {
    this.pending.push(event);
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      const events = this.pending;
      this.pending = [];
      // Only the newest change of each tab matters.
      const newest = new Map<string, number>();
      events.forEach((e, i) => { if (e.kind === "changed") newest.set(e.tab.id, i); });
      const batch = events.filter((e, i) => e.kind !== "changed" || newest.get(e.tab.id) === i);
      for (let i = 0; i < batch.length; i += 1000) {
        try {
          this.opts.report(batch.slice(i, i + 1000));
        } catch {
          // The daemon asks for `app.tab.list` when it comes back.
        }
      }
    });
  }

  // Popups (popups.ts)

  private windowOpen(tab: BrowserTab, details: { url: string }): ReturnType<Parameters<Electron.WebContents["setWindowOpenHandler"]>[0]> {
    // A window opens in its opener's session, which must already take the filter's path (it does: the opener does).
    if (!isBrowserUrlAllowed(details.url) || !isSessionReady(tab.contents.session)) return { action: "deny" };
    const choice = choosePopup(tab.contents.getURL(), details.url, tab.place === "shown");
    if (choice === "offscreen-tab") {
      return { action: "allow", overrideBrowserWindowOptions: { show: false, width: AGENT_VIEWPORT.width, height: AGENT_VIEWPORT.height, useContentSize: true, skipTaskbar: true, webPreferences: tabWebPreferences(tab.partition, true) } };
    }
    if (choice === "real-window") {
      return { action: "allow", overrideBrowserWindowOptions: { show: true, autoHideMenuBar: true, webPreferences: tabWebPreferences(tab.partition, false) } };
    }
    // Same-site with a bot alone: the page's window can't be offscreen on stock Electron (#55565), so its address
    // opens as a tab of its own, without its opener.
    void this.adoptUrl(tab.owner, details.url);
    return { action: "deny" };
  }

  private windowCreated(tab: BrowserTab, child: BrowserWindow, details: { url: string }): void {
    if (!isSessionReady(child.webContents.session)) {
      child.destroy();
      return;
    }
    if (!child.webContents.isOffscreen()) {
      // A real window the person uses (a same-site window while they watch, item 94): in the tab's partition, so the
      // session's rules hold; the page's guards here, and any window it opens in turn becomes a tab of the owner's.
      guardPage(child.webContents);
      child.webContents.setWindowOpenHandler((d) => {
        if (isBrowserUrlAllowed(d.url)) void this.adoptUrl(tab.owner, d.url);
        return { action: "deny" };
      });
      return;
    }
    const id = this.newId();
    const popup = OffscreenTab.adopt(id, tab.owner, child, this.env);
    this.tabs.set(id, popup);
    popup.contents.once("destroyed", () => this.forget(id));
    popup.changed();
    // Check the guess: a child that shares its opener's renderer is the same-site case Electron can't paint.
    popup.contents.once("did-stop-loading", () => {
      setTimeout(() => {
        if (popup.closed || popup.frames.get() !== undefined) return;
        const url = popup.contents.getURL() || details.url;
        popup.close();
        void this.adoptUrl(tab.owner, url);
      }, 1500);
    });
  }

  private async adoptUrl(owner: TabOwner, url: string): Promise<void> {
    try {
      const view = await this.open({ id: this.newId(), owner, url, place: "headless" });
      this.queue({ kind: "changed", tab: view });
    } catch {
      // A page's window that can't be opened is simply not opened.
    }
  }

  private newId(): string {
    return this.opts.newId?.() ?? `tab_${randomBytes(9).toString("base64url")}`;
  }

  // The person's side of a shown tab

  private contextMenu(tab: BrowserTab, params: ContextMenuParams): void {
    const target = tab.view !== undefined ? this.views.get(tab.view)?.target : undefined;
    if (target === undefined) return;
    const c = tab.contents;
    const actions: TabMenuActions = {
      copy: () => c.copy(), cut: () => c.cut(), paste: () => c.paste(), selectAll: () => c.selectAll(),
      back: () => c.navigationHistory.goBack(), forward: () => c.navigationHistory.goForward(), reload: () => c.reload(),
    };
    const at = { window: target.window, x: target.bounds.x + params.x, y: target.bounds.y + params.y };
    if (this.opts.contextMenu !== undefined) {
      this.opts.contextMenu(tab.toView(), params, actions, at);
      return;
    }
    const f = params.editFlags;
    const menu = Menu.buildFromTemplate([
      { label: "Back", enabled: c.navigationHistory.canGoBack(), click: actions.back },
      { label: "Forward", enabled: c.navigationHistory.canGoForward(), click: actions.forward },
      { label: "Reload", click: actions.reload },
      { type: "separator" },
      { label: "Cut", enabled: f.canCut, click: actions.cut },
      { label: "Copy", enabled: f.canCopy, click: actions.copy },
      { label: "Paste", enabled: f.canPaste, click: actions.paste },
      { label: "Select All", enabled: f.canSelectAll, click: actions.selectAll },
    ]);
    menu.popup({ window: at.window as BrowserWindow, x: at.x, y: at.y });
  }

  private async fileChooser(tab: BrowserTab, chooser: { backendNodeId: number; mode: string }): Promise<void> {
    const target = tab.view !== undefined ? this.views.get(tab.view)?.target : undefined;
    if (target === undefined) return;
    const multiple = chooser.mode === "selectMultiple";
    const files = this.opts.pickFiles !== undefined
      ? await this.opts.pickFiles(target.window, multiple)
      : (await dialog.showOpenDialog(target.window as BrowserWindow, { properties: multiple ? ["openFile", "multiSelections"] : ["openFile"] })).filePaths;
    if (files.length === 0 || tab.closed) return;
    // The person picked these files themselves; the API can never set a file input (the core refuses it).
    await tab.debugger.internal("DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId }).catch(() => undefined);
  }
}

export function createBrowserHost(opts: BrowserHostOptions): BrowserHost {
  return new BrowserHost(opts);
}
