// What a card asks, as the island draws it.
//
// The one change from Winter's island: in Clover an approval is SEALED (spec §5.5). The island hears a
// pending card's id and its computer, never its text, and places the core's sealed parts — the fields
// and the approve and deny buttons — wherever its layout wants them. So an approval or a link request
// carries no words here: the words arrive inside sealed frames (`SealedCardKit`). A question is not a
// security boundary (`AskUserQuestion`, spec §5.5), so its text and options are the island's to show.

export type CardKind = "approval" | "link" | "question";

/** The bot (or agent) a card belongs to, when the island knows it. */
export interface CardSource {
  id: string;
  name: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  /** A short tag for the question, shown in its header. */
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface CardBase {
  /** The card's id: what the core and the sealed parts know it by. */
  id: string;
  source?: CardSource;
  /** The computer the request runs on (what `approvals.watch` tells a plugin besides the id). */
  computer?: string;
  /** Epoch ms. */
  issuedAt?: number;
}

export interface ApprovalCard extends CardBase {
  kind: "approval";
}

export interface LinkCard extends CardBase {
  kind: "link";
}

export interface QuestionCard extends CardBase {
  kind: "question";
  questions: Question[];
}

export type IslandCard = ApprovalCard | LinkCard | QuestionCard;

/** Every card compacts by itself after a while; nothing in 1.111.1 counts down on its own. */
export function selfCompacts(_card: IslandCard): boolean {
  return true;
}

export function isSealed(card: IslandCard): card is ApprovalCard | LinkCard {
  return card.kind !== "question";
}

/** Who is asking, in words the island may say: the bot's name, else nothing (the sealed source says it). */
export function sourceLabel(card: IslandCard): string | null {
  const name = card.source?.name.trim();
  return name ? name : null;
}

/** A question card's header line: who asks. */
export function questionHeader(card: QuestionCard): string {
  const who = sourceLabel(card);
  return who ? `${who} asks` : "A question for you";
}

/** "2 of 3" on a card with several questions. */
export function questionPosition(index: number, count: number): string | null {
  return count > 1 ? `${index + 1} of ${count}` : null;
}

const KIND_WORD: Record<CardKind, string> = { approval: "Approval", link: "Link", question: "Question" };

/**
 * The waiting pill's one short line: what kind of card, and whose. Only what the island may know — a
 * sealed card's own words stay in its frames, which a pill this small does not place.
 */
export function waitingLine(card: IslandCard): string {
  const who = sourceLabel(card);
  return who ? `${KIND_WORD[card.kind]} · ${who}` : KIND_WORD[card.kind];
}

/** What a screen reader hears for the ✕ and the ✓. */
export function answerLabels(card: IslandCard): { refuse: string; accept: string } {
  switch (card.kind) {
    case "link":
      return { refuse: "Decline the link", accept: "Open the link" };
    case "approval":
      return { refuse: "Deny", accept: "Allow once" };
    case "question":
      return { refuse: "Previous question", accept: "Send" };
  }
}

/** Whether a question has an answer: an option chosen, or words typed. */
export function questionAnswered(selected: readonly number[] | undefined, other: string | undefined): boolean {
  return (other?.trim().length ?? 0) > 0 || (selected?.length ?? 0) > 0;
}

export interface QuestionDraft {
  /** The question showing. */
  visible: number;
  selections: Record<number, number[]>;
  others: Record<number, string>;
}

export const emptyDraft = (): QuestionDraft => ({ visible: 0, selections: {}, others: {} });

/** A click on an option: a single-choice question takes it (and drops typed words); a multiple one toggles it. */
export function chooseOption(draft: QuestionDraft, question: Question, index: number, option: number): QuestionDraft {
  if (question.multiSelect) {
    const set = new Set(draft.selections[index] ?? []);
    if (set.has(option)) set.delete(option);
    else set.add(option);
    return { ...draft, selections: { ...draft.selections, [index]: [...set].sort((a, b) => a - b) } };
  }
  const others = { ...draft.others };
  delete others[index];
  return { ...draft, selections: { ...draft.selections, [index]: [option] }, others };
}

/** Typed words: on a single-choice question they replace the chosen option. */
export function typeOther(draft: QuestionDraft, question: Question, index: number, text: string): QuestionDraft {
  const selections = { ...draft.selections };
  if (!question.multiSelect && text.trim().length > 0) delete selections[index];
  return { ...draft, selections, others: { ...draft.others, [index]: text } };
}

/** The answers, keyed by question text: the chosen labels (joined), or the typed words. */
export function questionAnswers(questions: readonly Question[], draft: QuestionDraft): Record<string, string> {
  const out: Record<string, string> = {};
  questions.forEach((q, i) => {
    const other = draft.others[i]?.trim();
    const chosen = (draft.selections[i] ?? []).map((o) => q.options[o]?.label).filter((l): l is string => Boolean(l));
    const parts = [...chosen, ...(other ? [other] : [])];
    if (parts.length > 0) out[q.question] = parts.join(", ");
  });
  return out;
}

export function draftComplete(questions: readonly Question[], draft: QuestionDraft): boolean {
  return questions.every((_, i) => questionAnswered(draft.selections[i], draft.others[i]));
}
