// The island as an `app.surface` entry (spec §10): the same island on every OS, placed by `islandPlacement`. On a Mac
// with a camera housing it grows from the housing; elsewhere from the top edge; on Wayland it is a normal window,
// always open, where every card waits in Needs you.
//
// The surface host is lane E's: it opens the window the placement asks for, keeps it on the display the user works
// on, and passes clicks outside the island's regions through to whatever lies below. Until E-M1's runtime hands it
// over, the gallery and the tests give a stand-in (`SurfaceHostApi`).

import { useEffect, useMemo, type ReactElement } from "react";
import type { Rect } from "../model/geometry";
import { islandPlacement, toWindowRect, type SurfaceEnvironment, type SurfaceWindowSpec } from "../model/placement";
import type { IslandCard, QuestionCard } from "../model/cards";
import { Island, type IslandTabEntry, type IslandTimers } from "./Island";

/** What the island needs from its window (lane E's surface host). */
export interface SurfaceHostApi {
  /** Open the window this way, or move it there. Called again only when the placement changes. */
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
  onAnswerQuestion?: (card: QuestionCard, answers: Record<string, string>) => Promise<boolean> | boolean | void;
  host?: SurfaceHostApi;
  reducedMotion?: boolean;
  timers?: IslandTimers;
}

export function IslandSurface(props: IslandSurfaceProps): ReactElement {
  const { environment, host } = props;
  const placement = islandPlacement(environment);
  const windowKey = JSON.stringify(placement.window);
  // Every field of the placement that the host acts on, compared as a whole: a new display or a display that moved.
  const stable = useMemo(() => placement, [windowKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    host?.setWindow(stable.window);
  }, [host, stable]);

  const onRegions = useMemo(
    () => (regions: readonly Rect[]) => {
      // A normal window takes every click inside it; only an overlay passes clicks through.
      if (!stable.window.overlay) host?.setInteractiveRegions([{ x: 0, y: 0, width: stable.window.bounds.width, height: stable.window.bounds.height }]);
      else host?.setInteractiveRegions(regions.map((r) => toWindowRect(r, stable)));
    },
    [host, stable],
  );

  return (
    <div className="clv-surface" data-mode={placement.mode}>
      <Island
        shape={placement.shape}
        cards={props.cards}
        working={props.working}
        tabs={props.tabs}
        onAnswerQuestion={props.onAnswerQuestion}
        alwaysOpen={placement.mode === "window"}
        onRegions={onRegions}
        reducedMotion={props.reducedMotion}
        timers={props.timers}
      />
    </div>
  );
}
