// The browser's `computer` field across computers (plan §4 L, M2; spec §12.1: "Clover runs its own browser, headless,
// on each computer"). Each computer's tabs live in its own browser, driven by its own daemon. A call that names
// another computer goes there over the link (lane H's `LinkTransport`, found through lane J's computers), and that
// computer's `BrowserService` answers it under its own rules: the holder decides, as lane J's holders do for the tree.
//
// What a peer's call may be, at the holder:
// * Always an agent's: the session (and its bot) the calling computer names, held to the same rules as a local
//   session of the same bot: a bot's session reaches only its bot's tabs, a session without a bot only its own. A
//   peer never acts as the person, a plugin's own code or the core.
// * Never the person's own tabs: R10's card is per session and is the holder's to ask, and a session on another
//   computer holds no grant here, so the holder refuses (`needs_ok`) as it would a local session without one.
// * Never `show`: a tab is shown only in its own computer's app. Another device watches it as a stream
//   (`browser.stream`, `stream.ts`).
// * Only from a device `mayCall` accepts (a paired computer, not revoked).
//
// The holder tells each calling device about the tabs it has opened or used there (`tab_changed`, `tab_closed`), and
// about DevTools events on the tabs it follows (`cdp_event`), so the caller's own events carry them.
import type { Link, LinkTransport } from "../contracts/link-transport";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { Screenshot, ScreenshotFormat, TabOwner, TabView, Viewport } from "./contract";
import { BrowserError, type BrowserErrorCode } from "./policy";
import type { BrowserCaller, BrowserEvent, BrowserService, CdpListener } from "./service";

/** Lane J's computers, as the browser needs them, and lane H's link. */
export interface BrowserPeers {
  transport: LinkTransport;
  /** A computer by name: the device that runs it, and whether it is online now. */
  computer(name: string): { device: string; online: boolean } | undefined;
  /** Whether `device` may call this computer's browser at all (a paired computer, not revoked). */
  mayCall(device: string): boolean;
  timeoutMs?: number;
}

/** Who a peer's call is for, on the wire: the calling computer's session and its bot. */
interface As {
  session?: string;
  bot?: string;
}

const METHODS = ["browser.tabs", "browser.open", "browser.close", "browser.navigate", "browser.hide", "browser.screenshot", "browser.cdp", "browser.cdp.watch", "browser.cdp.unwatch"] as const;

function asOf(caller: BrowserCaller): As {
  if (caller.kind !== "agent") {
    throw new BrowserError("not_yours", "another computer's tabs are reachable only from a session (a bot's, or a coding session), never as the person or a plugin's own code");
  }
  return { ...(caller.session !== undefined ? { session: caller.session } : {}), ...(caller.bot !== undefined ? { bot: caller.bot } : {}) };
}

function callerOf(raw: unknown): BrowserCaller {
  const a = (raw ?? {}) as Partial<As>;
  const ok = (v: unknown) => v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 128);
  if (!ok(a.session) || !ok(a.bot) || (a.session === undefined && a.bot === undefined)) {
    throw new ContractError("invalid", "a peer's browser call names the session it is for");
  }
  return { kind: "agent", ...(a.bot !== undefined ? { bot: a.bot } : {}), ...(a.session !== undefined ? { session: a.session } : {}) };
}

/** A BrowserError as it crosses the link (a ContractError keeps its code there), and back. */
function toWire(e: unknown): unknown {
  if (e instanceof BrowserError) return new ContractError("failed", e.message, { browser: e.code });
  return e;
}

function fromWire(computer: string, e: unknown): BrowserError {
  if (e instanceof BrowserError) return e;
  if (e instanceof ContractError) {
    const code = e.detail?.["browser"];
    if (typeof code === "string") return new BrowserError(code as BrowserErrorCode, e.message);
    if (e.code === "offline" || e.code === "closed" || e.code === "computer_offline" || e.code === "timeout") {
      return new BrowserError("computer_offline", `${computer} is offline, so its browser can't be reached; try again when it's back`);
    }
    return new BrowserError("app_failed", e.message);
  }
  return new BrowserError("app_failed", e instanceof Error ? e.message : String(e));
}

/** The holder's side: serves another computer's calls on this computer's browser. */
export function serveBrowserPeers(o: { service: BrowserService; peers: BrowserPeers }): Unsubscribe {
  const t = o.peers.transport;
  const offs: Unsubscribe[] = [];
  /** Which devices hear about which tabs: those that opened or used them. */
  const followers = new Map<string, Set<string>>();
  /** DevTools subscriptions, by device and tab. */
  const cdpWatches = new Map<string, Unsubscribe>();
  const follow = (device: string, id: string) => {
    let set = followers.get(id);
    if (set === undefined) followers.set(id, (set = new Set()));
    set.add(device);
  };
  const tell = (device: string, method: string, params: unknown) => {
    void t.connect(device).then((l: Link) => l.notify(method, params, { priority: "tokens" }), () => undefined);
  };
  const guard = (from: string) => {
    if (!o.peers.mayCall(from)) throw new ContractError("refused", "this computer isn't paired with yours");
  };
  const handle = (method: (typeof METHODS)[number], fn: (p: Record<string, unknown>, caller: BrowserCaller, from: string) => unknown) => {
    offs.push(t.handle(method, async (raw, from) => {
      guard(from);
      const p = (raw ?? {}) as Record<string, unknown>;
      const caller = callerOf(p["as"]);
      try {
        return await fn(p, caller, from);
      } catch (e) {
        throw toWire(e);
      }
    }));
  };
  const str = (p: Record<string, unknown>, k: string): string => {
    const v = p[k];
    if (typeof v !== "string" || v.length === 0 || v.length > 8192) throw new ContractError("invalid", `${k} is missing`);
    return v;
  };

  handle("browser.tabs", (p, caller) => {
    const owner = p["owner"] as TabOwner | undefined;
    return { tabs: o.service.tabs(caller, owner !== undefined ? { owner } : {}) };
  });
  handle("browser.open", async (p, caller, from) => {
    if (p["show"] !== undefined) throw new BrowserError("not_yours", "a tab on another computer is shown only in that computer's app; watch it as a stream");
    const tab = await o.service.open(caller, { owner: p["owner"] as TabOwner, ...(typeof p["url"] === "string" ? { url: p["url"] } : {}) });
    follow(from, tab.id);
    return { tab };
  });
  handle("browser.close", async (p, caller) => {
    await o.service.close(caller, str(p, "id"));
    return { ok: true };
  });
  handle("browser.navigate", async (p, caller, from) => {
    const tab = await o.service.navigate(caller, str(p, "id"), str(p, "url"));
    follow(from, tab.id);
    return { tab };
  });
  handle("browser.hide", async (p, caller) => ({ tab: await o.service.hide(caller, str(p, "id")) }));
  handle("browser.screenshot", async (p, caller) => o.service.screenshot(caller, str(p, "id"), {
    ...(typeof p["format"] === "string" ? { format: p["format"] as ScreenshotFormat } : {}),
    ...(typeof p["quality"] === "number" ? { quality: p["quality"] } : {}),
  }));
  handle("browser.cdp", async (p, caller, from) => {
    const id = str(p, "id");
    follow(from, id);
    return {
      result: await o.service.cdp(caller, id, str(p, "method"), p["params"] as Record<string, unknown> | undefined, {
        ...(p["viewport"] !== undefined ? { viewport: p["viewport"] as Viewport } : {}),
      }),
    };
  });
  handle("browser.cdp.watch", (p, caller, from) => {
    const id = str(p, "id");
    const key = `${from}\u0000${id}`;
    if (!cdpWatches.has(key)) {
      cdpWatches.set(key, o.service.onCdpEvent(caller, id, (method, params) => tell(from, "cdp_event", { tab: id, method, params })));
    }
    follow(from, id);
    return { ok: true };
  });
  handle("browser.cdp.unwatch", (p, _caller, from) => {
    const key = `${from}\u0000${str(p, "id")}`;
    cdpWatches.get(key)?.();
    cdpWatches.delete(key);
    return { ok: true };
  });

  offs.push(o.service.onEvent((event) => {
    const id = event.type === "tab_changed" ? event.tab.id : event.id;
    const devices = followers.get(id);
    if (devices === undefined) return;
    for (const device of devices) tell(device, event.type, event.type === "tab_changed" ? { tab: event.tab } : { id: event.id, computer: event.computer });
    if (event.type === "tab_closed") {
      followers.delete(id);
      for (const [key, off] of cdpWatches) {
        if (key.endsWith(`\u0000${id}`)) {
          off();
          cdpWatches.delete(key);
        }
      }
    }
  }));
  // A device whose link went down hears nothing more; its DevTools subscriptions end.
  offs.push(t.watch((view) => {
    if (view.up) return;
    for (const set of followers.values()) set.delete(view.peer);
    for (const [key, off] of cdpWatches) {
      if (key.startsWith(`${view.peer}\u0000`)) {
        off();
        cdpWatches.delete(key);
      }
    }
  }));
  return () => {
    for (const off of offs) off();
    for (const off of cdpWatches.values()) off();
    cdpWatches.clear();
  };
}

interface RemoteTab {
  computer: string;
  device: string;
}

/** The calling side: another computer's tabs, reached for this computer's sessions. `BrowserService` holds one when
 *  it has peers. */
export class RemoteBrowsers {
  /** Remote tabs this computer opened or listed, by id: where each lives. */
  private readonly tabs = new Map<string, RemoteTab>();
  private readonly listeners = new Map<string, Set<CdpListener>>();
  private readonly offs: Unsubscribe[] = [];

  constructor(private readonly peers: BrowserPeers, private readonly emit: (event: BrowserEvent) => void) {
    const t = peers.transport;
    this.offs.push(t.onNotify("tab_changed", (params, from) => {
      const tab = (params as { tab?: TabView }).tab;
      if (tab === undefined || this.tabs.get(tab.id)?.device !== from) return;
      this.emit({ type: "tab_changed", tab });
    }));
    this.offs.push(t.onNotify("tab_closed", (params, from) => {
      const p = params as { id?: string; computer?: string };
      const r = p.id !== undefined ? this.tabs.get(p.id) : undefined;
      if (r === undefined || r.device !== from) return;
      this.tabs.delete(p.id!);
      this.listeners.delete(p.id!);
      this.emit({ type: "tab_closed", id: p.id!, computer: r.computer });
    }));
    this.offs.push(t.onNotify("cdp_event", (params, from) => {
      const p = params as { tab?: string; method?: string; params?: unknown };
      if (p.tab === undefined || typeof p.method !== "string" || this.tabs.get(p.tab)?.device !== from) return;
      for (const fn of this.listeners.get(p.tab) ?? []) {
        try {
          fn(p.method, p.params);
        } catch {
          // One listener's mistake never stops the others.
        }
      }
    }));
  }

  /** Whether `id` is another computer's tab this computer knows of. */
  has(id: string): boolean {
    return this.tabs.has(id);
  }

  computerOf(id: string): string | undefined {
    return this.tabs.get(id)?.computer;
  }

  async list(caller: BrowserCaller, computer: string, owner?: TabOwner): Promise<TabView[]> {
    const { tabs } = await this.call<{ tabs: TabView[] }>(computer, "browser.tabs", caller, owner !== undefined ? { owner } : {});
    const device = this.where(computer).device;
    for (const tab of tabs) this.tabs.set(tab.id, { computer, device });
    return tabs;
  }

  async open(caller: BrowserCaller, computer: string, args: { owner: TabOwner; url?: string }): Promise<TabView> {
    const { tab } = await this.call<{ tab: TabView }>(computer, "browser.open", caller, { owner: args.owner, ...(args.url !== undefined ? { url: args.url } : {}) });
    this.tabs.set(tab.id, { computer, device: this.where(computer).device });
    this.emit({ type: "tab_changed", tab });
    return tab;
  }

  async close(caller: BrowserCaller, id: string): Promise<void> {
    await this.onTab(caller, id, "browser.close", {});
    const r = this.tabs.get(id);
    this.tabs.delete(id);
    this.listeners.delete(id);
    if (r !== undefined) this.emit({ type: "tab_closed", id, computer: r.computer });
  }

  async navigate(caller: BrowserCaller, id: string, url: string): Promise<TabView> {
    return (await this.onTab<{ tab: TabView }>(caller, id, "browser.navigate", { url })).tab;
  }

  async hide(caller: BrowserCaller, id: string): Promise<TabView> {
    return (await this.onTab<{ tab: TabView }>(caller, id, "browser.hide", {})).tab;
  }

  async screenshot(caller: BrowserCaller, id: string, opts: { format?: ScreenshotFormat; quality?: number }): Promise<Screenshot> {
    return this.onTab(caller, id, "browser.screenshot", { ...opts }, { priority: "screenshots" });
  }

  async cdp(caller: BrowserCaller, id: string, method: string, params: Record<string, unknown> | undefined, viewport: Viewport | undefined): Promise<unknown> {
    return (await this.onTab<{ result: unknown }>(caller, id, "browser.cdp", { method, ...(params !== undefined ? { params } : {}), ...(viewport !== undefined ? { viewport } : {}) })).result;
  }

  async onCdpEvent(caller: BrowserCaller, id: string, listener: CdpListener): Promise<() => void> {
    let set = this.listeners.get(id);
    const first = set === undefined || set.size === 0;
    if (set === undefined) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    if (first) {
      try {
        await this.onTab(caller, id, "browser.cdp.watch", {});
      } catch (e) {
        set.delete(listener);
        throw e;
      }
    }
    return () => {
      const s = this.listeners.get(id);
      if (s === undefined || !s.delete(listener) || s.size > 0) return;
      void this.onTab(caller, id, "browser.cdp.unwatch", {}).catch(() => undefined);
    };
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  private where(computer: string): { device: string } {
    const c = this.peers.computer(computer);
    if (c === undefined) throw new BrowserError("no_computer", `there's no computer called ${computer.slice(0, 128)} among yours`);
    if (!c.online) throw new BrowserError("computer_offline", `${computer} is offline, so its browser can't be reached; try again when it's back`);
    return c;
  }

  private async onTab<R>(caller: BrowserCaller, id: string, method: string, params: Record<string, unknown>, opts: { priority?: "screenshots" } = {}): Promise<R> {
    const r = this.tabs.get(id);
    if (r === undefined) throw new BrowserError("no_tab", `there's no tab ${id.slice(0, 64)} that this caller can use`);
    return this.call<R>(r.computer, method, caller, { id, ...params }, opts);
  }

  private async call<R>(computer: string, method: string, caller: BrowserCaller, params: Record<string, unknown>, opts: { priority?: "screenshots" } = {}): Promise<R> {
    const as = asOf(caller);
    const { device } = this.where(computer);
    try {
      const link = await this.peers.transport.connect(device);
      return await link.request<R>(method, { ...params, as }, { ...(this.peers.timeoutMs !== undefined ? { timeoutMs: this.peers.timeoutMs } : { timeoutMs: 60_000 }), ...opts });
    } catch (e) {
      throw fromWire(computer, e);
    }
  }
}
