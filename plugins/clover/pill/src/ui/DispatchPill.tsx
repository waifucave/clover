// The Dispatch pill as one component (Winter's `DispatchPillController` and `DispatchPillView`, as React
// state): the compact pill grows into the typing pill on the first keystroke, compresses into the working
// pill (the plume) when a message goes, morphs into the card on top while an ask waits, and shows a pinned
// turn alone. One spring drives the shape; a content swap fades the old content out before the shape moves
// and reveals the new one near the end of its travel. Frames run only while something moves.
//
// The host feeds it: who it messages (`pill.target`), the turn's state and the tools it used, the agents
// working for it, the asks waiting and the recent turns. It reports back what the user does.

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactElement } from "react";
import { assignPaletteSlots, type ChildItem } from "../model/children";
import { questionAdvance, questionAnswers, chooseOption, emptyDraft, typeOther, type PillCard, type QuestionCard, type QuestionDraft } from "../model/cards";
import { PILL, barLook, canvasSize, cardSize, contentReveal, hoverScale, mainSize, previewCeiling, previewHeight, type Presentation, type Size } from "../model/metrics";
import { CHILD_PALETTES, type PlumeThrow } from "../model/plume";
import { turnPreview, type Exchange } from "../model/preview";
import { restingSpring, retarget, settled, stepSpring, type SizeSpring } from "../model/spring";
import { t } from "../strings";
import { Bar, type BarMenu, type PillTarget } from "./Bar";
import { CardBody } from "./Card";
import { Children } from "./Children";
import { BROWSER_FRAMES, Plume, type FrameTimers } from "./Plume";
import { Preview } from "./Preview";
import { Shell } from "./Shell";
import { usePillStyles } from "./styles";

export interface DispatchPillProps {
  target: PillTarget;
  targets?: readonly PillTarget[];
  onTarget?: (id: string) => void;
  /** The target's turn runs (or a sent message's turn is on its way). */
  running?: boolean;
  /** Stop was pressed and the turn has not ended yet. */
  stopping?: boolean;
  /** The placeholder while the turn runs, when the typing pill is open over it. */
  verb?: string;
  /** The tools and sites this turn used, in order: each new one leaves the nozzle once. */
  thrown?: readonly PlumeThrow[];
  /** The running round's: thrown again in turn while it runs. */
  repeating?: readonly PlumeThrow[];
  /** The agents working for the target. */
  agents?: readonly ChildItem[];
  /** The asks waiting, the one shown first. */
  cards?: readonly PillCard[];
  /** Recent turns, oldest first, for a pinned turn. */
  exchanges?: readonly Exchange[];
  /** The turn shown alone (a reply that just came, or one the user moved to); null: none. */
  pinned?: number | null;
  onPinned?: (index: number | null) => void;
  /** The draft, when the host keeps it; otherwise the pill keeps its own. */
  draft?: string;
  onDraft?: (text: string) => void;
  onSend?: (text: string) => void;
  onStop?: () => void;
  /** A question card's answers; false (or a rejection) shows an error and keeps the card. */
  onAnswerQuestion?: (card: QuestionCard, answers: Record<string, string>) => boolean | Promise<boolean>;
  onOpenAgent?: (id: string) => void;
  onStopAgent?: (id: string) => void;
  onOpenInApp?: () => void;
  onFullScreen?: () => void;
  /** The window's size for everything drawn (the shape, the row above it, the shadow margin). */
  onCanvas?: (size: Size) => void;
  /** The screen's visible height, for the card and preview ceilings. */
  visibleHeight?: number;
  initialPresentation?: Presentation;
  reducedMotion?: boolean;
  timers?: FrameTimers;
}

/** How long the old content takes to fade before a swap moves the shape. */
const FADE_OUT = PILL.contentFadeOut;
/** How long a new agent's pill takes to rise out of the main one. */
const ENTRANCE = 0.38;
const LINE_HEIGHT = 20;
const NO_AGENTS: readonly ChildItem[] = [];
const NO_CARDS: readonly PillCard[] = [];
const NO_THROWS: readonly PlumeThrow[] = [];
const NO_EXCHANGES: readonly Exchange[] = [];

type ContentKey = "bar" | `card:${string}` | `preview:${number}`;

interface Swap {
  /** The content drawn now (during a fade, the old one). */
  shown: ContentKey;
  /** The content that takes over once the fade ends, or null. */
  next: ContentKey | null;
  /** When the old content began fading (ms), or null outside a fade. */
  fadeStart: number | null;
  /** The size the shape had when the new content took over: the reveal measures from it. */
  origin: Size;
}

export function DispatchPill(props: DispatchPillProps): ReactElement {
  usePillStyles();
  const {
    target,
    targets = [],
    running = false,
    stopping = false,
    verb,
    thrown = NO_THROWS,
    repeating = NO_THROWS,
    agents = NO_AGENTS,
    cards = NO_CARDS,
    exchanges = NO_EXCHANGES,
    pinned = null,
    visibleHeight = 900,
    reducedMotion = false,
    timers = BROWSER_FRAMES,
  } = props;

  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [presentation, setPresentation] = useState<Presentation>(props.initialPresentation ?? "compact");
  const [ownDraft, setOwnDraft] = useState("");
  const draft = props.draft ?? ownDraft;
  const [menu, setMenu] = useState<BarMenu>(null);
  const [composerHeight, setComposerHeight] = useState(LINE_HEIGHT + 6);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({});
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hovered, setHovered] = useState(false);
  const cardHeights = useRef(new Map<string, number>());
  const [replyHeight, setReplyHeight] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // What the main pill shows: the card on top, else a pinned turn, else the bar.
  const card = cards[0] ?? null;
  const preview = pinned !== null ? turnPreview(exchanges, pinned) : null;
  const wanted: ContentKey = card ? `card:${card.id}` : preview ? `preview:${pinned!}` : "bar";

  const targetFor = useCallback(
    (key: ContentKey): Size => {
      if (key.startsWith("card:")) {
        const id = key.slice(5);
        return cardSize(presentation, cardHeights.current.get(id) ?? 0, visibleHeight);
      }
      if (key.startsWith("preview:")) {
        const height = previewHeight(replyHeight ?? LINE_HEIGHT, LINE_HEIGHT, previewCeiling(visibleHeight));
        return mainSize("expanded", 0, height, visibleHeight);
      }
      return mainSize(presentation, composerHeight, undefined, visibleHeight);
    },
    [presentation, composerHeight, replyHeight, visibleHeight],
  );

  // The shape's spring and the swap, mutable between frames.
  const spring = useRef<SizeSpring | null>(null);
  spring.current ??= restingSpring(targetFor(wanted));
  const swap = useRef<Swap>({ shown: wanted, next: null, fadeStart: null, origin: spring.current.size });
  // Cards seen, so one answered mid-fade keeps drawing while it fades out.
  const seenCards = useRef(new Map<string, PillCard>());
  for (const c of cards) seenCards.current.set(c.id, c);
  const lastFrame = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  // Agents: a colour each, kept for as long as it stays on the row; a rise for each new one (noted while
  // rendering, so its first frame is already the rise's).
  const slots = useRef<{ assigned: Record<string, number>; cursor: number }>({ assigned: {}, cursor: 0 });
  const roster = agents.map((a) => a.id);
  {
    const kept: Record<string, number> = {};
    for (const id of roster) if (slots.current.assigned[id] !== undefined) kept[id] = slots.current.assigned[id]!;
    slots.current = assignPaletteSlots(roster, kept, slots.current.cursor, CHILD_PALETTES.length);
  }
  const arrivals = useRef(new Map<string, number>());
  const known = useRef<Set<string> | null>(null);
  if (known.current === null) known.current = new Set(roster);
  for (const id of roster) {
    if (!known.current.has(id)) {
      known.current.add(id);
      if (!reducedMotion) arrivals.current.set(id, timers.now());
    }
  }
  for (const id of [...known.current]) {
    if (!roster.includes(id)) {
      known.current.delete(id);
      arrivals.current.delete(id);
    }
  }

  const moving = (): boolean => {
    const s = spring.current!;
    return swap.current.fadeStart !== null || !settled(s) || s.size.width !== s.target.width || s.size.height !== s.target.height || arrivals.current.size > 0;
  };

  const step = useCallback(() => {
    frame.current = null;
    const now = timers.now();
    const dt = lastFrame.current === null ? 1 / 60 : (now - lastFrame.current) / 1000;
    lastFrame.current = now;
    const sw = swap.current;
    if (sw.fadeStart !== null && now - sw.fadeStart >= FADE_OUT * 1000) {
      sw.shown = sw.next ?? sw.shown;
      sw.next = null;
      sw.fadeStart = null;
      sw.origin = spring.current!.size;
      spring.current = retarget(spring.current!, targetFor(sw.shown));
    }
    if (sw.fadeStart === null) spring.current = stepSpring(spring.current!, dt);
    for (const [id, start] of arrivals.current) if (now - start >= ENTRANCE * 1000) arrivals.current.delete(id);
    bump();
  }, [timers, targetFor]);

  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    if (lastFrame.current === null) lastFrame.current = timers.now();
    frame.current = timers.requestFrame(step);
  }, [timers, step]);

  // A new content: fade the old out first (unless motion is reduced), then move; a content that comes back
  // before its fade ends cancels it.
  useLayoutEffect(() => {
    const sw = swap.current;
    const before = spring.current;
    if (reducedMotion) {
      if (wanted !== sw.shown || sw.fadeStart !== null) {
        sw.shown = wanted;
        sw.next = null;
        sw.fadeStart = null;
        spring.current = restingSpring(targetFor(wanted));
        sw.origin = spring.current.size;
      }
    } else if (sw.fadeStart !== null) {
      if (wanted === sw.shown) {
        sw.next = null;
        sw.fadeStart = null;
      } else sw.next = wanted;
    } else if (wanted !== sw.shown) {
      sw.next = wanted;
      sw.fadeStart = timers.now();
    }
    if (sw.fadeStart === null) {
      const next = targetFor(sw.shown);
      const current = spring.current!;
      if (next.width !== current.target.width || next.height !== current.target.height) {
        spring.current = reducedMotion ? restingSpring(next) : retarget(current, next);
      }
    }
    for (const id of [...seenCards.current.keys()]) {
      if (`card:${id}` !== sw.shown && `card:${id}` !== sw.next && !cards.some((c) => c.id === id)) seenCards.current.delete(id);
    }
    if (!reducedMotion && moving()) schedule();
    else lastFrame.current = null;
    // Without motion a change lands at once: draw it now, there is no frame coming.
    if (reducedMotion && spring.current !== before) bump();
  });

  useEffect(
    () => () => {
      if (frame.current !== null) timers.cancelFrame(frame.current);
    },
    [timers],
  );

  // Measure what decides the shape: the card's height, the pinned reply's (the bar reports its own lines).
  useLayoutEffect(() => {
    const el = contentRef.current?.firstElementChild as HTMLElement | null | undefined;
    if (!el) return;
    const shown = swap.current.shown;
    if (shown.startsWith("card:")) {
      const h = Math.ceil(el.getBoundingClientRect().height);
      const id = shown.slice(5);
      if (h > 0 && cardHeights.current.get(id) !== h) {
        cardHeights.current.set(id, h);
        bump();
      }
    } else if (shown.startsWith("preview:")) {
      const reply = el.querySelector(".clp-preview-reply") as HTMLElement | null;
      const h = reply ? Math.ceil(reply.scrollHeight) : 0;
      if (h > 0 && h !== replyHeight) setReplyHeight(h);
    }
  });

  // The window's size, for the host.
  const s = spring.current;
  const accessory = agents.length > 0 ? { width: s.target.width, height: PILL.pillHeight } : null;
  const canvas = canvasSize(s.target, accessory);
  const onCanvas = props.onCanvas;
  useEffect(() => {
    onCanvas?.(canvas);
  }, [canvas.width, canvas.height, onCanvas]);

  const setDraft = (text: string) => {
    if (props.draft === undefined) setOwnDraft(text);
    props.onDraft?.(text);
    // The first keystroke opens the typing pill, and leaves a pinned turn.
    if (text.length > 0 && presentation === "compact") setPresentation("expanded");
    if (pinned !== null) props.onPinned?.(null);
  };

  const send = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    props.onSend?.(text);
    setDraft("");
    setPresentation("compact");
    setMenu(null);
    inputRef.current?.blur();
  };

  const collapse = () => {
    if (menu) {
      setMenu(null);
      return;
    }
    setPresentation("compact");
    inputRef.current?.blur();
  };

  const questionDraft = (c: QuestionCard) => questionDrafts[c.id] ?? emptyDraft();
  const setQuestionDraft = (c: QuestionCard, next: QuestionDraft) => setQuestionDrafts((d) => ({ ...d, [c.id]: next }));

  const advance = async (c: QuestionCard) => {
    const d = questionDraft(c);
    const result = questionAdvance(c.questions, d, inFlight.has(c.id));
    if (!result.enabled) return;
    if (result.action === "next") {
      setQuestionDraft(c, { ...d, visible: d.visible + 1 });
      return;
    }
    setInFlight((f) => new Set(f).add(c.id));
    setErrors((e) => {
      const { [c.id]: _, ...rest } = e;
      return rest;
    });
    let ok = false;
    try {
      ok = (await props.onAnswerQuestion?.(c, questionAnswers(c.questions, d))) ?? false;
    } catch {
      ok = false;
    }
    setInFlight((f) => {
      const next = new Set(f);
      next.delete(c.id);
      return next;
    });
    if (!ok) setErrors((e) => ({ ...e, [c.id]: "That answer didn't go through. Try again." }));
  };

  // What the bar shows, and what the shape holds now.
  const drawn = swap.current.shown;
  const look = barLook(presentation === "expanded", running, draft, card !== null, t("clover.pill.placeholder", { name: target.name }), verb ?? t("clover.pill.working", { name: target.name }));
  const now = timers.now();
  const fade = swap.current.fadeStart === null ? 1 : Math.max(0, 1 - (now - swap.current.fadeStart) / (FADE_OUT * 1000));
  const reveal = swap.current.fadeStart === null ? contentReveal(swap.current.origin, s.size, s.target) : 1;
  const visibility = reducedMotion ? 1 : fade * reveal;
  const entering: Record<string, number> = {};
  for (const [id, start] of arrivals.current) entering[id] = Math.min(1, (now - start) / (ENTRANCE * 1000));
  const shownCard = drawn.startsWith("card:") ? (seenCards.current.get(drawn.slice(5)) ?? null) : null;
  const shownPreview = drawn.startsWith("preview:") ? turnPreview(exchanges, Number(drawn.slice(8))) : null;

  return (
    <div className="clp-stage" data-presentation={presentation} data-running={running || undefined} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className="clp-stack" style={hovered && !reducedMotion ? { transform: `scale(${hoverScale(s.size.width)})` } : undefined}>
        <Children
          items={agents}
          width={s.size.width}
          slots={slots.current.assigned}
          entering={entering}
          animates={!reducedMotion}
          timers={timers}
          onOpen={props.onOpenAgent}
          onStop={props.onStopAgent}
        />
        <Shell
          size={s.size}
          target={s.target}
          visibility={visibility}
          label={t("clover.pill.name")}
          underlay={running ? <Plume width={PILL.compactWidth} height={PILL.pillHeight} thrown={thrown} repeating={repeating} animates={!reducedMotion} timers={timers} /> : undefined}
          underlayShown={look.working && drawn === "bar"}
        >
          <Bar
            presentation={presentation}
            target={target}
            targets={targets}
            draft={draft}
            working={look.working}
            circle={look.circle}
            placeholder={look.placeholder}
            stopping={stopping}
            covered={drawn !== "bar"}
            accessories={presentation === "expanded" && drawn === "bar"}
            menu={menu}
            inputRef={inputRef}
            onDraft={setDraft}
            onContentHeight={setComposerHeight}
            onSend={send}
            onStop={props.onStop}
            onFocus={() => {
              if (presentation === "compact" && !look.working) setPresentation("expanded");
            }}
            onBlur={() => {
              if (draft.length === 0 && menu === null) setPresentation("compact");
            }}
            onEscape={collapse}
            onOpen={() => {
              setPresentation("expanded");
              inputRef.current?.focus();
            }}
            onMenu={setMenu}
            onTarget={props.onTarget}
            onFullScreen={props.onFullScreen}
            onOpenInApp={props.onOpenInApp}
            onClearDraft={() => setDraft("")}
          />
          {/* A card or a pinned turn, laid out at the TARGET width and centred, so it never re-wraps while the shape springs. */}
          <div ref={contentRef} style={{ position: "absolute", left: "50%", top: 0, width: drawn === "bar" ? 0 : s.target.width, marginLeft: drawn === "bar" ? 0 : -s.target.width / 2 }}>
            {shownCard ? (
              <CardBody
                card={shownCard}
                waiting={Math.max(0, cards.length - 1)}
                draft={shownCard.kind === "question" ? questionDraft(shownCard) : emptyDraft()}
                inFlight={inFlight.has(shownCard.id)}
                error={errors[shownCard.id] ?? null}
                onChoose={(q, o) => shownCard.kind === "question" && setQuestionDraft(shownCard, chooseOption(questionDraft(shownCard), shownCard.questions[q]!, q, o))}
                onType={(q, text) => shownCard.kind === "question" && setQuestionDraft(shownCard, typeOther(questionDraft(shownCard), shownCard.questions[q]!, q, text))}
                onBack={() => shownCard.kind === "question" && setQuestionDraft(shownCard, { ...questionDraft(shownCard), visible: Math.max(0, questionDraft(shownCard).visible - 1) })}
                onAdvance={() => shownCard.kind === "question" && void advance(shownCard)}
              />
            ) : shownPreview ? (
              <div style={{ position: "relative", height: s.target.height }}>
                <Preview preview={shownPreview} onLeave={() => props.onPinned?.(null)} />
              </div>
            ) : null}
          </div>
        </Shell>
      </div>
    </div>
  );
}

