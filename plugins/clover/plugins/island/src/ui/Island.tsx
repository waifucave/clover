// The island as one surface (the Swift reference's `IslandStore` + `IslandController`, without the AppKit): every
// pending card goes through the queue — one on top, born from the housing; a newcomer replacing it unless
// it is hovered or typed into, when it waits in a small pill below; cards compacting by themselves into
// the strip's count after a while — and a click on the strip opens the island on Needs you, the tabs
// beside it. In M2 this mounts in its own `app.surface` window; here it draws into any container whose
// top edge stands for the screen's.
//
// A card that leaves the top — answered anywhere, compacted into the count, or replaced — goes back up into
// the housing as its birth played backwards, faster (the Swift island's return), drawn as the bare shape beneath
// whatever is on top now; with Reduce Motion it just goes. A choice in a question never sends by itself:
// ✓ does, as in the pill.
//
// Idle cost: nothing. No frame runs while nothing moves; the only timer is ONE wake-up at the queue's next
// self-compaction, armed only while a card is on top and not held.

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  chooseOption,
  draftComplete,
  emptyDraft,
  isSealed,
  questionAnswers,
  selfCompacts,
  typeOther,
  type IslandCard,
  type QuestionCard,
  type QuestionDraft,
} from "../model/cards";
import { cardGeometry, ISLAND, islandRect, showsWings, stripAction, stripRect, tabForPart, waitingRect, type StripPart } from "../model/geometry";
import { FLUID, fluidSeconds } from "../model/fluid";
import { beginClosing, beginOpening, MORPH, morphSeconds, type MorphClock } from "../model/morph";
import { IslandQueue } from "../model/queue";
import { NEEDS_YOU, guestTabs, select, selectedTab, tabState, type GuestTab, type IslandTab } from "../model/tabs";
import { t } from "../strings";
import { QuestionCardContent, SealedCardContent } from "./CardContent";
import { LiquidCard } from "./Liquid";
import { NeedsYou, OpenIsland } from "./OpenIsland";
import { Strip } from "./Strip";
import { useIslandStyles } from "./styles";
import { WaitingPill } from "./WaitingPill";
import type { Rect, ScreenShape } from "../model/geometry";

/** A tab beside Needs you: an `island.tab` entry (`guestTabs` decides how it shows). */
export interface IslandTabEntry extends GuestTab {
  render: () => ReactNode;
}

export interface IslandTimers {
  /** Milliseconds, monotonic. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  requestFrame(fn: () => void): unknown;
  cancelFrame(handle: unknown): void;
}

export const BROWSER_TIMERS: IslandTimers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  requestFrame: (fn) => globalThis.requestAnimationFrame(fn),
  cancelFrame: (handle) => globalThis.cancelAnimationFrame(handle as number),
};

export interface IslandProps {
  shape: ScreenShape;
  /** Every pending card, oldest first. A card answered anywhere leaves this list. */
  cards: readonly IslandCard[];
  /** How many bots are working: the strip's right wing. */
  working?: number;
  /** Tabs after Needs you. */
  tabs?: readonly IslandTabEntry[];
  /** The tab the working wing opens on; the island's current one when absent. */
  workingTab?: string;
  /** A question answered here. Resolve false (or throw) when the answer did not go through. */
  onAnswerQuestion?: (card: QuestionCard, answers: Record<string, string>) => Promise<boolean> | boolean | void;
  onOpenChange?: (open: boolean) => void;
  /** The parts that take clicks, x from the island's centre: the strip, the open island, the card on top and the
   *  newcomer under it; and what is drawn, which adds a card on its way back into the strip. An overlay passes every
   *  other click through to what lies below, and its window covers no more than what is drawn (the surface host). */
  onRegions?: (regions: readonly Rect[], drawn: readonly Rect[]) => void;
  /** Open for good, with no strip and no floating cards: the island as a normal window (Wayland), where every card
   *  waits in Needs you. */
  alwaysOpen?: boolean;
  reducedMotion?: boolean;
  timers?: IslandTimers;
}

const ESTIMATED_CARD_HEIGHT = 132;
const NO_TABS: readonly IslandTabEntry[] = [];

export function Island(props: IslandProps): ReactElement {
  useIslandStyles();
  const { shape, cards, working = 0, workingTab, onAnswerQuestion, onOpenChange, alwaysOpen = false } = props;
  const reducedMotion = props.reducedMotion === true || alwaysOpen;
  const timers = props.timers ?? BROWSER_TIMERS;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const queue = useRef(new IslandQueue()).current;
  const known = useRef(new Set<string>());
  const births = useRef(new Map<string, number>());
  const heights = useRef(new Map<string, number>());
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Set<string>>(new Set());
  const [morph, setMorph] = useState<MorphClock>({ openedAt: null, closing: null });
  const [stripHovered, setStripHovered] = useState(false);
  const [waitingHovered, setWaitingHovered] = useState(false);

  const given = props.tabs ?? NO_TABS;
  const extraTabs = useMemo(() => guestTabs(given), [given]);
  // Keyed by what the tabs are, not by the array: a parent passing a fresh array each render changes nothing.
  const tabKey = extraTabs.map(({ id, title }) => `${id}\u0000${title}`).join("\u0001");
  const tabList = useMemo(() => [NEEDS_YOU, ...extraTabs.map(({ id, title }) => ({ id, title }))], [tabKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [tabs, setTabs] = useState(() => tabState(tabList));
  useEffect(() => setTabs((s) => (s.tabs === tabList ? s : tabState(tabList, Math.min(s.selected, tabList.length - 1)))), [tabList]);

  const nowS = () => timers.now() / 1000;
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  // The card going back up into the housing, if one is: its birth clock and the height it had.
  const leaving = useRef<{ id: string; bornAt: number; returningAt: number; height: number } | null>(null);

  const syncBirths = useCallback(() => {
    const current = queue.current?.id;
    for (const [id, bornAt] of [...births.current]) {
      if (id === current) continue;
      births.current.delete(id);
      if (!reducedMotion) leaving.current = { id, bornAt, returningAt: timers.now(), height: heights.current.get(id) ?? ESTIMATED_CARD_HEIGHT };
    }
    if (current && !births.current.has(current)) births.current.set(current, timers.now());
  }, [queue, timers, reducedMotion]);

  // Cards in and out of the queue, as the pending list changes.
  useLayoutEffect(() => {
    const now = nowS();
    const ids = new Set(cards.map((c) => c.id));
    for (const id of known.current) if (!ids.has(id)) queue.resolve(id, now);
    for (const card of cards) if (!known.current.has(card.id)) queue.arrive(card.id, selfCompacts(card), now);
    known.current = ids;
    syncBirths();
    bump();
  }, [cards]); // eslint-disable-line react-hooks/exhaustive-deps

  // The one wake-up: the current card's self-compaction.
  const deadline = queue.nextDeadline;
  useEffect(() => {
    if (deadline === null) return;
    const handle = timers.setTimeout(() => {
      queue.tick(nowS());
      syncBirths();
      bump();
    }, Math.max(0, deadline * 1000 - timers.now()));
    return () => timers.clearTimeout(handle);
  }); // re-armed after every render, for whatever the queue now says

  const isOpen = alwaysOpen || morph.openedAt !== null;
  const now = timers.now();
  const current = queue.current ? byId.get(queue.current.id) : undefined;
  const waiting = queue.waiting ? byId.get(queue.waiting.id) : undefined;
  const bornAt = current ? births.current.get(current.id) : undefined;
  const birthSeconds = bornAt === undefined ? FLUID.settle : (now - bornAt) / 1000;
  const morphMoving = !alwaysOpen && isOpen && (morph.closing !== null || morphSeconds(morph, now) < MORPH.settle);
  const back = leaving.current;
  const backSeconds = back ? fluidSeconds(now, back.bornAt, back.returningAt) : 0;
  const returning = back !== null && backSeconds > 0 && !isOpen && !reducedMotion;
  const moving = (!isOpen && current !== undefined && birthSeconds < FLUID.settle && !reducedMotion) || (morphMoving && !reducedMotion) || returning;

  // A return that has played out (or that the island opened over) is done; one that began after this render
  // is the next render's to judge.
  useEffect(() => {
    if (back !== null && leaving.current === back && !returning) leaving.current = null;
  });

  // Frames only while a shape moves.
  useEffect(() => {
    if (!moving) return;
    const handle = timers.requestFrame(() => bump());
    return () => timers.cancelFrame(handle);
  });

  const open = useCallback(
    (tab: string | null) => {
      setMorph((m) => beginOpening(m, timers.now(), reducedMotion));
      if (tab) setTabs((s) => select(s, tab));
      onOpenChange?.(true);
    },
    [onOpenChange, reducedMotion, timers],
  );

  const close = useCallback(() => {
    if (alwaysOpen) return;
    setMorph((m) => {
      if (m.openedAt === null || m.closing) return m;
      const { clock, durationMs } = beginClosing(m, timers.now());
      timers.setTimeout(() => setMorph({ openedAt: null, closing: null }), reducedMotion ? 0 : durationMs);
      return clock;
    });
    onOpenChange?.(false);
  }, [onOpenChange, reducedMotion, timers, alwaysOpen]);

  // Esc closes the open island.
  useEffect(() => {
    if (!isOpen || morph.closing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, morph.closing, close]);

  const counts = { waiting: cards.length, working };
  const partTabs = { needsYou: NEEDS_YOU.id, working: workingTab ?? "" };
  const onStripPart = (part: StripPart) => {
    const tab = tabForPart(part, partTabs) || null;
    const action = stripAction(tab, isOpen && !morph.closing, selectedTab(tabs)?.id ?? null);
    if (action.kind === "open") open(action.tab);
    else if (action.kind === "select") setTabs((s) => select(s, action.tab));
    else close();
  };

  // Answers to questions, here or in Needs you.
  const draftOf = (card: IslandCard) => drafts[card.id] ?? emptyDraft();
  const setDraft = (card: IslandCard, draft: QuestionDraft) => setDrafts((d) => ({ ...d, [card.id]: draft }));
  const submit = async (card: QuestionCard, draft: QuestionDraft) => {
    if (sending.has(card.id)) return;
    setSending((s) => new Set(s).add(card.id));
    let ok = false;
    try {
      ok = (await onAnswerQuestion?.(card, questionAnswers(card.questions, draft))) !== false;
    } catch {
      ok = false;
    }
    setSending((s) => {
      const next = new Set(s);
      next.delete(card.id);
      return next;
    });
    setErrors((e) => {
      const next = { ...e };
      if (ok) delete next[card.id];
      else next[card.id] = t("clover.island.notSent");
      return next;
    });
  };
  /** The next question, or — after the last, once every question has an answer — the answers. */
  const advance = (card: IslandCard, draft: QuestionDraft = draftOf(card)) => {
    if (card.kind !== "question") return;
    if (draft.visible < card.questions.length - 1) {
      setDraft(card, { ...draft, visible: draft.visible + 1 });
      return;
    }
    if (draftComplete(card.questions, draft)) void submit(card, draft);
  };
  const questionHandlers = (card: IslandCard) => ({
    onChoose: (q: number, o: number) => {
      if (card.kind !== "question") return;
      // Choosing only chooses: ✓ (or › before the last question) moves on, as in the pill.
      setDraft(card, chooseOption(draftOf(card), card.questions[q]!, q, o));
    },
    onType: (q: number, text: string) => {
      if (card.kind === "question") setDraft(card, typeOther(draftOf(card), card.questions[q]!, q, text));
    },
    onBack: () => setDraft(card, { ...draftOf(card), visible: Math.max(0, draftOf(card).visible - 1) }),
    onAdvance: () => advance(card),
  });

  // The card on top: its geometry from its measured height.
  const contentRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!current || !contentRef.current) return;
    const h = Math.ceil(contentRef.current.getBoundingClientRect().height);
    if (h > 0 && heights.current.get(current.id) !== h + 2 * ISLAND.cardPadding) {
      heights.current.set(current.id, h + 2 * ISLAND.cardPadding);
      bump();
    }
  });

  const tabBody = (() => {
    const tab = selectedTab(tabs);
    if (!tab || tab.id === NEEDS_YOU.id) {
      return (
        <NeedsYou
          cards={cards}
          drafts={drafts}
          errors={errors}
          onChoose={(card, q, o) => questionHandlers(card).onChoose(q, o)}
          onType={(card, q, text) => questionHandlers(card).onType(q, text)}
          onBack={(card) => questionHandlers(card).onBack()}
          onAdvance={(card) => questionHandlers(card).onAdvance()}
        />
      );
    }
    return extraTabs.find((entry) => entry.id === tab.id)?.render() ?? null;
  })();

  const strip = alwaysOpen ? null : stripRect(shape, showsWings(counts));
  const from = strip ?? { x: -60, y: 0, width: 120, height: 0 };
  const geometry = current
    ? cardGeometry(shape, { width: ISLAND.cardWidth, height: heights.current.get(current.id) ?? ESTIMATED_CARD_HEIGHT }, { rounded: true })
    : null;

  // What takes clicks now. Reported when it changes, so the surface host can pass every other click through.
  const regions: Rect[] = [];
  if (strip) regions.push(grow(strip, ISLAND.stripGlowMargin));
  if (isOpen) regions.push(islandRect(shape));
  else if (current && geometry) {
    const left = -geometry.panelSize.width / 2;
    regions.push({ ...geometry.card, x: left + geometry.card.x });
    if (waiting) {
      const pill = waitingRect(geometry);
      regions.push({ ...pill, x: left + pill.x });
    }
  }
  const drawn: Rect[] = [...regions];
  if (returning && back) {
    const g = cardGeometry(shape, { width: ISLAND.cardWidth, height: back.height }, { rounded: true });
    drawn.push({ ...g.card, x: -g.panelSize.width / 2 + g.card.x });
  }
  const keyOf = (list: readonly Rect[]) => list.map((r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`).join(";");
  const regionKey = `${keyOf(regions)}|${keyOf(drawn)}`;
  const onRegions = props.onRegions;
  useEffect(() => {
    onRegions?.(regions, drawn);
  }, [regionKey, onRegions]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="clv-island" data-open={isOpen || undefined}>
      {alwaysOpen ? null : (
        <span onMouseEnter={() => setStripHovered(true)} onMouseLeave={() => setStripHovered(false)}>
          <Strip shape={shape} counts={counts} hovered={stripHovered && !isOpen} onPart={onStripPart} />
        </span>
      )}
      {returning && back ? (
        <div className="clv-returning" aria-hidden="true">
          <LiquidCard geometry={cardGeometry(shape, { width: ISLAND.cardWidth, height: back.height }, { rounded: true })} seconds={backSeconds}>
            <div />
          </LiquidCard>
        </div>
      ) : null}
      {isOpen ? (
        <OpenIsland
          shape={shape}
          size={islandRect(shape)}
          seconds={morphMoving ? morphSeconds(morph, now) : undefined}
          from={from}
          reducedMotion={reducedMotion}
          tabs={tabs}
          count={selectedTab(tabs)?.id === NEEDS_YOU.id ? cards.length : undefined}
          onSelectTab={(id) => setTabs((s) => select(s, id))}
          onTopBand={(x) => onStripPart(x < -(shape.housing?.width ?? 0) / 2 ? "waitingWing" : x > (shape.housing?.width ?? 0) / 2 ? "workingWing" : "housing")}
        >
          {tabBody}
        </OpenIsland>
      ) : current && geometry ? (
        <div
          onMouseEnter={() => {
            queue.hoverCurrent(true, nowS());
            bump();
          }}
          onMouseLeave={() => {
            queue.hoverCurrent(false, nowS());
            bump();
          }}
          onFocus={(event) => {
            if (event.target instanceof HTMLInputElement) {
              queue.typingCurrent(true, nowS());
              bump();
            }
          }}
          onBlur={(event) => {
            if (event.target instanceof HTMLInputElement) {
              queue.typingCurrent(false, nowS());
              bump();
            }
          }}
        >
          {/* Before the card in the tree, so the card paints over it: nothing is ever drawn over a sealed part. */}
          {waiting ? (
            <div className="clv-card-panel" style={{ width: geometry.panelSize.width, height: geometry.panelSize.height + ISLAND.waitingGap + ISLAND.waitingHeight, left: `calc(50% - ${geometry.panelSize.width / 2}px)` }}>
              <span onMouseEnter={() => setWaitingHovered(true)} onMouseLeave={() => setWaitingHovered(false)}>
                <WaitingPill
                  card={waiting}
                  rect={waitingRect(geometry)}
                  hovered={waitingHovered}
                  onClick={() => {
                    queue.clickWaiting(nowS());
                    syncBirths();
                    setWaitingHovered(false);
                    bump();
                  }}
                />
              </span>
            </div>
          ) : null}
          <LiquidCard
            geometry={geometry}
            seconds={birthSeconds < FLUID.settle ? birthSeconds : undefined}
            hovered={queue.currentHovered}
            reducedMotion={reducedMotion}
            label={t(current.kind === "question" ? "clover.island.question" : current.kind === "link" ? "clover.island.linkRequest" : "clover.island.approval")}
          >
            <div ref={contentRef}>
              {isSealed(current) ? (
                <SealedCardContent card={current} />
              ) : (
                <QuestionCardContent card={current} draft={draftOf(current)} error={errors[current.id]} sending={sending.has(current.id)} {...questionHandlers(current)} />
              )}
            </div>
          </LiquidCard>
        </div>
      ) : null}
    </div>
  );
}

function grow(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y, width: rect.width + 2 * by, height: rect.height + by };
}
