// The small pill a newcomer waits in, just below a card the user is hovering or typing into (the Swift
// `IslandWaitingPill`): one short line; a click expands it and tucks the current card away. It grows a few
// points under the pointer, like every floating island panel.

import type { CSSProperties, ReactElement } from "react";
import { waitingLine, type IslandCard } from "../model/cards";
import type { Rect } from "../model/geometry";
import { hoverScale } from "../model/hover";
import { t } from "../strings";
import { Glyph, kindGlyph } from "./glyphs";
import { HOVER_EASING } from "./Liquid";

export interface WaitingPillProps {
  card: IslandCard;
  /** Its rect in the card's panel. */
  rect: Rect;
  hovered?: boolean;
  onClick?: () => void;
}

export function WaitingPill({ card, rect, hovered = false, onClick }: WaitingPillProps): ReactElement {
  const line = waitingLine(card);
  const style: CSSProperties = {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    transition: `transform ${HOVER_EASING.durationMs}ms ${HOVER_EASING.easing}`,
  };
  if (hovered) style.transform = `scale(${hoverScale(rect.width)})`;
  return (
    <button type="button" className="clv-waiting" style={style} aria-label={t("clover.island.showWaiting", { line })} onClick={onClick}>
      <Glyph name={kindGlyph(card.kind)} />
      <span className="clv-waiting-line">{line}</span>
    </button>
  );
}
