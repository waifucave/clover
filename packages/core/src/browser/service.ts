// The Clover Browser's API in the core (spec §12.1; plan §4 L, M1). Plugins with `browser`, and the browser view, call
// these through lane B's `browser.*` methods; on a desktop the tabs themselves live in the app's Electron, which this
// service drives with `app.tab.open`, `app.tab.command` and `app.tab.list`, and which reports back with
// `browser.report`. The transport between the two is lane E's (the always-on pair); this file only needs the
// `AppTabPort` it hands over.
//
// What the core decides, before anything reaches the app:
// * who may touch a tab: a bot's session only its bot's tabs, a session without a bot only its own, the person's
//   only with their OK for that session (ruling R10: a card per session, never the default), a plugin acting as
//   itself only its own partition's (B-M1's contract review S1), the person (a layer acting for them) any tab;
// * while the person holds a tab in the view, every command on it but theirs is refused (the control lease, §12.1),
//   except looking at it (`tabs`, `screenshot`, DevTools events);
// * the DevTools allow list, the URL rule, and a point from a picture taken at another size;
// * a tab that stopped drawing gives an error, never an old picture.
import { randomBytes } from "node:crypto";
import {
  AGENT_VIEWPORT, isBrowserUrlAllowed, type AppTabCommand, type AppTabEvent, type BrowserNetworkConfig, type Screenshot,
  type ScreenshotFormat, type TabOwner, type TabPlace, type TabView, type Viewport,
} from "./contract";
import { checkProxySetting, DEFAULT_PROXY_SETTING } from "./proxy";
import type { ApprovalRequest } from "../contracts/approval-broker";
import { BrowserError, checkCdpMethod, checkPoint, checkViewport, partitionFor, sameOwner } from "./policy";
import { RemoteBrowsers, type BrowserPeers } from "./peers";

/** Who is calling. The transport decides it (lane B's caller check): a layer acting for the person is `user`, a
 *  session's call is `agent`, and so is a plugin's call made while it serves a session's tool call (ruling R7: the core
 *  binds that session from the tool call's own context, never from anything the plugin says), and a plugin's own
 *  code is `plugin`. */
export type BrowserCaller =
  | { kind: "user" }
  | { kind: "agent"; bot?: string; session?: string }
  | { kind: "plugin"; pluginId: string }
  | { kind: "core" };

/** The protocol's `Caller` (lane B's `common.ts`), as far as the browser reads it. */
export type ProtocolCaller =
  | { kind: "user" }
  | { kind: "session"; sessionId: string; bot?: string }
  | { kind: "plugin"; pluginId: string }
  | { kind: "core" }
  | { kind: "peer"; device: string; sessionId?: string; bot?: string };

/** The browser's caller for a protocol caller, for lane B's transport. Pass the session a plugin is serving a tool
 *  call for, when it is (R7); the plugin's own id is then never the caller. Another computer's session (`peer`) is
 *  held to the same rules as one of the same bot here; the core itself (routines, hooks) is its own kind, as a
 *  plugin's own code is held. */
export function browserCallerOf(caller: ProtocolCaller, servingToolCallOf?: Extract<ProtocolCaller, { kind: "session" | "peer" }>): BrowserCaller {
  const c = servingToolCallOf ?? caller;
  switch (c.kind) {
    case "user":
      return { kind: "user" };
    case "session":
      return { kind: "agent", ...(c.bot !== undefined ? { bot: c.bot } : {}), session: c.sessionId };
    case "peer":
      return { kind: "agent", ...(c.bot !== undefined ? { bot: c.bot } : {}), ...(c.sessionId !== undefined ? { session: c.sessionId } : {}) };
    case "plugin":
      return { kind: "plugin", pluginId: c.pluginId };
    case "core":
      return { kind: "core" };
  }
}

/** The app's side of the browser, as lane E's transport hands it to the core. */
export interface AppTabPort {
  open(args: { id: string; owner: TabOwner; url?: string; place: TabPlace }): Promise<TabView>;
  command(id: string, command: AppTabCommand): Promise<unknown>;
  list(): Promise<TabView[]>;
  /** `app.browser.configure`: the proxy setting and the bots allowed their LAN (R13, R14). */
  configure(config: BrowserNetworkConfig): Promise<void>;
}

export type BrowserEvent =
  | { type: "tab_changed"; tab: TabView }
  | { type: "tab_closed"; id: string; computer: string };

export type CdpListener = (method: string, params: unknown) => void;

interface Entry {
  view: TabView;
  /** When the app said the tab stopped drawing; cleared by its next change. */
  stalledSince?: number;
  listeners: Set<CdpListener>;
}

/** The card that asks the person whether a session may use their own browser (R10), as lane D's `SessionGrants`
 *  takes it (its `GrantCard`): the grant makes it a `confirm` card, which no level or saved rule answers, and adds the
 *  session, its bot and its turn's origin. Its strings are the core's own. */
export type PersonsBrowserCard = Omit<ApprovalRequest, "kind" | "session" | "bot" | "origin" | "ruleKey" | "options">;

export function personsBrowserCard(computer: string): PersonsBrowserCard {
  return {
    computers: [computer],
    effect: "screen",
    fields: {
      title: { type: "text", text: "Use your own browser?" },
      what: { type: "text", text: "This session asks to use your own browser tabs, with your sign-ins. A yes holds for this session only." },
    },
  };
}

/** R10's grant, kept by lane D: whether a session holds it, and asking the person with the card once per session.
 *  The browser never records a grant itself. `personsBrowserGrants` makes one from D's `SessionGrants`. */
export interface PersonsBrowserGrants {
  has(session: string): boolean;
  /** True on the person's yes on the card (or a yes they gave this session before). */
  ensure(session: string, card: PersonsBrowserCard, opts?: { signal?: AbortSignal }): Promise<boolean>;
}

/** Lane D's grant key for the person's own browser partition (`USER_BROWSER_PARTITION_GRANT` in
 *  `sessions/grants.ts`, #176). */
export const USER_BROWSER_PARTITION_GRANT = "browser.partition.user";

/** Lane D's `SessionGrants`, as far as the browser uses it. Its `ensure` grants only on the person's own yes on the
 *  card (#176's fix for review B1: a broker's yes by level or rule grants nothing). */
export interface SessionGrantsPort {
  has(session: string, key: string): boolean;
  ensure(session: string, key: string, card: PersonsBrowserCard, opts?: { signal?: AbortSignal }): Promise<{ allowed: boolean; by?: string }>;
}

/** The browser's grants port over lane D's `SessionGrants`. A decision counts only when it is allowed and came from
 *  the card or a grant the card made before (`by: "card"` or `"grant"`), whatever the grants object says: the
 *  browser checks again, so a grants object without D's fix still can't open the person's browser without a card. */
export function personsBrowserGrants(grants: SessionGrantsPort): PersonsBrowserGrants {
  return {
    has: (session) => grants.has(session, USER_BROWSER_PARTITION_GRANT),
    ensure: async (session, card, opts) => {
      const d = await grants.ensure(session, USER_BROWSER_PARTITION_GRANT, card, opts);
      return d.allowed === true && (d.by === "card" || d.by === "grant");
    },
  };
}

export interface BrowserServiceOptions {
  /** This computer's name. */
  computer: string;
  /** The user's other computers (lane J) and the link to them (lane H): a call that names another computer goes
   *  there, and that computer's browser answers under its own rules (`peers.ts`). Without them, only this one. */
  peers?: BrowserPeers;
  /** Lane D's session grants. Without them no session ever drives the person's own browser. */
  grants?: PersonsBrowserGrants;
  /** The app's port, or undefined while no app runs on this computer. Where no app runs at all (a server), the
   *  headless shell's port (`headless/`). */
  app: () => AppTabPort | undefined;
  /** The network settings to start with: the proxy setting (Settings' `browser.proxy`) and the bots whose LAN
   *  setting is on (lane D's bot settings). `configure` changes them. */
  network?: BrowserNetworkConfig;
  emit?: (event: BrowserEvent) => void;
  newId?: () => string;
  now?: () => number;
}

const NO_APP = "the Clover app isn't running on this computer, so neither is its browser; it starts again by itself";

export class BrowserService {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private network: BrowserNetworkConfig;
  private readonly listeners = new Set<(event: BrowserEvent) => void>();
  private readonly remote: RemoteBrowsers | undefined;

  constructor(private readonly opts: BrowserServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `tab_${randomBytes(9).toString("base64url")}`);
    this.network = checkNetwork(opts.network ?? { proxy: DEFAULT_PROXY_SETTING, lanBots: [] });
    this.remote = opts.peers !== undefined ? new RemoteBrowsers(opts.peers, (e) => this.emit(e)) : undefined;
  }

  /** Every event the service emits (this computer's tabs, and the other computers' tabs it reached), besides
   *  `opts.emit`: the holder's side of `peers.ts` listens here. */
  onEvent(fn: (event: BrowserEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Stops listening to other computers. */
  dispose(): void {
    this.remote?.dispose();
    this.listeners.clear();
  }

  // -----------------------------------------------------------------------------------------------
  // The settings (R13's per-bot LAN, R14's proxy)
  // -----------------------------------------------------------------------------------------------

  /** The network settings now. */
  get networkConfig(): BrowserNetworkConfig {
    return { proxy: this.network.proxy, lanBots: [...this.network.lanBots] };
  }

  /** A setting changed (the daemon calls this when Settings' `browser.proxy` or a bot's LAN setting changes): the app
   *  (or the headless shell) gets the whole set at once. Without an app it is kept, and sent when one connects. */
  async configure(config: BrowserNetworkConfig): Promise<void> {
    this.network = checkNetwork(config);
    const app = this.opts.app();
    if (app !== undefined) await app.configure(this.networkConfig).catch((e) => { throw appFailed(e); });
  }

  // -----------------------------------------------------------------------------------------------
  // The API (`browser.*`)
  // -----------------------------------------------------------------------------------------------

  /** `browser.tabs`: this computer's tabs, or another computer's when `computer` names one. */
  async list(caller: BrowserCaller, filter: { owner?: TabOwner; computer?: string } = {}): Promise<TabView[]> {
    if (filter.computer === undefined || filter.computer === this.opts.computer) return this.tabs(caller, filter);
    return this.peer(filter.computer).list(caller, filter.computer, filter.owner);
  }

  /** This computer's tabs the caller may use (another computer's: `list`). */
  tabs(caller: BrowserCaller, filter: { owner?: TabOwner; computer?: string } = {}): TabView[] {
    if (filter.computer !== undefined && filter.computer !== this.opts.computer) return [];
    return [...this.entries.values()]
      .map((e) => e.view)
      .filter((v) => this.mayTouch(caller, v.owner) && (filter.owner === undefined || sameOwner(filter.owner, v.owner)))
      .map((v) => ({ ...v }));
  }

  /** `browser.open`. `show` puts it in that view at once (B-M1's shape; `true`, M1's, means headless). */
  async open(caller: BrowserCaller, args: { owner: TabOwner; url?: string; show?: boolean | { view: string; viewport: Viewport }; computer?: string }): Promise<TabView> {
    if (args.computer !== undefined && args.computer !== this.opts.computer) {
      if (args.url !== undefined) this.checkUrl(args.url);
      if (typeof args.show === "object") throw new BrowserError("not_yours", `a tab on ${args.computer} is shown only in that computer's app; watch it as a stream`);
      partitionFor(args.owner);
      return this.peer(args.computer).open(caller, args.computer, { owner: args.owner, ...(args.url !== undefined ? { url: args.url } : {}) });
    }
    if (typeof args.show === "object") {
      checkViewport(args.show.viewport);
      checkView(args.show.view);
    }
    if (!this.mayTouch(caller, args.owner)) {
      if (args.owner.kind !== "user" || caller.kind !== "agent" || caller.session === undefined) throw this.notYours(caller);
      // The person's own browser: their yes for this session, asked on a card the first time (R10, lane D's grants).
      const yes = this.opts.grants !== undefined && (await this.opts.grants.ensure(caller.session, personsBrowserCard(this.opts.computer)).catch(() => false));
      if (!yes) throw needsOk();
    }
    const partition = partitionFor(args.owner);
    if (args.url !== undefined) this.checkUrl(args.url);
    const app = this.app();
    const id = this.newId();
    // Opened at the agent's size, drawing for a bot; a browser view that wants it calls `show` with its own size.
    const view = await app.open({ id, owner: args.owner, url: args.url, place: "headless" }).catch((e) => { throw appFailed(e); });
    const entry: Entry = { view: { ...view, id, owner: args.owner, partition, computer: this.opts.computer, heldByUser: false }, listeners: new Set() };
    this.entries.set(id, entry);
    this.emit({ type: "tab_changed", tab: { ...entry.view } });
    if (typeof args.show === "object") return this.show(caller, id, args.show.view, args.show.viewport);
    return { ...entry.view };
  }

  async close(caller: BrowserCaller, id: string): Promise<void> {
    if (this.isRemote(id)) return this.remote!.close(caller, id);
    const entry = this.entry(caller, id, { lookOnly: false });
    await this.command(id, { kind: "close" });
    this.forget(entry.view.id);
  }

  async navigate(caller: BrowserCaller, id: string, url: string): Promise<TabView> {
    this.checkUrl(url);
    if (this.isRemote(id)) return this.remote!.navigate(caller, id, url);
    this.entry(caller, id, { lookOnly: false });
    await this.command(id, { kind: "navigate", url });
    return this.view(id);
  }

  async show(caller: BrowserCaller, id: string, view: string, viewport: Viewport): Promise<TabView> {
    if (this.isRemote(id)) throw new BrowserError("not_yours", `a tab on ${this.remote!.computerOf(id)} is shown only in that computer's app; watch it as a stream`);
    this.entry(caller, id, { lookOnly: false });
    checkViewport(viewport);
    checkView(view);
    await this.command(id, { kind: "place", place: "shown", view, viewport });
    // One tab per view: another tab this view showed went back to drawing for its bot (the app reports it too).
    for (const other of this.entries.values()) {
      if (other.view.id !== id && other.view.place === "shown" && other.view.view === view) {
        const { view: _gone, ...rest } = other.view;
        other.view = { ...rest, place: "headless", viewport: { ...AGENT_VIEWPORT }, heldByUser: false };
        this.emit({ type: "tab_changed", tab: { ...other.view } });
      }
    }
    return this.update(id, { place: "shown", viewport: { width: viewport.width, height: viewport.height }, view });
  }

  async hide(caller: BrowserCaller, id: string): Promise<TabView> {
    if (this.isRemote(id)) return this.remote!.hide(caller, id);
    const entry = this.entry(caller, id, { lookOnly: false });
    await this.command(id, { kind: "place", place: "headless", viewport: AGENT_VIEWPORT });
    // Whoever held it in the view lets go when it leaves the view.
    const { view: _gone, ...rest } = entry.view;
    entry.view = rest;
    return this.update(entry.view.id, { place: "headless", viewport: { ...AGENT_VIEWPORT }, heldByUser: false });
  }

  /** `browser.hold`, from the app only: the person took the tab in the view, or gave it back. */
  hold(id: string, held: boolean): TabView {
    const entry = this.entries.get(id);
    if (entry === undefined) throw noTab(id);
    if (entry.view.heldByUser === held) return { ...entry.view };
    return this.update(id, { heldByUser: held });
  }

  async screenshot(caller: BrowserCaller, id: string, opts: { format?: ScreenshotFormat; quality?: number } = {}): Promise<Screenshot> {
    if (this.isRemote(id)) return this.remote!.screenshot(caller, id, opts);
    const entry = this.entry(caller, id, { lookOnly: true });
    if (entry.stalledSince !== undefined) {
      throw new BrowserError("stalled", `the tab stopped drawing ${Math.round((this.now() - entry.stalledSince) / 1000)} s ago, so there's no fresh picture of it`);
    }
    const format = opts.format ?? "png";
    if (opts.quality !== undefined && (!Number.isInteger(opts.quality) || opts.quality < 1 || opts.quality > 100)) {
      throw new BrowserError("bad_viewport", "quality is a whole number from 1 to 100");
    }
    const shot = (await this.command(id, { kind: "screenshot", format, ...(opts.quality !== undefined ? { quality: opts.quality } : {}) })) as Screenshot;
    return shot;
  }

  async cdp(caller: BrowserCaller, id: string, method: string, params?: Record<string, unknown>, opts: { viewport?: Viewport } = {}): Promise<unknown> {
    checkCdpMethod(method);
    if (this.isRemote(id)) return this.remote!.cdp(caller, id, method, params, opts.viewport);
    const entry = this.entry(caller, id, { lookOnly: false });
    checkPoint(method, opts.viewport, entry.view.viewport);
    return this.command(id, { kind: "cdp", method, ...(params !== undefined ? { params } : {}) });
  }

  /** `browser.onCdpEvent`: the tab's allowlisted DevTools events, for as long as the tab lives. */
  onCdpEvent(caller: BrowserCaller, id: string, listener: CdpListener): () => void {
    const entry = this.entry(caller, id, { lookOnly: true });
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  /** `onCdpEvent` for a tab on any computer: another computer's tab subscribes there first. */
  async watchCdp(caller: BrowserCaller, id: string, listener: CdpListener): Promise<() => void> {
    if (this.isRemote(id)) return this.remote!.onCdpEvent(caller, id, listener);
    return this.onCdpEvent(caller, id, listener);
  }

  // -----------------------------------------------------------------------------------------------
  // The app's side (`browser.report`, and the app coming back)
  // -----------------------------------------------------------------------------------------------

  /** What the app reports about its tabs (`browser.report`). */
  report(events: readonly AppTabEvent[]): void {
    // A tab closed earlier in the same batch stays closed: a later `changed` for it is stale (the second review).
    const closedNow = new Set<string>();
    for (const event of events) {
      switch (event.kind) {
        case "changed": {
          if (closedNow.has(event.tab.id)) break;
          // The core owns who holds a tab and whose it is; the app owns where it is and what it shows.
          const entry = this.entries.get(event.tab.id);
          if (entry === undefined) {
            this.adopt(event.tab);
            break;
          }
          entry.view = { ...event.tab, computer: this.opts.computer, owner: entry.view.owner, partition: entry.view.partition, heldByUser: entry.view.heldByUser };
          delete entry.stalledSince;
          this.emit({ type: "tab_changed", tab: { ...entry.view } });
          break;
        }
        case "closed":
          closedNow.add(event.id);
          this.forget(event.id);
          break;
        case "cdp": {
          const entry = this.entries.get(event.id);
          if (entry === undefined) break;
          // The app forwards only allowlisted domains; checking again costs nothing.
          try {
            checkCdpMethod(event.method);
          } catch {
            break;
          }
          for (const listener of entry.listeners) {
            try {
              listener(event.method, event.params);
            } catch {
              // One listener's mistake never stops the others.
            }
          }
          break;
        }
        case "stalled": {
          const entry = this.entries.get(event.id);
          if (entry !== undefined) entry.stalledSince = this.now() - event.sinceMs;
          break;
        }
      }
    }
  }

  /** After the app (re)started: its tabs are what the core knows, and a tab the core knew that the app lost (a crash)
   *  is opened again at its last address, which reloads it (§12.1). Returns the ids reopened. */
  async reconnect(): Promise<string[]> {
    const app = this.app();
    // The settings first, so no tab reopened below connects before its proxy and LAN setting are in place.
    await app.configure(this.networkConfig);
    const live = await app.list();
    const liveIds = new Set(live.map((t) => t.id));
    this.report(live.map((tab) => ({ kind: "changed" as const, tab })));
    const reopened: string[] = [];
    for (const entry of [...this.entries.values()]) {
      if (liveIds.has(entry.view.id)) continue;
      const url = isBrowserUrlAllowed(entry.view.url) ? entry.view.url : undefined;
      try {
        const view = await app.open({ id: entry.view.id, owner: entry.view.owner, url, place: "headless" });
        entry.view = { ...view, owner: entry.view.owner, partition: entry.view.partition, computer: this.opts.computer, heldByUser: false };
        delete entry.stalledSince;
        this.emit({ type: "tab_changed", tab: { ...entry.view } });
        reopened.push(entry.view.id);
      } catch {
        this.forget(entry.view.id);
      }
    }
    return reopened;
  }

  // -----------------------------------------------------------------------------------------------

  /** A tab the app made that the core never opened: a window a page opened, which the app keeps as a tab of its
   *  opener's owner. The core takes none of the app's word for whose it is: it is adopted only as the owner of a tab the
   *  core holds now, with that owner's partition as the core computes it, and not held. Anything else (a tab the core
   *  can't place, as after the core itself restarted) is refused and closed in the app. */
  private adopt(tab: TabView): void {
    const owner = [...this.entries.values()].map((e) => e.view.owner).find((o) => sameOwner(o, tab.owner));
    const partition = owner !== undefined ? partitionFor(owner) : undefined;
    if (owner === undefined || partition !== tab.partition) {
      void this.opts.app()?.command(tab.id, { kind: "close" }).catch(() => undefined);
      return;
    }
    const view: TabView = { ...tab, owner, partition, computer: this.opts.computer, heldByUser: false };
    this.entries.set(view.id, { view, listeners: new Set() });
    this.emit({ type: "tab_changed", tab: { ...view } });
  }

  private app(): AppTabPort {
    const app = this.opts.app();
    if (app === undefined) throw new BrowserError("no_app", NO_APP);
    return app;
  }

  private async command(id: string, command: AppTabCommand): Promise<unknown> {
    try {
      return await this.app().command(id, command);
    } catch (e) {
      throw appFailed(e);
    }
  }

  private entry(caller: BrowserCaller, id: string, opts: { lookOnly: boolean }): Entry {
    const entry = this.entries.get(id);
    if (entry === undefined || !this.mayTouch(caller, entry.view.owner)) throw noTab(id);
    // Spec §12.1: while the person holds a tab, every command on it is refused but the person's own (a layer acting on
    // their input, like the browser view's back button; B-M1's contract review S1). An agent, a plugin's own code and
    // the core may still look at it.
    if (entry.view.heldByUser && caller.kind !== "user" && !opts.lookOnly) {
      throw new BrowserError("held", "the person is using this tab in the browser view; try again once they let go of it");
    }
    return entry;
  }

  /** A bot's session: its bot's tabs. A session without a bot: its own. The person's tabs: only a session they said
   *  yes to (R10). A plugin acting as itself: only its own partition's (B-M1's contract review S1). The person (a layer
   *  acting for them) and the core: any. */
  private mayTouch(caller: BrowserCaller, owner: TabOwner): boolean {
    if (caller.kind === "plugin") return owner.kind === "plugin" && owner.pluginId === caller.pluginId;
    if (caller.kind !== "agent") return true;
    if (owner.kind === "user") return caller.session !== undefined && this.opts.grants?.has(caller.session) === true;
    if (owner.kind === "plugin") return false;
    if (caller.bot !== undefined) return owner.kind === "bot" && owner.bot === caller.bot;
    return owner.kind === "session" && caller.session !== undefined && owner.session === caller.session;
  }

  private notYours(caller: BrowserCaller): BrowserError {
    if (caller.kind === "plugin") return new BrowserError("not_yours", `a plugin acting as itself opens tabs only in its own partition: owner { kind: "plugin", pluginId: "${caller.pluginId}" }`);
    const whose = caller.kind === "agent" && caller.bot !== undefined ? `${caller.bot}'s` : "its own";
    return new BrowserError("not_yours", `a session opens tabs only as ${whose}`);
  }

  private checkUrl(url: string): void {
    if (url.length > 8192 || !isBrowserUrlAllowed(url)) {
      throw new BrowserError("url_refused", `the browser doesn't open ${url.length > 200 ? `${url.slice(0, 200)}…` : url}: only web pages (and about:blank)`);
    }
  }

  /** Another computer's tab this computer reached (never one of its own). */
  private isRemote(id: string): boolean {
    return !this.entries.has(id) && this.remote?.has(id) === true;
  }

  private peer(computer: string): RemoteBrowsers {
    if (this.remote === undefined) throw new BrowserError("no_computer", `tabs on another computer (${computer.slice(0, 128)}) aren't reachable from here: this computer has no link to it`);
    return this.remote;
  }

  private view(id: string): TabView {
    const entry = this.entries.get(id);
    if (entry === undefined) throw noTab(id);
    return { ...entry.view };
  }

  private update(id: string, patch: Partial<TabView>): TabView {
    const entry = this.entries.get(id);
    if (entry === undefined) throw noTab(id);
    entry.view = { ...entry.view, ...patch };
    this.emit({ type: "tab_changed", tab: { ...entry.view } });
    return { ...entry.view };
  }

  private forget(id: string): void {
    if (!this.entries.delete(id)) return;
    this.emit({ type: "tab_closed", id, computer: this.opts.computer });
  }

  private emit(event: BrowserEvent): void {
    for (const fn of [this.opts.emit, ...this.listeners]) {
      try {
        fn?.(event);
      } catch {
        // Listeners never break the browser.
      }
    }
  }
}

function checkView(view: string): void {
  if (view.length === 0 || view.length > 128) throw new BrowserError("bad_viewport", "a view's name is 1–128 characters");
}

function checkNetwork(config: BrowserNetworkConfig): BrowserNetworkConfig {
  let proxy;
  try {
    proxy = checkProxySetting(config.proxy);
  } catch (e) {
    throw new BrowserError("bad_setting", e instanceof Error ? e.message : String(e));
  }
  if (!Array.isArray(config.lanBots) || config.lanBots.length > 10_000) throw new BrowserError("bad_setting", "lanBots is a list of bots' ids");
  for (const bot of config.lanBots) partitionFor({ kind: "bot", bot });
  return { proxy, lanBots: [...new Set(config.lanBots)] };
}

function needsOk(): BrowserError {
  return new BrowserError("needs_ok", "the person's own browser holds their sign-ins: a session uses it only after they say yes on the card for that session, and they haven't; use your own tabs");
}

function noTab(id: string): BrowserError {
  return new BrowserError("no_tab", `there's no tab ${id.length > 64 ? `${id.slice(0, 64)}…` : id} that this caller can use`);
}

function appFailed(e: unknown): BrowserError {
  if (e instanceof BrowserError) return e;
  return new BrowserError("app_failed", e instanceof Error ? e.message : String(e));
}
