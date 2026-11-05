// What the pill asks the user (the Swift pill's cards): the main pill MORPHS into the card on top, the rest
// wait behind it. As on the island, an approval or a link request is SEALED in Clover (spec §5.5): the pill
// hears a pending card's id and computer, never its words, and places the core's sealed parts. A question
// (`AskUserQuestion`) is readable, so its words and options are the pill's to draw.
//
// A question's rules, the island's too: choosing an option never sends by itself; ✓ (Next, then Send) does,
// once the question showing has an answer. Pure.

export type PillCardKind = "approval" | "link" | "question";

export interface PillCardSource {
  id: string;
  name: string;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface CardBase {
  id: string;
  /** The bot or agent the ask comes from: the pill's own target, or one of its children. */
  source?: PillCardSource;
  computer?: string;
}

export interface ApprovalCard extends CardBase {
  kind: "approval";
  /** Its answers' ids and kinds; absent, one approve and one deny. */
  options?: readonly CardOptionMeta[];
}

/** A link to open (lane B's `elicitation` card kind). */
export interface LinkCard extends CardBase {
  kind: "link";
  options?: readonly CardOptionMeta[];
}
/** A sealed card's answer, as `approvals.watch` lists it (`CardMeta.options`): its id and kind, never its label. */
export interface CardOptionMeta {
  id: string;
  kind: "approve" | "deny";
  /** The "always allow" answer: its sealed label says so. */
  remember?: "always";
}

/** A sealed button to place: which answer, and how it looks. */
export interface SealedButtonPlan {
  approve: boolean;
  /** The option's id; absent, the first option of its kind. */
  option?: string;
  look: "label" | "check" | "cross" | "open";
}

/**
 * One sealed button per option (lane B: one `<Card.Approve option>` per approve option, one `<Card.Deny option>` per
 * deny option), in this order: an "always" answer on its own sealed label, then ✕, then ✓ (↗ for a link) at the
 * trailing end. A card that lists no options gets the first of each kind.
 */
export function sealedButtons(card: { kind: "approval" | "link"; options?: readonly CardOptionMeta[] }): SealedButtonPlan[] {
  const accept: SealedButtonPlan["look"] = card.kind === "link" ? "open" : "check";
  const options = card.options ?? [];
  if (options.length === 0) return [{ approve: false, look: "cross" }, { approve: true, look: accept }];
  return [
    ...options.filter((o) => o.kind === "approve" && o.remember === "always").map((o) => ({ approve: true, option: o.id, look: "label" as const })),
    ...options.filter((o) => o.kind === "deny").map((o) => ({ approve: false, option: o.id, look: "cross" as const })),
    ...options.filter((o) => o.kind === "approve" && o.remember !== "always").map((o) => ({ approve: true, option: o.id, look: accept })),
  ];
}


export interface QuestionCard extends CardBase {
  kind: "question";
  questions: Question[];
}

export type PillCard = ApprovalCard | LinkCard | QuestionCard;

export function isSealed(card: PillCard): card is ApprovalCard | LinkCard {
  return card.kind !== "question";
}

/** The header's trailing words: which question of how many, and how many asks wait behind this one. */
export function cardTrailing(questionIndex: number, questionCount: number, waiting: number): string | null {
  const parts: string[] = [];
  if (questionCount > 1) parts.push(`${questionIndex + 1} of ${questionCount}`);
  if (waiting > 0) parts.push(`+${waiting} waiting`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface QuestionDraft {
  /** The question showing. */
  visible: number;
  selections: Record<number, number[]>;
  others: Record<number, string>;
}

export const emptyDraft = (): QuestionDraft => ({ visible: 0, selections: {}, others: {} });

/** A click on an option: a single-choice question takes it (dropping typed words); a multiple one toggles it. */
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

/** Typed words: on a single-choice question they replace the chosen option; on a multiple one they join the picks. */
export function typeOther(draft: QuestionDraft, question: Question, index: number, text: string): QuestionDraft {
  const selections = { ...draft.selections };
  if (!question.multiSelect && text.trim().length > 0) delete selections[index];
  return { ...draft, selections, others: { ...draft.others, [index]: text } };
}

export function answered(draft: QuestionDraft, index: number): boolean {
  return (draft.others[index]?.trim().length ?? 0) > 0 || (draft.selections[index]?.length ?? 0) > 0;
}

export function draftComplete(questions: readonly Question[], draft: QuestionDraft): boolean {
  return questions.every((_, i) => answered(draft, i));
}

/** ✓'s job and whether it is live: Next before the last question, Send on it (every question answered). */
export function questionAdvance(questions: readonly Question[], draft: QuestionDraft, inFlight: boolean): { action: "next" | "send"; enabled: boolean } {
  const index = Math.min(Math.max(draft.visible, 0), Math.max(questions.length - 1, 0));
  const isLast = index >= questions.length - 1;
  const action = isLast ? "send" : "next";
  if (inFlight) return { action, enabled: false };
  const here = answered(draft, index);
  return { action, enabled: isLast ? here && draftComplete(questions, draft) : here };
}

/** The answers, keyed by question: the chosen labels and any typed words, joined. */
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
