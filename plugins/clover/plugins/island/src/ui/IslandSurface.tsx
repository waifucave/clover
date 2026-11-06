// The island as an `app.surface` entry (spec §10): the same island on every OS, placed by `islandPlacement`. On a Mac
// with a camera housing it grows from the housing; elsewhere from the top edge; on Wayland it is a normal window,
// always open, where every card waits in Needs you.
//
// An overlay's window is only ever what the island draws (`overlayWindow`): the strip, the card and the newcomer under
// it, or the open island, and nothing between them and the frame's edges. So the island never lies over anything it
// doesn't draw on, a sealed card's buttons in Clover's own windows included (E-M3's overlap check counts Clover's own
// surfaces, ruling R12), and it is hidden when it draws nothing. Inside that window the clicks it takes are its
// regions; every other click passes through.
//
// The surface host is lane E's: it opens the window the placement asks for, keeps it on the display the user works
// on, and passes clicks outside the regions through. Until E-M2's runtime hands it over, the gallery and the tests
// give a stand-in (`SurfaceHostApi`).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { Rect } from "../model/geometry";
import { islandPlacement, overlayWindow, toFrameRect, type SurfaceEnvironment, type SurfaceWindowSpec } from "../model/placement";
import type { IslandCard, QuestionCard } from "../model/cards";
import { Island, type IslandTabEntry, type IslandTimers } from "./Island";

/** What the island needs from its window (lane E's surface host). */
export interface SurfaceHostApi {
  /** Open the window this way, or move, resize or hide it. Called again only when it changes. */
  setWindow(spec: SurfaceWindowSpec): void;
  /** The regions that take clicks, in the window's own space; every other click passes through an overlay. */
  setInteractiveRegions(regions: readonly Rect[]): void;
}

export interface IslandSurfaceProps {
  environment: SurfaceEnvironment;
  /** Every pending card, oldest first. */
  cards: readonly IslandCard[];
  working?: number;
  /** The `island.tab` entries after Needs you, in their order. */
  tabs?: readonly IslandTabEntry[];
  /** The bots' names and ids: another plugin named as one gets no tab. */
  botNames?: readonly string[];
  onAnswerQuestion?: (card: QuestionCard, answers: Record<string, string>) => Promise<boolean> | boolean | void;
  host?: SurfaceHostApi;
  reducedMotion?: boolean;
  timers?: IslandTimers;
}

export function IslandSurface(props: IslandSurfaceProps): ReactElement {
  const { environment, host } = props;
  const placement = islandPlacement(environment);
  const placementKey = JSON.stringify(placement.window);
  // Every field of the placement the host acts on, compared as a whole: a new display or a display that moved.
  const stable = useMemo(() => placement, [placementKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const overlay = stable.window.overlay;
  const frame = stable.window.bounds;
  /** Where the overlay's window lies in its frame, once the island has said what it draws. */
  const [offset, setOffset] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const lastSpec = useRef<string | null>(null);
  const lastRegions = useRef<string | null>(null);

  const setWindow = useCallback(
    (spec: SurfaceWindowSpec) => {
      const key = JSON.stringify(spec);
      if (key === lastSpec.current) return;
      lastSpec.current = key;
      host?.setWindow(spec);
    },
    [host],
  );
  const setRegions = useCallback(
    (regions: readonly Rect[]) => {
      const key = JSON.stringify(regions);
      if (key === lastRegions.current) return;
      lastRegions.current = key;
      host?.setInteractiveRegions(regions);
    },
    [host],
  );

  // A normal window is the placement's own, and takes every click inside it.
  useEffect(() => {
    lastSpec.current = null;
    lastRegions.current = null;
    if (overlay) return;
    setWindow(stable.window);
    setRegions([{ x: 0, y: 0, width: stable.window.bounds.width, height: stable.window.bounds.height }]);
  }, [stable, overlay, setWindow, setRegions]);

  const onRegions = useCallback(
    (regions: readonly Rect[], drawn: readonly Rect[]) => {
      if (!overlay) return;
      const { spec, offset: at } = overlayWindow(stable, drawn);
      setWindow(spec);
      setRegions(
        regions.map((r) => {
          // Outward to whole pixels, as the window is: a region never loses its edge to rounding.
          const f = toFrameRect(r, frame);
          const x = Math.floor(f.x - at.x);
          const y = Math.floor(f.y - at.y);
          return { x, y, width: Math.ceil(f.x + f.width - at.x) - x, height: Math.ceil(f.y + f.height - at.y) - y };
        }),
      );
      setOffset((o) => (o && o.x === at.x && o.y === at.y && o.width === spec.bounds.width && o.height === spec.bounds.height ? o : { ...at, width: spec.bounds.width, height: spec.bounds.height }));
    },
    [stable, overlay, frame, setWindow, setRegions],
  );

  const island = (
    <Island
      shape={placement.shape}
      cards={props.cards}
      working={props.working}
      tabs={props.tabs}
      botNames={props.botNames}
      onAnswerQuestion={props.onAnswerQuestion}
      alwaysOpen={placement.mode === "window"}
      onRegions={onRegions}
      reducedMotion={props.reducedMotion}
      timers={props.timers}
    />
  );
  if (!overlay) {
    return (
      <div className="clv-surface" data-mode={placement.mode}>
        {island}
      </div>
    );
  }
  // The window's content: the frame the island lays itself out in, moved so the window's corner is the frame's
  // `offset`; what lies outside the window is not shown.
  const at = offset ?? { x: 0, y: 0, width: frame.width, height: frame.height };
  return (
    <div className="clv-surface" data-mode={placement.mode} style={{ position: "relative", width: at.width, height: at.height, overflow: "hidden" }}>
      <div className="clv-surface-frame" style={{ position: "absolute", left: -at.x, top: -at.y, width: frame.width, height: frame.height }}>
        {island}
      </div>
    </div>
  );
}
