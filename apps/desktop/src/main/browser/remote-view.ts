// MOSS Code's browser panel while the background host runs the pages (spec revision 19 §12.1, item 111; lane HS): the
// window half. The pages stay in the host; the window shows a tab from the engine's `picture.frame` notifications on
// its own `browser.view.open` stream, drawn by the same viewport page a local tab uses, and sends the person's input as
// `browser.view.input` on that stream (`remote-input.ts` says which input is the person's own).
//
// * Which tab shows where: the tab whose `view` is the panel's view name and whose place is `shown` (the engine's
//   `tab_changed`), in the place the view's frame has in the window now (`ViewFrames`). Only a code session's tab or
//   the person's own: MOSS Code's window shows no bot's tab (the engine refuses one too).
// * Nothing of a plugin reaches it: the viewport is the app's own view (its own partition, no network, its page only),
//   its input comes in on its own contents only, and `browser.view.input` leaves from the main process's own connection.
// * `RemoteViews` is the logic, over `RemoteViewDeps`; `electronRemoteViewport` makes the drawn view (Electron).
import type { TabInputEvent, TabView } from "@waifucave/moss-protocol";
import { RealInput, tabInputOf } from "./remote-input";
import type { ViewportInput } from "./viewport";

export interface RemoteTarget { windowId: number; bounds: { x: number; y: number; width: number; height: number } }

/** The drawn view of one panel: Electron's in the app, a fake in the tests. */
export interface RemoteViewport {
  place(target: RemoteTarget): void;
  /** One picture (a jpeg, png or webp, base64). */
  draw(frame: { format: string; width: number; height: number; data: string }): void;
  /** The page's input, with whether it has the keyboard focus. */
  onInput(fn: (ev: ViewportInput, focused: boolean) => void): void;
  /** The real input the main process saw on the view's own contents. */
  real: RealInput;
  destroy(): void;
}

export interface RemoteViewDeps {
  request(method: string, params: unknown): Promise<unknown>;
  makeViewport(): RemoteViewport;
  log?(line: string): void;
}

interface Open { tab: string; stream?: string; vp: RemoteViewport; opening: boolean; closed: boolean }

const SHOWN_HERE = (t: TabView) => t.place === "shown" && (t.owner.kind === "session" || t.owner.kind === "user");

export class RemoteViews {
  readonly #tabs = new Map<string, TabView>();
  readonly #targets = new Map<string, RemoteTarget>();
  readonly #open = new Map<string, Open>(); // by view name
  readonly #byStream = new Map<string, Open>();
  #on = false;

  constructor(private readonly deps: RemoteViewDeps) {}

  /** Whether the window shows the host's tabs (no browser of its own runs here). */
  enable(on: boolean): void {
    if (on === this.#on) return;
    this.#on = on;
    for (const view of new Set([...this.#targets.keys(), ...this.#open.keys()])) this.#sync(view);
  }

  setTarget(view: string, target: RemoteTarget | undefined): void {
    if (target === undefined) this.#targets.delete(view); else this.#targets.set(view, target);
    this.#sync(view);
  }

  tabChanged(tab: TabView): void {
    const before = this.#tabs.get(tab.id)?.view;
    this.#tabs.set(tab.id, tab);
    for (const view of new Set([before, tab.view].filter((v): v is string => v !== undefined))) this.#sync(view);
  }

  tabClosed(id: string): void {
    const view = this.#tabs.get(id)?.view;
    this.#tabs.delete(id);
    if (view !== undefined) this.#sync(view);
  }

  /** A `picture.frame` notification: drawn in the view whose stream it is. */
  frame(p: { stream?: unknown; format?: unknown; width?: unknown; height?: unknown; data?: unknown }): void {
    const o = typeof p.stream === "string" ? this.#byStream.get(p.stream) : undefined;
    if (o === undefined || o.closed || typeof p.data !== "string" || typeof p.format !== "string") return;
    o.vp.draw({ format: p.format, width: Number(p.width) || 0, height: Number(p.height) || 0, data: p.data });
  }

  /** The views showing a tab now (diagnostics and tests). */
  showing(): { view: string; tab: string; stream?: string }[] {
    return [...this.#open].map(([view, o]) => ({ view, tab: o.tab, ...(o.stream !== undefined ? { stream: o.stream } : {}) }));
  }

  dispose(): void {
    for (const view of [...this.#open.keys()]) this.#close(view);
  }

  #sync(view: string): void {
    const target = this.#targets.get(view);
    const tab = this.#on && target !== undefined ? [...this.#tabs.values()].find((t) => t.view === view && SHOWN_HERE(t)) : undefined;
    const open = this.#open.get(view);
    if (open !== undefined && (tab === undefined || open.tab !== tab.id)) this.#close(view);
    if (tab === undefined || target === undefined) return;
    const now = this.#open.get(view);
    if (now !== undefined) { now.vp.place(target); return; }
    const vp = this.deps.makeViewport();
    vp.place(target);
    const o: Open = { tab: tab.id, vp, opening: true, closed: false };
    this.#open.set(view, o);
    vp.onInput((ev, focused) => this.#input(o, ev, focused));
    const size = { width: Math.max(16, Math.round(target.bounds.width)), height: Math.max(16, Math.round(target.bounds.height)) };
    this.deps.request("browser.view.open", { tab: tab.id, viewport: size }).then((r) => {
      const stream = (r as { stream?: unknown }).stream;
      o.opening = false;
      if (typeof stream !== "string") return;
      if (o.closed) { void this.deps.request("browser.view.close", { stream }).catch(() => undefined); return; }
      o.stream = stream;
      this.#byStream.set(stream, o);
      this.deps.log?.(`browser: view ${view} shows the host's tab ${tab.id}`);
    }, (e: unknown) => {
      o.opening = false;
      this.deps.log?.(`browser: the host's tab ${tab.id} didn't open in view ${view}: ${(e as Error).message}`);
    });
  }

  #close(view: string): void {
    const o = this.#open.get(view);
    if (o === undefined) return;
    this.#open.delete(view);
    o.closed = true;
    o.vp.destroy();
    if (o.stream !== undefined) {
      this.#byStream.delete(o.stream);
      void this.deps.request("browser.view.close", { stream: o.stream }).catch(() => undefined);
    }
  }

  #input(o: Open, ev: ViewportInput, focused: boolean): void {
    if (o.closed || o.stream === undefined) return;
    const t = tabInputOf(ev);
    if (t === undefined) return;
    // The person's own press in the panel's own frame, or nothing (remote-input.ts).
    if (!o.vp.real.takes(t, focused)) { this.deps.log?.(`browser: input to the host's tab ${o.tab} refused (${t.kind}: no real press in the panel)`); return; }
    const events: TabInputEvent[] = [t];
    void this.deps.request("browser.view.input", { stream: o.stream, events }).catch(() => undefined);
  }
}
