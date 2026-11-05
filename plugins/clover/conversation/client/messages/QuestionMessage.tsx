// `AskUserQuestion`: the bot's question with its options. Unlike an approval it is readable data, so
// the view draws it whole (spec §5.5). A menu of two to four options always has a free-text box under
// it; a question with no options is answered by typing alone.
import { useId, useState } from "react";
import type { MessageContext } from "../context";
import { minutesUntil } from "../format";
import { IconQuestion } from "../icons";
import { S } from "../strings";
import type { Question, QuestionItem } from "../types";

/** What the user has picked or typed for one question, before sending. */
export interface QuestionDraft {
  selected: string[];
  other: string;
}

const emptyDraft = (): QuestionDraft => ({ selected: [], other: "" });

/** The answer a draft gives: typed text wins over a single choice; several choices and typed text
 *  join with ", ". Empty means unanswered. */
export function answerOf(question: Question, draft: QuestionDraft): string {
  const typed = draft.other.trim();
  if (!question.multiSelect) return typed || draft.selected[0] || "";
  return [...draft.selected, typed].filter((s) => s.length > 0).join(", ");
}

function Answered({ item }: { item: QuestionItem }) {
  const on = item.answeredOn ? ` ${S.answeredOn(item.answeredOn)}` : "";
  return (
    <section className="cl-conv-question" data-kind="question" data-state="answered">
      <div className="cl-conv-question__head">
        <IconQuestion />
        <span>{`${S.questionAnswered}${on}`}</span>
      </div>
      <dl className="cl-conv-question__answers">
        {item.questions.map((q) => (
          <div key={q.question} className="cl-conv-question__answer">
            <dt>{q.question}</dt>
            <dd>{item.answers?.[q.question] ?? ""}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Closed({ item, ctx }: { item: QuestionItem; ctx: MessageContext }) {
  const text = item.state === "expired" ? S.questionExpired(ctx.botName) : S.questionWithdrawn;
  return (
    <section className="cl-conv-question" data-kind="question" data-state={item.state}>
      <div className="cl-conv-question__head">
        <IconQuestion />
        <span>{item.questions[0]?.question}</span>
      </div>
      <div className="cl-conv-question__closed">{text}</div>
    </section>
  );
}

function QuestionFields({
  question,
  draft,
  onDraft,
  disabled,
  showHeader,
  onEnter,
}: {
  question: Question;
  draft: QuestionDraft;
  onDraft: (draft: QuestionDraft) => void;
  disabled: boolean;
  showHeader: boolean;
  onEnter: () => void;
}) {
  const name = useId();
  const otherId = useId();
  const menu = question.options.length > 0;
  const choose = (label: string) => {
    if (question.multiSelect) {
      const selected = draft.selected.includes(label) ? draft.selected.filter((l) => l !== label) : [...draft.selected, label];
      onDraft({ ...draft, selected });
    } else {
      onDraft({ selected: [label], other: "" });
    }
  };
  const preview = question.options.find((o) => draft.selected.includes(o.label) && o.preview)?.preview;
  return (
    <fieldset className="cl-conv-question__field" disabled={disabled}>
      <legend className="cl-conv-question__legend">
        {showHeader && question.header && <span className="cl-conv-question__chip">{question.header}</span>}
        <span className="cl-conv-question__text">{question.question}</span>
      </legend>
      <div className="cl-conv-question__body" data-preview={preview !== undefined || undefined}>
        <div className="cl-conv-question__choices">
          {question.options.map((option) => (
            <label key={option.label} className="cl-conv-question__option" data-selected={draft.selected.includes(option.label) || undefined}>
              <input
                type={question.multiSelect ? "checkbox" : "radio"}
                name={name}
                checked={draft.selected.includes(option.label)}
                onChange={() => choose(option.label)}
              />
              <span className="cl-conv-question__option-text">
                <span className="cl-conv-question__option-label">{option.label}</span>
                {option.description && <span className="cl-conv-question__option-description">{option.description}</span>}
              </span>
            </label>
          ))}
          <label className="cl-conv-question__other" htmlFor={otherId}>
            <span className="cl-conv-question__other-label">{menu ? S.questionOther : S.questionTypeAnswer}</span>
            <input
              id={otherId}
              type="text"
              className="cl-conv-question__input"
              value={draft.other}
              placeholder={question.placeholder ?? ""}
              onChange={(e) => onDraft({ selected: question.multiSelect ? draft.selected : [], other: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onEnter();
                }
              }}
            />
          </label>
        </div>
        {preview !== undefined && (
          <figure className="cl-conv-question__preview">
            <figcaption>{S.questionPreview}</figcaption>
            <pre>{preview}</pre>
          </figure>
        )}
      </div>
    </fieldset>
  );
}

export function QuestionMessage({
  item,
  ctx,
  initialDraft,
}: {
  item: QuestionItem;
  ctx: MessageContext;
  /** A draft to start from, for a card remounted with the user's half-made answer. */
  initialDraft?: QuestionDraft[];
}) {
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => item.questions.map((_, i) => initialDraft?.[i] ?? emptyDraft()));
  const [sent, setSent] = useState(false);
  if (item.state === "answered") return <Answered item={item} />;
  if (item.state !== "pending") return <Closed item={item} ctx={ctx} />;

  const answers = item.questions.map((q, i) => answerOf(q, drafts[i] ?? emptyDraft()));
  const ready = answers.every((a) => a.length > 0);
  const canSend = ready && !sent && ctx.actions.onAnswerQuestion !== undefined;
  const send = () => {
    if (!canSend) return;
    const keyed: Record<string, string> = {};
    item.questions.forEach((q, i) => {
      keyed[q.question] = answers[i] ?? "";
    });
    setSent(true);
    ctx.actions.onAnswerQuestion?.(item.callId, { answers: keyed });
  };
  const minutes = item.expiresAt === undefined ? undefined : minutesUntil(item.expiresAt, ctx.now);
  const several = item.questions.length > 1;
  return (
    <section className="cl-conv-question" data-kind="question" data-state="pending" aria-label={S.questionAsks(ctx.botName)}>
      <div className="cl-conv-question__head">
        <IconQuestion />
        <span>{S.questionAsks(ctx.botName)}</span>
      </div>
      {item.questions.map((question, i) => (
        <QuestionFields
          key={question.question}
          question={question}
          draft={drafts[i] ?? emptyDraft()}
          onDraft={(draft) => setDrafts((all) => all.map((d, j) => (j === i ? draft : d)))}
          disabled={sent}
          showHeader={several}
          onEnter={send}
        />
      ))}
      <div className="cl-conv-question__footer">
        {minutes !== undefined && <span className="cl-conv-question__deadline">{S.questionGoesOnIn(ctx.botName, minutes)}</span>}
        <button type="button" className="cl-conv-question__send" disabled={!canSend} onClick={send}>
          {S.questionSubmit}
        </button>
      </div>
    </section>
  );
}
