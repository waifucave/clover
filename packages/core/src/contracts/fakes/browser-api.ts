// FakeBrowser: tabs as records, with the places, holds, viewport and allow-list rules, and DevTools answers a test
// scripts. Nothing renders: a screenshot is a 1-pixel PNG at the tab's size, unless the test made its host stall.
import { AGENT_VIEWPORT, isCdpMethodAllowed, type Caller, type Screenshot, type TabOwner, type TabView, type Viewport } from "@waifucave/clover-protocol";
import type { Clock, TimerHandle } from "../clock";
import { ContractError, isInside, Listeners, normalizePosix, type Unsubscribe } from "../common";
import { CDP_PATH_PARAMS, mayActOnHeldTab, sameViewport, type BrowserApi, type BrowserChange, type CdpOptions } from "../browser-api";

/** A 1×1 transparent PNG. */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** How long a tab no bot uses waits before it rests (S7 edit 2: "a few minutes"); lane L picks the real number. */
export const FAKE_REST_AFTER_MS = 3 * 60_000;

interface Tab {
  view: TabView;
  shownIn?: string;
  stalledSince?: number;
  restTimer?: TimerHandle;
  events: Listeners<{ method: string; params: unknown }>;
}

export class FakeBrowser implements BrowserApi {
  readonly computer: string;
  readonly #clock: Clock;
  readonly #tabs = new Map<string, Tab>();
  readonly #listeners = new Listeners<BrowserChange>();
  readonly #scratchOf: (bot: string) => string;
  readonly #cdp = new Map<string, (params: Record<string, unknown> | undefined, tab: TabView) => unknown>();
  #seq = 0;

  constructor(opts: { clock: Clock; computer?: string; scratchOf?: (bot: string) => string }) {
    this.#clock = opts.clock;
    this.computer = opts.computer ?? "Studio";
    this.#scratchOf = opts.scratchOf ?? ((bot) => `/Users/me/.clover/scratch/${bot.replace("/", "--")}`);
  }

  /** Scripts a DevTools method's answer; unscripted allowed methods answer `{}`. */
  onCdp(method: string, fn: (params: Record<string, unknown> | undefined, tab: TabView) => unknown): void {
    this.#cdp.set(method, fn);
  }

  /** The page sends a DevTools event. */
  emitCdpEvent(id: string, method: string, params: unknown): void {
    this.#tabs.get(id)?.events.emit({ method, params: structuredClone(params) });
  }

  /** The tab's host window stopped drawing (or drew again). */
  setStalled(id: string, stalled: boolean): void {
    const t = this.#must(id);
    if (stalled) t.stalledSince = this.#clock.now();
    else delete t.stalledSince;
  }

  tabs(filter: { owner?: TabOwner } = {}): TabView[] {
    return [...this.#tabs.values()]
      .map((t) => t.view)
      .filter((v) => !filter.owner || JSON.stringify(v.owner) === JSON.stringify(filter.owner))
      .map((v) => structuredClone(v));
  }

  async open(req: { owner: TabOwner; url?: string; show?: { view: string; viewport: Viewport } }, _as: Caller): Promise<TabView> {
    const id = `tab_${++this.#seq}`;
    const view: TabView = {
      id, computer: this.computer, owner: structuredClone(req.owner),
      partition: req.owner.kind === "bot" ? `persist:bot-${req.owner.bot.replace("/", "--")}` : "persist:user",
      url: req.url ?? "about:blank", title: "", place: req.show ? "shown" : "headless",
      viewport: req.show ? { ...req.show.viewport } : { ...AGENT_VIEWPORT }, loading: false, heldByUser: false,
    };
    const tab: Tab = { view, events: new Listeners(), ...(req.show ? { shownIn: req.show.view } : {}) };
    this.#tabs.set(id, tab);
    this.#touch(tab);
    this.#changed(tab);
    return structuredClone(view);
  }

  async close(id: string, as: Caller): Promise<void> {
    const t = this.#must(id);
    this.#mayAct(t, as);
    if (t.restTimer) this.#clock.clearTimeout(t.restTimer);
    this.#tabs.delete(id);
    this.#listeners.emit({ type: "closed", id, by: as.kind === "user" ? "user" : "api" });
  }

  async navigate(id: string, url: string, as: Caller): Promise<TabView> {
    const t = this.#must(id);
    this.#mayAct(t, as);
    this.#wake(t);
    t.view = { ...t.view, url };
    this.#touch(t);
    this.#changed(t);
    return structuredClone(t.view);
  }

  async show(id: string, view: string, viewport: Viewport): Promise<TabView> {
    const t = this.#must(id);
    if (t.restTimer) this.#clock.clearTimeout(t.restTimer);
    t.shownIn = view;
    t.view = { ...t.view, place: "shown", viewport: { ...viewport } };
    this.#changed(t);
    return structuredClone(t.view);
  }

  async hide(id: string): Promise<TabView> {
    const t = this.#must(id);
    delete t.shownIn;
    t.view = { ...t.view, place: "headless", viewport: { ...AGENT_VIEWPORT }, heldByUser: false };
    this.#touch(t);
    this.#changed(t);
    return structuredClone(t.view);
  }

  async screenshot(id: string, as: Caller, opts: { format?: Screenshot["format"] } = {}): Promise<Screenshot> {
    const t = this.#must(id);
    this.#mayAct(t, as);
    this.#wake(t);
    if (t.stalledSince !== undefined) throw new ContractError("failed", `the tab's host stopped drawing ${this.#clock.now() - t.stalledSince} ms ago; no stale picture is given`);
    this.#touch(t);
    return { format: opts.format ?? "png", data: PIXEL_PNG, width: t.view.viewport.width, height: t.view.viewport.height, takenAt: this.#clock.now(), contentAgeMs: 0 };
  }

  async cdp(id: string, method: string, params: Record<string, unknown> | undefined, as: Caller, opts: CdpOptions = {}): Promise<unknown> {
    const t = this.#must(id);
    if (!isCdpMethodAllowed(method)) throw new ContractError("refused", `${method} isn't on the DevTools allow list`);
    this.#mayAct(t, as);
    this.#wake(t);
    if (opts.viewport && !sameViewport(opts.viewport, t.view.viewport)) {
      throw new ContractError("refused", `that point came from a ${opts.viewport.width}×${opts.viewport.height} picture; the tab is ${t.view.viewport.width}×${t.view.viewport.height} now: take a new screenshot`);
    }
    const pathParams = CDP_PATH_PARAMS[method];
    if (pathParams && t.view.owner.kind === "bot") {
      const scratch = this.#scratchOf(t.view.owner.bot);
      for (const key of pathParams) {
        const value = params?.[key];
        const paths = Array.isArray(value) ? value : value === undefined ? [] : [value];
        for (const p of paths) {
          if (typeof p !== "string" || !isInside(normalizePosix(p), scratch)) throw new ContractError("refused", `${method} may name only paths in the bot's scratch folder`);
        }
      }
    }
    this.#touch(t);
    const fn = this.#cdp.get(method);
    return structuredClone(fn ? await fn(params, structuredClone(t.view)) : {});
  }

  onCdpEvent(id: string, fn: (method: string, params: unknown) => void): Unsubscribe {
    return this.#must(id).events.add(({ method, params }) => fn(method, params));
  }

  setHeld(id: string, held: boolean): void {
    const t = this.#must(id);
    t.view = { ...t.view, heldByUser: held };
    this.#changed(t);
  }

  watch(fn: (change: BrowserChange) => void): Unsubscribe {
    return this.#listeners.add(fn);
  }

  #must(id: string): Tab {
    const t = this.#tabs.get(id);
    if (!t) throw new ContractError("not_found", `no tab ${id}`);
    return t;
  }

  #mayAct(t: Tab, as: Caller): void {
    if (t.view.heldByUser && !mayActOnHeldTab(as)) throw new ContractError("held", "the user is holding this tab; the agent's commands wait until they give it back");
  }

  /** A resting tab goes back to the host window before a command reaches it (S7 edit 2). */
  #wake(t: Tab): void {
    if (t.view.place !== "resting") return;
    t.view = { ...t.view, place: "headless", viewport: { ...AGENT_VIEWPORT } };
    this.#changed(t);
  }

  /** A headless tab no one uses rests after a while. */
  #touch(t: Tab): void {
    if (t.restTimer) this.#clock.clearTimeout(t.restTimer);
    if (t.view.place !== "headless") return;
    t.restTimer = this.#clock.setTimeout(() => {
      if (!this.#tabs.has(t.view.id) || t.view.place !== "headless") return;
      t.view = { ...t.view, place: "resting" };
      this.#changed(t);
    }, FAKE_REST_AFTER_MS);
  }

  #changed(t: Tab): void {
    this.#listeners.emit({ type: "changed", tab: structuredClone(t.view) });
  }
}
