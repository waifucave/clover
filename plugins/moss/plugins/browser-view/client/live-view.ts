// The live view's placement: which tab the browser shows in the view, and at what size.
//
// The browser draws a tab it shows as a native view above the page's DOM, laid out at the size it is given (spec
// §12.1, spike S7: "shown" in a view, no reload). This view only says which tab goes in the view and how big the
// frame is; the app's runtime (lane E) maps the view's name to where the frame is on screen.
//
// `LiveView` is the whole rule, free of React so a test can drive it:
//   * the first time a tab is wanted, and when the wanted tab changes, the old one goes back (`hide`) and the new
//     one goes in (`show`), at once;
//   * a resize of the frame waits for it to settle (`debounceMs`, 100 by default) and then shows the tab again at
//     the new size, which moves it without a reload;
//   * no tab wanted, or a frame with no size (a hidden panel), hides what is shown;
//   * calls go out one after another, so a `hide` is never overtaken by an earlier `show`;
//   * `claim` shows the wanted tab again, when the person uses this panel after another took the live view (R8).
import { useEffect, useRef } from "react";
import type { BrowserApi, TabView, Viewport } from "./types";

export const DEBOUNCE_MS = 100;

/** What the view wants shown now: a tab and the frame's size in whole CSS pixels. */
export interface LiveTarget {
  id: string;
  size: Viewport;
}

/** What a `LiveView` tells its owner. */
export interface LiveViewHandlers {
  /** A `show` that failed (a `hide` that failed is not worth saying: the tab it hides may be gone). */
  onError: (error: unknown) => void;
  /** The tab as the browser says it now, after a `show` or a `hide`. */
  onTab: (tab: TabView) => void;
}

export class LiveView {
  private shown: LiveTarget | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly api: Pick<BrowserApi, "show" | "hide">,
    /** The browser view's name: the panel's key. */
    private readonly view: string,
    private readonly handlers: LiveViewHandlers,
    private readonly debounceMs: number = DEBOUNCE_MS,
  ) {}

  /** The tab the browser was last told to show, if any. */
  get current(): string | null {
    return this.shown?.id ?? null;
  }

  /** Says what should be shown now (null: nothing). Call it as often as the target changes. */
  set(target: LiveTarget | null): void {
    if (this.disposed) return;
    if (target === null) {
      this.clearTimer();
      this.hideShown();
      return;
    }
    if (this.shown?.id !== target.id) {
      // Another tab: no waiting. The old one goes back to headless first.
      this.clearTimer();
      this.hideShown();
      this.shown = { id: target.id, size: target.size };
      this.show(target);
      return;
    }
    if (sameSize(this.shown.size, target.size)) {
      this.clearTimer();
      return;
    }
    // The same tab at another size: wait for the resize to settle, then move it.
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.shown === null) return;
      this.shown = { id: target.id, size: target.size };
      this.show(target);
    }, this.debounceMs);
  }

  /** The person used this panel again after another panel took the live view (ruling R8): the tab it wants goes back
   *  in its view at once. */
  claim(): void {
    if (this.disposed || this.shown === null) return;
    this.clearTimer();
    this.show(this.shown);
  }

  /** The panel is going away: whatever is shown goes back, and nothing more is sent. */
  dispose(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.hideShown();
    this.disposed = true;
  }

  /** Waits for the calls sent so far; for tests. */
  settled(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private hideShown(): void {
    const old = this.shown;
    this.shown = null;
    if (old === null) return;
    this.enqueue(() => this.api.hide(old.id), () => undefined);
  }

  private show(target: LiveTarget): void {
    this.enqueue(() => this.api.show(target.id, this.view, { width: target.size.width, height: target.size.height }), this.handlers.onError);
  }

  private enqueue(call: () => Promise<TabView>, onError: (error: unknown) => void): void {
    this.chain = this.chain.then(call).then(
      (tab) => this.handlers.onTab(tab),
      (error) => onError(error),
    );
  }
}

function sameSize(a: Viewport, b: Viewport): boolean {
  return a.width === b.width && a.height === b.height;
}

/** Keeps a `LiveView` for the panel's lifetime and points it at `target` as it changes. `api` is the browser API
 *  (without one, nothing is shown). On unmount the shown tab is hidden. */
export function useLiveView(
  api: Pick<BrowserApi, "show" | "hide"> | undefined,
  view: string,
  target: LiveTarget | null,
  handlers: LiveViewHandlers,
  debounceMs: number = DEBOUNCE_MS,
): { claim: () => void } {
  const live = useRef<LiveView | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // One controller per API (and view): it is rebuilt only if either changes, hiding what the old one showed.
  useEffect(() => {
    if (!api) return;
    const controller = new LiveView(
      api,
      view,
      { onError: (e) => handlersRef.current.onError(e), onTab: (t) => handlersRef.current.onTab(t) },
      debounceMs,
    );
    live.current = controller;
    return () => {
      controller.dispose();
      if (live.current === controller) live.current = null;
    };
  }, [api, view, debounceMs]);

  // Declared after the controller's effect, so on mount the controller exists when the target is set.
  const id = target?.id;
  const width = target?.size.width;
  const height = target?.size.height;
  useEffect(() => {
    live.current?.set(id === undefined || width === undefined || height === undefined ? null : { id, size: { width, height } });
  }, [api, view, debounceMs, id, width, height]);

  return { claim: () => live.current?.claim() };
}
