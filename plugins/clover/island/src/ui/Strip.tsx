// The slim strip extending the housing (Winter's `IslandStripView`). Idle — nothing waits, nothing works —
// it is the housing alone, black on black; while something waits it grows its wings: the amber hand and
// the count of every pending card on the left, the bolt and the working bots' count on the right.
// Without a housing it is a short tab hanging from the top centre. Static: it redraws only when a count
// changes. Under the pointer it glows dark.

import type { MouseEvent, ReactElement } from "react";
import { showsWings, stripPartAt, stripRect, type ScreenShape, type StripCounts, type StripPart } from "../model/geometry";
import { t } from "../strings";
import { Glyph } from "./glyphs";
import { useIslandStyles } from "./styles";

export interface StripProps {
  shape: ScreenShape;
  counts: StripCounts;
  hovered?: boolean;
  /** A click on a part of the strip (an empty wing is the housing's). */
  onPart?: (part: StripPart) => void;
}

export function stripLabel(counts: StripCounts): string {
  const waiting = counts.waiting === 0 ? t("clover.island.nothingNeedsYou") + "." : t("clover.island.needsYouCount", { count: counts.waiting });
  const working = counts.working === 0 ? "" : " " + t("clover.island.workingCount", { count: counts.working });
  return `${t("clover.island.label")} ${waiting}${working}`;
}

export function Strip({ shape, counts, hovered = false, onPart }: StripProps): ReactElement | null {
  useIslandStyles();
  const wings = showsWings(counts);
  const rect = stripRect(shape, wings);
  if (!rect) return null;

  const click = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left + rect.x;
    const part = stripPartAt({ x, y: event.clientY - box.top }, shape, counts) ?? "housing";
    onPart?.(part);
  };

  const waiting =
    counts.waiting > 0 ? (
      <span className="clv-strip-group" data-part="waiting">
        <Glyph name="hand" className="clv-attention" />
        <span>{counts.waiting}</span>
      </span>
    ) : null;
  const working =
    counts.working > 0 ? (
      <span className="clv-strip-group" data-part="working">
        <Glyph name="bolt" className="clv-working" />
        <span>{counts.working}</span>
      </span>
    ) : null;

  return (
    <div
      className="clv-strip"
      role="button"
      aria-label={stripLabel(counts)}
      data-hovered={hovered}
      data-wings={wings}
      style={{ left: `calc(50% + ${rect.x}px)`, width: rect.width, height: rect.height }}
      onClick={click}
    >
      {!wings ? null : shape.housing ? (
        <>
          <span className="clv-strip-wing">{waiting}</span>
          <span className="clv-strip-housing" />
          <span className="clv-strip-wing">{working}</span>
        </>
      ) : (
        <span className="clv-strip-tab">
          {waiting}
          {working}
        </span>
      )}
    </div>
  );
}
