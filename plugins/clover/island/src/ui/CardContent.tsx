// What a card says, laid out the way every island card is (Winter's `IslandRectContent`,
// `IslandAnswerLine`, `IslandQuestionBody`): a header — the amber kind glyph, who asks, and on the right
// where or which question — then the words with ✕ and ✓ at the trailing end, bottom-aligned with the last
// line. An approval's and a link request's words and buttons are sealed parts; a question's are the
// island's own.

import type { ReactElement } from "react";
import {
  answerLabels,
  questionAnswered,
  questionHeader,
  questionPosition,
  type ApprovalCard,
  type LinkCard,
  type QuestionCard,
  type QuestionDraft,
} from "../model/cards";
import { t } from "../strings";
import { CircleButton, SealedSlot } from "./Buttons";
import { Glyph, kindGlyph } from "./glyphs";
import { ISLAND_CARD_TOKENS, useSealedKit } from "./sealed";

export interface SealedCardContentProps {
  card: ApprovalCard | LinkCard;
  /** The most lines the request shows. */
  lines?: number;
  /** Show the command or input as well (the open island's Needs you has room for it). */
  withCommand?: boolean;
  /** Draw a button as if under the pointer (gallery). */
  hover?: "accept" | "refuse";
}

export function SealedCardContent({ card, lines = 4, withCommand = false, hover }: SealedCardContentProps): ReactElement {
  const kit = useSealedKit();
  return (
    <kit.Card id={card.id} tokens={ISLAND_CARD_TOKENS} className="clv-card-parts">
      <div className="clv-card-header">
        <Glyph name={kindGlyph(card.kind)} />
        <span className="clv-card-header-line">
          <kit.Field name="source" />
        </span>
        {card.computer ? <span className="clv-card-header-trailing">{card.computer}</span> : null}
      </div>
      {withCommand && card.kind === "approval" ? <kit.Field name="command" className="clv-command" lines={6} /> : null}
      <div className="clv-answer-line">
        <div className="clv-answer-words">
          <kit.Field name="ask" lines={lines} />
          {card.kind === "link" ? (
            <span className="clv-host-line">
              <Glyph name="lock" />
              <kit.Field name="host" />
            </span>
          ) : null}
        </div>
        <SealedSlot approve={false} look="cross" hover={hover === "refuse"} />
        <SealedSlot approve look={card.kind === "link" ? "open" : "check"} hover={hover === "accept"} />
      </div>
    </kit.Card>
  );
}

export interface QuestionCardContentProps {
  card: QuestionCard;
  draft: QuestionDraft;
  onChoose?: (question: number, option: number) => void;
  onType?: (question: number, text: string) => void;
  onBack?: () => void;
  /** ✓ on the last question (send), › on the others (next). */
  onAdvance?: () => void;
  /** A failed answer's line. */
  error?: string;
  sending?: boolean;
  /** Draw an option or the ✓ as if under the pointer (gallery). */
  hoverOption?: number;
  hoverAccept?: boolean;
}

export function QuestionCardContent(props: QuestionCardContentProps): ReactElement {
  const { card, draft, onChoose, onType, onBack, onAdvance, error, sending = false, hoverOption, hoverAccept } = props;
  const count = card.questions.length;
  const index = Math.min(draft.visible, Math.max(count - 1, 0));
  const question = card.questions[index];
  const position = questionPosition(index, count);
  const answered = questionAnswered(draft.selections[index], draft.others[index]);
  const last = index >= count - 1;
  return (
    <div className="clv-card-parts">
      <div className="clv-card-header">
        <Glyph name="question" />
        <span className="clv-card-header-line">{questionHeader(card)}</span>
        {position ? <span className="clv-card-header-trailing">{position}</span> : null}
      </div>
      {question ? (
        <>
          <div className="clv-question-text">{question.question}</div>
          <div className="clv-options" role={question.multiSelect ? "group" : "radiogroup"} aria-label={question.header ?? question.question}>
            {question.options.map((option, i) => {
              const chosen = draft.selections[index]?.includes(i) ?? false;
              return (
                <button
                  key={i}
                  type="button"
                  role={question.multiSelect ? "checkbox" : "radio"}
                  aria-checked={chosen}
                  className="clv-option"
                  data-hover={hoverOption === i || undefined}
                  onClick={() => onChoose?.(index, i)}
                >
                  <span className="clv-option-label">{option.label}</span>
                  {question.multiSelect ? <span className="clv-option-box">{chosen ? <Glyph name="check" size={9} /> : null}</span> : null}
                </button>
              );
            })}
            <input
              className="clv-other"
              type="text"
              aria-label={question.options.length > 0 ? t("clover.island.otherPlaceholder") : t("clover.island.typeAnswer")}
              placeholder={question.options.length > 0 ? t("clover.island.otherPlaceholder") : t("clover.island.typeAnswer")}
              value={draft.others[index] ?? ""}
              onChange={(event) => onType?.(index, event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onAdvance?.();
              }}
            />
          </div>
          <div className="clv-card-actions">
            <span className="clv-card-status" role={error ? "alert" : undefined}>
              {error ?? ""}
            </span>
            {index > 0 ? <CircleButton role="refuse" glyph="chevronLeft" label={t("clover.island.previous")} onClick={onBack} /> : null}
            <CircleButton
              role="accept"
              glyph={last ? "check" : "chevronRight"}
              label={last ? answerLabels(card).accept : t("clover.island.next")}
              enabled={answered && !sending}
              hover={hoverAccept}
              onClick={onAdvance}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}
