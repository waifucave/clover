// What a surface part says to its window, merged before it is sent (see `coalesced`).

/** The part's side of the surface host: the island's and the pill's `SurfaceHostApi`, structurally. */
export interface CoalescedHost {
  setWindow(spec: { visible?: boolean; bounds?: unknown }): void;
  setInteractiveRegions(regions: readonly unknown[]): void;
  dispose(): void;
}

/* A surface's window and regions are one request to the broker, not two: what the island asks in a render (its bounds
 * and its regions) is merged and sent once per frame's time (16 ms, a timer: a hidden window's animation frames don't
 * run, and a surface starts hidden), so the window moves once however many changes an animation makes. */
const COALESCE_MS = 16;
type Patch = { visible?: boolean; bounds?: unknown; regions?: unknown };
const area = (regions: unknown): number => (Array.isArray(regions) ? regions.reduce((n: number, r: { width?: number; height?: number }) => n + Math.max(0, r.width ?? 0) * Math.max(0, r.height ?? 0), 0) : 0);
export function coalesced(surface: (patch: Patch) => unknown): CoalescedHost {
  let pending: Patch | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shown = false;
  let regionsArea = 0;
  let gone = false;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const out = pending;
    pending = undefined;
    if (out !== undefined && !gone) void surface(out);
  };
  const push = (patch: Patch) => {
    pending = Object.assign(pending ?? {}, patch);
    // Goes at once: a window asking to be shown for the first time (a hidden window's timers are throttled), and a region
    // that shrinks (a click must never land on what was drawn away). Growth and the rest ride the frame's time.
    const showing = patch.visible === true && !shown;
    if (patch.visible !== undefined) shown = patch.visible;
    let shrinks = false;
    if (patch.regions !== undefined) {
      const next = area(patch.regions);
      shrinks = next < regionsArea;
      regionsArea = next;
    }
    if (showing || shrinks) queueMicrotask(flush);
    else if (timer === undefined) timer = setTimeout(flush, COALESCE_MS);
  };
  return {
    setWindow: (spec) => push({ visible: spec.visible !== false, bounds: spec.bounds }),
    setInteractiveRegions: (regions) => push({ regions }),
    // The part is gone: what is waiting is dropped and its timer cleared.
    dispose: () => { gone = true; pending = undefined; if (timer !== undefined) clearTimeout(timer); timer = undefined; },
  };
}

