// The open island (the Swift reference's `IslandOpenFrame`, `IslandExpandedContent`, `IslandOpenHeader`,
// `IslandTabDots`, `IslandNeedsYouList`): pure black, the hardware housing grown — a flat top flush with
// the screen's edge flaring into it through concave shoulders, rounded below — at ONE size for every tab,
// each tab scrolling inside. With a housing the header sits in the housing's own band: the title left of
// it, the dots right of it. No rim, no hover grow; a soft shadow only below the housing's height.
//
// The body clips with rounded corners and `overflow: hidden`, never a clip-path or a mask, and the morph's
// blur and fade are inline only while it moves: Needs you places sealed approval parts in here.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactElement, type ReactNode } from "react";
import type { IslandCard, QuestionDraft } from "../model/cards";
import { emptyDraft, isSealed } from "../model/cards";
import { ISLAND, islandRect, topInset, type Rect, type ScreenShape, type Size } from "../model/geometry";
import { clampedShoulder, morphFrame, restingFrame, type MorphFrame } from "../model/morph";
import { selectedTab, showsDots, type TabState } from "../model/tabs";
import { springEasing, SURFACE_SPRING } from "../model/curves";
import { t } from "../strings";
import { QuestionCardContent, SealedCardContent } from "./CardContent";
import { Glyph } from "./glyphs";
import { useIslandStyles } from "./styles";

const DOT_EASING = springEasing(0.3, 0.85);
const KAPPA = 0.55228475;

export interface OpenIslandProps {
  shape: ScreenShape;
  /** The open island's size at rest; 560 × 168 unless a short screen clamps it. */
  size?: Size;
  /** Seconds into the opening; at rest when omitted. */
  seconds?: number;
  /** What it grows from — the strip as it is drawn (x from the centre). */
  from?: Rect;
  reducedMotion?: boolean;
  tabs: TabState;
  /** Needs you's count, beside its title. */
  count?: number;
  onSelectTab?: (id: string) => void;
  /** A click on the top band (the housing's height), x from the island's centre. */
  onTopBand?: (x: number) => void;
  /** The selected tab's body. */
  children?: ReactNode;
}

export function openFrame(shape: ScreenShape, size: Size, seconds: number | undefined, from: Rect | undefined, reducedMotion: boolean): MorphFrame {
  const target: Rect = { x: -size.width / 2, y: 0, width: size.width, height: size.height };
  if (seconds === undefined || reducedMotion || !from) {
    const frame = restingFrame(target);
    return reducedMotion && seconds !== undefined && seconds <= 0 ? { ...frame, content: 0 } : frame;
  }
  return morphFrame({ source: from, target, sourceCorner: ISLAND.stripCorner, targetCorner: ISLAND.islandCorner }, seconds);
}

function shoulderPath(s: number, side: "left" | "right"): string {
  const k = KAPPA * s;
  return side === "left" ? `M 0 0 L ${s} 0 L ${s} ${s} C ${s} ${s - k} ${k} 0 0 0 Z` : `M ${s} 0 L 0 0 L 0 ${s} C 0 ${s - k} ${s - k} 0 ${s} 0 Z`;
}

export function OpenIsland(props: OpenIslandProps): ReactElement {
  useIslandStyles();
  const { shape, seconds, from, reducedMotion = false, tabs, count, onSelectTab, onTopBand, children } = props;
  const size = props.size ?? { width: islandRect(shape).width, height: islandRect(shape).height };
  const frame = openFrame(shape, size, seconds, from, reducedMotion);
  const { rect } = frame;
  const top = topInset(shape);
  const shoulder = clampedShoulder(frame.shoulder, rect.height, frame.corner);
  const radius = `0 0 ${frame.corner}px ${frame.corner}px`;

  const content: CSSProperties = { width: size.width, height: size.height, marginLeft: -size.width / 2 };
  if (frame.content < 1) content.opacity = frame.content;
  if (frame.blur > 0.25) content.filter = `blur(${frame.blur.toFixed(2)}px)`;
  const interactive = frame.content > 0.9;

  const reach = 40;
  const shadowFrom = reach + top;
  const tab = selectedTab(tabs);

  return (
    <div
      className="clv-open"
      style={{ left: `calc(50% + ${rect.x}px)`, top: rect.y, width: rect.width, height: rect.height }}
      data-resting={seconds === undefined || undefined}
    >
      <div
        className="clv-open-shadow"
        aria-hidden="true"
        style={{
          left: -reach,
          top: -reach,
          width: rect.width + 2 * reach,
          height: rect.height + 2 * reach,
          maskImage: `linear-gradient(to bottom, transparent ${shadowFrom}px, #000 ${shadowFrom + 28}px)`,
          WebkitMaskImage: `linear-gradient(to bottom, transparent ${shadowFrom}px, #000 ${shadowFrom + 28}px)`,
        }}
      >
        <div style={{ borderRadius: radius }} />
      </div>
      {shoulder > 1 ? (
        <>
          <svg className="clv-open-shoulder" aria-hidden="true" width={shoulder} height={shoulder} style={{ left: -shoulder }} onClick={() => onTopBand?.(-(rect.width + shoulder) / 2)}>
            <path d={shoulderPath(shoulder, "left")} />
          </svg>
          <svg className="clv-open-shoulder" aria-hidden="true" width={shoulder} height={shoulder} style={{ left: rect.width }} onClick={() => onTopBand?.((rect.width + shoulder) / 2)}>
            <path d={shoulderPath(shoulder, "right")} />
          </svg>
        </>
      ) : null}
      <div className="clv-open-body" style={{ borderRadius: radius }}>
        <div className="clv-open-content" style={{ ...content, pointerEvents: interactive ? "auto" : "none" }}>
          {shape.housing ? (
            <OpenHeader
              title={tab?.title ?? ""}
              count={count}
              tabs={tabs}
              onSelectTab={onSelectTab}
              height={top}
              housingWidth={shape.housing.width}
              onBand={(event) => onTopBand?.(bandX(event, size.width))}
            />
          ) : (
            <>
              <div style={{ height: top, flex: "none" }} onClick={(event) => onTopBand?.(bandX(event, size.width))} />
              <OpenHeader title={tab?.title ?? ""} count={count} tabs={tabs} onSelectTab={onSelectTab} height={ISLAND.headerHeight} />
            </>
          )}
          <div className="clv-tab-body" role="tabpanel" aria-label={tab?.title}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A click's x from the island's centre. */
function bandX(event: MouseEvent<Element>, width: number): number {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientX - box.left - (box.width || width) / 2;
}

export interface OpenHeaderProps {
  title: string;
  count?: number;
  tabs: TabState;
  onSelectTab?: (id: string) => void;
  height: number;
  housingWidth?: number;
  /** A click on the header where it sits in the housing's band (anything but a dot). */
  onBand?: (event: MouseEvent<HTMLDivElement>) => void;
}

export function OpenHeader({ title, count, tabs, onSelectTab, height, housingWidth, onBand }: OpenHeaderProps): ReactElement {
  return (
    <div className="clv-open-header" style={{ height }} onClick={onBand}>
      <div className="clv-open-header-side">
        <span className="clv-open-title">{title}</span>
        {count !== undefined && count > 0 ? <span className="clv-count-badge">{count}</span> : null}
      </div>
      {housingWidth ? <div style={{ width: housingWidth, flex: "none" }} /> : null}
      <div className="clv-open-header-side" data-side="trailing">
        {showsDots(tabs) ? <TabDots tabs={tabs} onSelect={onSelectTab} /> : null}
      </div>
    </div>
  );
}

export function TabDots({ tabs, onSelect }: { tabs: TabState; onSelect?: (id: string) => void }): ReactElement {
  const transition = `width ${DOT_EASING.durationMs}ms ${DOT_EASING.easing}, background-color 200ms ease-out`;
  return (
    <div className="clv-dots" role="tablist" aria-label={t("clover.island.tabs")}>
      {tabs.tabs.map((tab, i) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="clv-dot"
          aria-selected={i === tabs.selected}
          aria-label={tab.title}
          title={tab.title}
          style={{ transition }}
          onClick={(event) => {
            event.stopPropagation();
            onSelect?.(tab.id);
          }}
        />
      ))}
    </div>
  );
}

/**
 * A tab's body inside the open island's fixed size: it scrolls (or, in the gallery, lies flat and cut), and
 * where more of the list lies beyond an edge the island says so OUTSIDE the list — a hairline on the
 * list's own top border when more lies above, a chevron in a band of its own below it when more lies
 * below (the Swift reference's `IslandScrollEdges` faded the edges with a mask instead, which here would hide the
 * sealed parts inside). Judged on scroll and on a change of size, never on a timer.
 */
export function TabScroll({ scrolls = true, children }: { scrolls?: boolean; children: ReactNode }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const judge = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = scrollEdges(el.scrollTop, el.clientHeight, el.scrollHeight);
    setEdges((e) => (e.top === next.top && e.bottom === next.bottom ? e : next));
  }, []);
  useLayoutEffect(judge);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(judge);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [judge]);
  return (
    <>
      <div ref={ref} className={scrolls ? "clv-tab-scroll" : "clv-tab-flat"} data-more-above={edges.top || undefined} onScroll={judge}>
        {children}
      </div>
      <div className="clv-more" aria-hidden="true" data-more-below={edges.bottom || undefined}>
        {edges.bottom ? <Glyph name="chevronDown" size={9} /> : null}
      </div>
    </>
  );
}

/** Where a scrolled list has more beyond its edges (half a pixel's grace). */
export function scrollEdges(scrollTop: number, clientHeight: number, scrollHeight: number): { top: boolean; bottom: boolean } {
  return { top: scrollTop > 0.5, bottom: scrollTop + clientHeight < scrollHeight - 0.5 };
}

export function EmptyTab({ line }: { line: string }): ReactElement {
  return (
    <div className="clv-empty">
      <Glyph name="checkCircle" />
      <span>{line}</span>
    </div>
  );
}

export interface NeedsYouProps {
  /** Every pending card, oldest first; the list shows the newest first. */
  cards: readonly IslandCard[];
  drafts?: Readonly<Record<string, QuestionDraft>>;
  errors?: Readonly<Record<string, string>>;
  onChoose?: (card: IslandCard, question: number, option: number) => void;
  onType?: (card: IslandCard, question: number, text: string) => void;
  onBack?: (card: IslandCard) => void;
  onAdvance?: (card: IslandCard) => void;
  scrolls?: boolean;
}

export function NeedsYou({ cards, drafts = {}, errors = {}, onChoose, onType, onBack, onAdvance, scrolls = true }: NeedsYouProps): ReactElement {
  if (cards.length === 0) return <EmptyTab line={t("clover.island.nothingNeedsYou")} />;
  return (
    <TabScroll scrolls={scrolls}>
      <div className="clv-needs">
        {[...cards].reverse().map((card) => (
          <div className="clv-needs-row" key={card.id}>
            <div className="clv-inner-card">
              {isSealed(card) ? (
                <SealedCardContent card={card} lines={2} withCommand />
              ) : (
                <QuestionCardContent
                  card={card}
                  draft={drafts[card.id] ?? emptyDraft()}
                  error={errors[card.id]}
                  onChoose={(q, o) => onChoose?.(card, q, o)}
                  onType={(q, text) => onType?.(card, q, text)}
                  onBack={() => onBack?.(card)}
                  onAdvance={() => onAdvance?.(card)}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </TabScroll>
  );
}

/** The top-band transition used by the dots, for anyone matching it. */
export { DOT_EASING, SURFACE_SPRING };
