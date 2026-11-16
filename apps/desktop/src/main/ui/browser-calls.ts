// The MOSS Browser from a component (browser-press, the coordinator's narrowing of F5): what a part's `browser.*` call
// is, by the main process's own reading of it (the core can't see a press, and must not trust a page's word).
//
// * LOOKING needs no press: the tab list (every owner's tabs, their addresses and titles), show and hide, the tab events
//   (`events.subscribe` of the `browser` area, `browser.onCdpEvent`), `browser.cdp`'s `Page.getNavigationHistory` (it
//   reads the history list and runs no page script; the bundled panel asks it to turn its Back and Forward on), and a
//   picture of the tab the calling part's own view is bound to, live or paused (the tab the user put in that panel;
//   another panel taking the live view doesn't unbind it: `ViewBindings`).
// * ACTING needs the user's own press in that part's frame: every other `browser.cdp` method (`Runtime.evaluate` and
//   `Input.*` among them), `browser.navigate`, `browser.open` for any owner (it takes an address: a signed-in navigation
//   as the person), `browser.close` (it destroys the person's page state), a picture of any other tab, and any
//   `browser.*` call this file doesn't know (fail closed for a future call). The press is the app's gesture rule
//   (`frameGesture`, electron.ts's `moss:api` handler): the frame's own transient activation AND a key press or click
//   the main process saw land IN that frame (lane G's per-frame record, `SendGate.takeIn`) within SEND_INPUT_WINDOW_MS,
//   spent by the call. A press in another frame of the window unlocks nothing. One press, one acting call.
// * A part kept in the background (`app.background`: a hidden window, no user in front of it) has no reach at all, and
//   hears no tab event (electron.ts's `api-event` delivery skips its documents).
//
// Each reaches the core two ways: as the core's own method (`browser.cdp` on the plugin's connection) or through the
// plugin API's layer door (`plugin.layer.call`/`plugin.layer.watch` naming `browser.cdp`); both are read here.

/** The `browser.cdp` methods a part may call with no press: they read, and run no page script. */
export const LOOKING_CDP_METHODS: ReadonlySet<string> = new Set(["Page.getNavigationHistory"]);

export type BrowserReach = { kind: "none" } | { kind: "look"; call: string } | { kind: "act"; call: string; why: string };

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The calls that only look, whatever their arguments. */
const LOOKING_CALLS: ReadonlySet<string> = new Set(["browser.tabs", "browser.show", "browser.hide", "browser.onCdpEvent"]);

/** What a part's call on the `moss:api` door is to the MOSS Browser. `showing(tab)`: whether the calling part is
 *  showing that tab in its own view now. */
export function browserReach(method: string, params: unknown, o: { showing?: (tab: string) => boolean } = {}): BrowserReach {
  const p = obj(params);
  if (method === "events.subscribe") {
    const areas = Array.isArray(p.areas) ? p.areas : [];
    return areas.includes("browser") ? { kind: "look", call: "events.subscribe browser" } : { kind: "none" };
  }
  let call: string;
  let cdpMethod: unknown;
  let tab: unknown;
  if (method === "plugin.layer.call" || method === "plugin.layer.watch") {
    if (typeof p.call !== "string" || !p.call.startsWith("browser.")) return { kind: "none" };
    call = p.call;
    const args = Array.isArray(p.args) ? p.args : [];
    cdpMethod = args[1];
    tab = args[0];
  } else if (method.startsWith("browser.")) {
    call = method;
    cdpMethod = p.method;
    tab = p.id;
  } else {
    return { kind: "none" };
  }
  if (LOOKING_CALLS.has(call)) return { kind: "look", call };
  if (call === "browser.cdp" && typeof cdpMethod === "string" && LOOKING_CDP_METHODS.has(cdpMethod)) return { kind: "look", call };
  if (call === "browser.screenshot" && typeof tab === "string" && o.showing?.(tab) === true) return { kind: "look", call };
  const why = call === "browser.cdp" ? `${call} ${typeof cdpMethod === "string" ? cdpMethod : ""}`.trim()
    : call === "browser.screenshot" ? "a picture of a tab this part isn't showing" : call;
  return { kind: "act", call, why };
}

/** Why a part's Browser call is refused, or undefined: it may go (a press, when it acts, taken by `takePress`). */
export function browserRefusal(reach: BrowserReach, o: { background: boolean; takePress: () => boolean }): string | undefined {
  if (reach.kind === "none") return undefined;
  if (o.background) return "a part kept in the background has no MOSS Browser: a live view needs a part the user can see";
  if (reach.kind === "act" && !o.takePress()) return `${reach.why} goes only right after your own key press or click in this part`;
  return undefined;
}

/** What the `browser` area tells (the tab changes; `daemon.ts` sends them to the layers of plugins holding `browser`). */
export const BROWSER_AREA_EVENTS: ReadonlySet<string> = new Set(["tab_changed", "tab_closed"]);

/** Whether a core event a plugin's connection heard is the MOSS Browser's: a tab's change, or the value of a watch on a
 *  `browser.*` call (`browserWatches`, noted as each opened). Such an event goes only to the plugin's documents the user
 *  can see, never to one kept in the background. */
export function isBrowserEvent(params: unknown, browserWatches: ReadonlySet<string>): boolean {
  const e = obj(params);
  if (typeof e.type === "string" && BROWSER_AREA_EVENTS.has(e.type)) return true;
  return e.type === "plugin_api_event" && typeof e.watch === "string" && browserWatches.has(e.watch);
}

/** The visible parts that subscribed to the `browser` area, by plugin: when the last one of a plugin goes, its plugin's
 *  connection is unsubscribed from the area (the connection, and the app's memory of what it subscribed to, outlive any
 *  one frame), so a plugin's background part never inherits a closed panel's tab events. */
export class BrowserAreaFrames {
  readonly #byPlugin = new Map<string, Set<string>>();

  /** A visible part subscribed. */
  add(pluginId: string, mount: string): void {
    const s = this.#byPlugin.get(pluginId) ?? new Set<string>();
    s.add(mount);
    this.#byPlugin.set(pluginId, s);
  }

  /** A part unsubscribed, or its frame went: the plugin whose last subscriber it was (to unsubscribe), or undefined. */
  gone(mount: string): string | undefined {
    for (const [pluginId, s] of this.#byPlugin) {
      if (!s.delete(mount)) continue;
      if (s.size > 0) return undefined;
      this.#byPlugin.delete(pluginId);
      return pluginId;
    }
    return undefined;
  }
}

/** Which tab each part's own browser view is bound to: the tab the user put in that panel (its last `show`, or an `open`
 *  that showed it at once), live or paused (another panel taking the live view doesn't unbind it); its `hide` or `close` of
 *  that tab, or the part going, unbinds it. A picture of the bound tab needs no press (the read's ruling on item 4). */
export class ViewBindings {
  readonly #byMount = new Map<string, string>();

  /** A part's Browser call answered: `method` and `params` as the part sent them, `result` the core's answer. */
  note(mount: string, method: string, params: unknown, result: unknown): void {
    const p = obj(params);
    let call = method;
    let args: unknown[] = [];
    if (method === "plugin.layer.call") {
      if (typeof p.call !== "string") return;
      call = p.call;
      args = Array.isArray(p.args) ? p.args : [];
    }
    const layer = method === "plugin.layer.call";
    const r = obj(result);
    const tabOf = (v: unknown): string | undefined => { const t = obj(v); return typeof t.id === "string" ? t.id : undefined; };
    // The core's method answers `{ tab }`; the layer door's call answers `{ result: tab }`.
    const answered = layer ? tabOf(r.result) : tabOf(r.tab);
    if (call === "browser.show") {
      const id = layer ? args[0] : p.id;
      if (typeof id === "string" && answered === id) this.#byMount.set(mount, id);
      return;
    }
    if (call === "browser.open") {
      const show = obj(layer ? args[0] : p).show;
      if (show !== undefined && answered !== undefined) this.#byMount.set(mount, answered);
      return;
    }
    if (call === "browser.hide" || call === "browser.close") {
      const id = layer ? args[0] : p.id;
      if (typeof id === "string" && this.#byMount.get(mount) === id) this.#byMount.delete(mount);
    }
  }

  /** The tab a part's view is bound to, or undefined. */
  bound(mount: string): string | undefined {
    return this.#byMount.get(mount);
  }

  /** The part went. */
  gone(mount: string): void {
    this.#byMount.delete(mount);
  }
}
