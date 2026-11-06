// The Clover Browser's API in the core (spec §12.1; plan §4 L, M1). Plugins with `browser`, and the browser view, call
// these through lane B's `browser.*` methods; on a desktop the tabs themselves live in the app's Electron, which this
// service drives with `app.tab.open`, `app.tab.command` and `app.tab.list`, and which reports back with
// `browser.report`. The transport between the two is lane E's (the always-on pair); this file only needs the
// `AppTabPort` it hands over.
//
// What the core decides, before anything reaches the app:
// * who may touch a tab: a bot's session only its bot's tabs, a session without a bot only its own, the person's
//   only with their OK for that session (ruling R10: a card per session, never the default), the person and plugins
//   acting on their own any tab;
// * while the person holds a tab in the view, an agent's commands on it are refused (the control lease, §12.1), except
//   looking at it (`tabs`, `screenshot`);
// * the DevTools allow list, the URL rule, and a point from a picture taken at another size;
// * a tab that stopped drawing gives an error, never an old picture.
import { randomBytes } from "node:crypto";
import {
  AGENT_VIEWPORT, isBrowserUrlAllowed, type AppTabCommand, type AppTabEvent, type Screenshot, type ScreenshotFormat,
  type TabOwner, type TabPlace, type TabView, type Viewport,
} from "./contract";
import type { ApprovalRequest } from "../contracts/approval-broker";
import { BrowserError, checkCdpMethod, checkPoint, checkViewport, partitionFor, sameOwner } from "./policy";

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
 *  takes it: the grant adds the session, its bot and its turn's origin. Its strings are the core's own. */
export type PersonsBrowserCard = Omit<ApprovalRequest, "session" | "bot" | "origin">;

export function personsBrowserCard(computer: string): PersonsBrowserCard {
  return {
    kind: "confirm",
    computers: [computer],
    effect: "screen",
    fields: {
      title: { type: "text", text: "Use your own browser?" },
      what: { type: "text", text: "This session asks to use your own browser tabs, with your sign-ins. A yes holds for this session only." },
    },
  };
}

/** R10's grant, kept by lane D (`SessionGrants` with `USER_BROWSER_PARTITION_GRANT`, #176): whether a session holds
 *  it, and asking the person with the card once per session. The browser never records a grant itself. */
export interface PersonsBrowserGrants {
  has(session: string): boolean;
  /** True on the person's yes (or a yes they gave this session before). */
  ensure(session: string, card: PersonsBrowserCard, opts?: { signal?: AbortSignal }): Promise<boolean>;
}

export interface BrowserServiceOptions {
  /** This computer's name; tabs on other computers come with M2. */
  computer: string;
  /** Lane D's session grants. Without them no session ever drives the person's own browser. */
  grants?: PersonsBrowserGrants;
  /** The app's port, or undefined while no app runs on this computer. */
  app: () => AppTabPort | undefined;
  emit?: (event: BrowserEvent) => void;
  newId?: () => string;
  now?: () => number;
}

const NO_APP = "the Clover app isn't running on this computer, so neither is its browser; it starts again by itself";

export class BrowserService {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly opts: BrowserServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `tab_${randomBytes(9).toString("base64url")}`);
  }

  // -----------------------------------------------------------------------------------------------
  // The API (`browser.*`)
  // -----------------------------------------------------------------------------------------------

  tabs(caller: BrowserCaller, filter: { owner?: TabOwner; computer?: string } = {}): TabView[] {
    if (filter.computer !== undefined && filter.computer !== this.opts.computer) return [];
    return [...this.entries.values()]
      .map((e) => e.view)
      .filter((v) => this.mayTouch(caller, v.owner) && (filter.owner === undefined || sameOwner(filter.owner, v.owner)))
      .map((v) => ({ ...v }));
  }

  async open(caller: BrowserCaller, args: { owner: TabOwner; url?: string; show?: boolean; computer?: string }): Promise<TabView> {
    this.checkComputer(args.computer);
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
    return { ...entry.view };
  }

  async close(caller: BrowserCaller, id: string): Promise<void> {
    const entry = this.entry(caller, id, { agentWhileHeld: false });
    await this.command(id, { kind: "close" });
    this.forget(entry.view.id);
  }

  async navigate(caller: BrowserCaller, id: string, url: string): Promise<TabView> {
    this.entry(caller, id, { agentWhileHeld: false });
    this.checkUrl(url);
    await this.command(id, { kind: "navigate", url });
    return this.view(id);
  }

  async show(caller: BrowserCaller, id: string, view: string, viewport: Viewport): Promise<TabView> {
    this.entry(caller, id, { agentWhileHeld: false });
    checkViewport(viewport);
    if (view.length === 0 || view.length > 128) throw new BrowserError("bad_viewport", "a view's name is 1–128 characters");
    await this.command(id, { kind: "place", place: "shown", view, viewport });
    return this.update(id, { place: "shown", viewport: { width: viewport.width, height: viewport.height } });
  }

  async hide(caller: BrowserCaller, id: string): Promise<TabView> {
    const entry = this.entry(caller, id, { agentWhileHeld: false });
    await this.command(id, { kind: "place", place: "headless", viewport: AGENT_VIEWPORT });
    // Whoever held it in the view lets go when it leaves the view.
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
    const entry = this.entry(caller, id, { agentWhileHeld: true });
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
    const entry = this.entry(caller, id, { agentWhileHeld: false });
    checkCdpMethod(method);
    checkPoint(method, opts.viewport, entry.view.viewport);
    return this.command(id, { kind: "cdp", method, ...(params !== undefined ? { params } : {}) });
  }

  /** `browser.onCdpEvent`: the tab's allowlisted DevTools events, for as long as the tab lives. */
  onCdpEvent(caller: BrowserCaller, id: string, listener: CdpListener): () => void {
    const entry = this.entry(caller, id, { agentWhileHeld: true });
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  // -----------------------------------------------------------------------------------------------
  // The app's side (`browser.report`, and the app coming back)
  // -----------------------------------------------------------------------------------------------

  /** What the app reports about its tabs (`browser.report`). */
  report(events: readonly AppTabEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case "changed": {
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

  private entry(caller: BrowserCaller, id: string, opts: { agentWhileHeld: boolean }): Entry {
    const entry = this.entries.get(id);
    if (entry === undefined || !this.mayTouch(caller, entry.view.owner)) throw noTab(id);
    // Spec §12.1: while the person holds a tab, the agent's commands on it are refused. The person (a layer acting
    // for them, like the browser view's own back button) and a plugin's own code are not an agent.
    if (entry.view.heldByUser && caller.kind === "agent" && !opts.agentWhileHeld) {
      throw new BrowserError("held", "the person is using this tab in the browser view; try again once they let go of it");
    }
    return entry;
  }

  /** A bot's session: its bot's tabs. A session without a bot: its own. The person's tabs: only a session they said
   *  yes to (R10). The person and plugins' own code: any. */
  private mayTouch(caller: BrowserCaller, owner: TabOwner): boolean {
    if (caller.kind !== "agent") return true;
    if (owner.kind === "user") return caller.session !== undefined && this.opts.grants?.has(caller.session) === true;
    if (caller.bot !== undefined) return owner.kind === "bot" && owner.bot === caller.bot;
    return owner.kind === "session" && caller.session !== undefined && owner.session === caller.session;
  }

  private notYours(caller: BrowserCaller): BrowserError {
    const whose = caller.kind === "agent" && caller.bot !== undefined ? `${caller.bot}'s` : "its own";
    return new BrowserError("not_yours", `a session opens tabs only as ${whose}`);
  }

  private checkUrl(url: string): void {
    if (url.length > 8192 || !isBrowserUrlAllowed(url)) {
      throw new BrowserError("url_refused", `the browser doesn't open ${url.length > 200 ? `${url.slice(0, 200)}…` : url}: only web pages (and about:blank)`);
    }
  }

  private checkComputer(computer: string | undefined): void {
    if (computer !== undefined && computer !== this.opts.computer) {
      throw new BrowserError("no_app", `tabs on another computer (${computer}) aren't reachable from here yet`);
    }
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
    try {
      this.opts.emit?.(event);
    } catch {
      // Listeners never break the browser.
    }
  }
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
