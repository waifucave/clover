// The pill grown into an ask (Winter's `DispatchPillCardView`): a header (the amber kind glyph, who asks, and
// on the right where and how many wait), the body, and the answer row (a status line, then ✕ and ✓). An
// approval's and a link request's words and buttons are sealed parts the pill places but cannot read; a
// question's are the pill's own, one question at a time, and choosing never sends by itself.

import type { ReactElement } from "react";
import { cardTrailing, questionAdvance, type ApprovalCard, type LinkCard, type PillCard, type QuestionCard, type QuestionDraft } from "../model/cards";
import { t } from "../strings";
import { Glyph } from "./glyphs";
import { PILL_CARD_SOURCES, useCardTokens, useSealedKit } from "./sealed";

export interface SealedCardBodyProps {
  card: ApprovalCard | LinkCard;
  /** Asks waiting behind this one. */
  waiting?: number;
  /** Draw a button as if under the pointer (gallery). */
  hover?: "accept" | "refuse";
}

export function SealedCardBody({ card, waiting = 0, hover }: SealedCardBodyProps): ReactElement {
  const kit = useSealedKit();
  // The frames take the pill's own tokens, resolved where this card sits.
  const { ref, tokens } = useCardTokens(PILL_CARD_SOURCES);
  const trailing = [card.computer, cardTrailing(0, 1, waiting)].filter(Boolean).join(" · ");
  return (
    <div ref={ref} className="clp-card-frame">
      <kit.Card id={card.id} tokens={tokens} className="clp-card">
        <div className="clp-card-header">
          <Glyph name={card.kind === "link" ? "link" : "hand"} />
          <span className="clp-card-source">
            <kit.Field name="source" />
          </span>
          {trailing ? <span className="clp-card-trailing">{trailing}</span> : null}
        </div>
        <kit.Field name="ask" lines={4} className="clp-card-ask" />
        {card.kind === "approval" ? <kit.Field name="command" lines={5} className="clp-card-command" /> : <kit.Field name="host" className="clp-card-command" />}
        {card.kind === "approval" ? <kit.Field name="risk" lines={2} className="clp-card-risk" /> : null}
        <div className="clp-card-actions">
          <span className="clp-card-status" />
          <span className="clp-slot" data-role="refuse" data-hover={hover === "refuse" || undefined}>
            <kit.Deny look="cross" size={30} />
          </span>
          <span className="clp-slot" data-role="accept" data-hover={hover === "accept" || undefined}>
            <kit.Approve look={card.kind === "link" ? "open" : "check"} size={30} />
          </span>
        </div>
      </kit.Card>
    </div>
  );
}

export interface QuestionCardBodyProps {
  card: QuestionCard;
  draft: QuestionDraft;
  waiting?: number;
  inFlight?: boolean;
  error?: string | null;
  onChoose?: (question: number, option: number) => void;
  onType?: (question: number, text: string) => void;
  onBack?: () => void;
  onAdvance?: () => void;
  /** Draw an option or ✓ as if under the pointer (gallery). */
  hoverOption?: number;
  hoverAccept?: boolean;
}

export function QuestionCardBody(props: QuestionCardBodyProps): ReactElement {
  const { card, draft, waiting = 0, inFlight = false, error, hoverOption, hoverAccept } = props;
  const count = card.questions.length;
  const index = Math.min(Math.max(draft.visible, 0), Math.max(count - 1, 0));
  const question = card.questions[index]!;
  const chosen = new Set(draft.selections[index] ?? []);
  const other = draft.others[index] ?? "";
  const advance = questionAdvance(card.questions, draft, inFlight);
  const trailing = [card.computer, cardTrailing(index, count, waiting)].filter(Boolean).join(" · ");
  const from = card.source ? t("clover.pill.asks", { name: card.source.name }) : t("clover.pill.aQuestion");
  return (
    <div className="clp-card" role="form" aria-label={from}>
      <div className="clp-card-header">
        <Glyph name="question" style={{ ["--glyph-cut" as string]: "#000000" }} />
        <span className="clp-card-source">{question.header ? `${from} · ${question.header}` : from}</span>
        {trailing ? <span className="clp-card-trailing">{trailing}</span> : null}
      </div>
      <div>
        <span className="clp-question">{question.question}</span>
        {question.multiSelect ? <span className="clp-question-hint">{t("clover.pill.chooseAny")}</span> : null}
      </div>
      {question.options.length > 0 ? (
        <div className="clp-options" role={question.multiSelect ? "group" : "radiogroup"} aria-label={question.question}>
          {question.options.map((option, o) => (
            <button
              key={o}
              type="button"
              role={question.multiSelect ? "checkbox" : "radio"}
              aria-checked={chosen.has(o)}
              className="clp-option"
              data-hovered={hoverOption === o || undefined}
              disabled={inFlight}
              onClick={() => props.onChoose?.(index, o)}
            >
              <span className="clp-option-words">
                <span>{option.label}</span>
                {option.description ? <span className="clp-option-detail">{option.description}</span> : null}
              </span>
              {question.multiSelect ? (
                <span className="clp-option-box" data-checked={chosen.has(o) || undefined}>
                  {chosen.has(o) ? <Glyph name="check" /> : null}
                </span>
              ) : chosen.has(o) ? (
                <span className="clp-option-mark">
                  <Glyph name="check" />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <input
        className="clp-other"
        type="text"
        value={other}
        data-filled={other.trim().length > 0 || undefined}
        placeholder={question.options.length > 0 ? t("clover.pill.somethingElse") : t("clover.pill.typeAnswer")}
        aria-label={question.options.length > 0 ? t("clover.pill.somethingElse") : t("clover.pill.typeAnswer")}
        disabled={inFlight}
        onChange={(event) => props.onType?.(index, event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && advance.enabled) {
            event.preventDefault();
            props.onAdvance?.();
          }
        }}
      />
      <div className="clp-card-actions">
        <span className="clp-card-status" data-tone={error ? "error" : undefined} role={error ? "alert" : undefined}>
          {inFlight ? t("clover.pill.sending") : (error ?? "")}
        </span>
        {index > 0 ? (
          <button type="button" className="clp-answer" data-role="refuse" aria-label={t("clover.pill.back")} disabled={inFlight} onClick={props.onBack}>
            <Glyph name="chevronLeft" />
          </button>
        ) : null}
        <button
          type="button"
          className="clp-answer"
          data-role="accept"
          aria-label={advance.action === "send" ? t("clover.pill.send") : t("clover.pill.next")}
          title={advance.action === "send" ? t("clover.pill.send") : t("clover.pill.next")}
          disabled={!advance.enabled}
          data-hover={hoverAccept || undefined}
          onClick={props.onAdvance}
        >
          <Glyph name="check" />
        </button>
      </div>
    </div>
  );
}

export interface CardBodyProps extends Omit<QuestionCardBodyProps, "card"> {
  card: PillCard;
  hover?: "accept" | "refuse";
}

export function CardBody(props: CardBodyProps): ReactElement {
  const { card } = props;
  return card.kind === "question" ? <QuestionCardBody {...props} card={card} /> : <SealedCardBody card={card} waiting={props.waiting} hover={props.hover} />;
}
