// How a holder judges another computer's call (review N2; controller ruling R1, "approvals that follow the files"):
// at the stricter of its own level and the call's.
//
// * `allow` runs, and `deny` (read-only) refuses, whatever the answer.
// * At `ask-risky` the holder runs its own reviewer on the call, as it does on a local one (lane C's reviewer). What it
//   passes runs; what it judges risky needs the user's answer. Where the level always asks (`ask`, and deletes at
//   `ask-risky`), the answer is needed in every case.
// * The answer is the user's, signed on any of their devices (any desktop or phone, item 91) and bound to exactly this
//   call; the holder rebuilds its own card for it and compares (`verifySignedAnswer`). A refusal that an answer would
//   lift says so (`needsAnswer`) and carries the holder's own card, so the calling computer shows the user exactly that
//   card and sends the signed answer back with the call.
import { createHash } from "node:crypto";
import type { Caller, CardContent, Level, SignedCardAnswer, TreeTransferParams, TurnOrigin } from "@waifucave/clover-protocol";
import { DEFAULT_LEVEL, TREE_TRANSFER } from "@waifucave/clover-protocol";
import {
  levelDecision, strictestLevel, verifySignedAnswer,
  type ActionEffect, type AnswerDevices, type AnswerLedger, type CallCardRenderer,
} from "../contracts/approval-broker";
import { ContractError, isContractError } from "../contracts/common";
import { CARD_PROOF_MAX_AGE_MS } from "../contracts/computer-registry";

/** How old a signed answer may be when it arrives: the card proof's own bound (the unattended card timeout). A device
 *  signs the moment the user answers and the call goes again at once; an older answer is a replay, or the user's
 *  answer to an earlier try, and the card goes back to them. It also bounds how long a used card id must be kept
 *  (the node's `FileAnswerLedger` keeps each twice as long). */
export const SIGNED_ANSWER_MAX_AGE_MS = CARD_PROOF_MAX_AGE_MS;

/** Whether a signed answer is recent enough to take (`SIGNED_ANSWER_MAX_AGE_MS`); its upper bound is
 *  `answerTimeOk`'s, inside `verifySignedAnswer`. */
export function answerFresh(answer: Pick<SignedCardAnswer, "at">, now: number): boolean {
  return answer.at >= now - SIGNED_ANSWER_MAX_AGE_MS;
}

/** The reviewer for a peer's call at `ask-risky` (lane C's): `safe` runs; `risky`, or `unavailable` (no model can run),
 *  needs the user's answer. A peer's command gets its effect too; a tree change is B-M1's `TreeReviewer`, which any
 *  `PeerReviewer` also is. */
export type PeerReviewer = (call: { computer: string; method: string; params: unknown; as: Caller; effect?: ActionEffect }) => Promise<"safe" | "risky" | "unavailable">;

export interface Answers {
  devices: AnswerDevices;
  ledger: AnswerLedger;
  render: CallCardRenderer;
}

/** What a refusal an answer would lift carries. */
export interface NeedsAnswer {
  needsAnswer: true;
  computer: string;
  method: string;
  /** The holder's own card for the call, for the calling computer to show. */
  card?: CardContent;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The refusal that tells the calling computer which card to show. */
export function needsAnswer(computer: string, method: string, params: unknown, render: CallCardRenderer | undefined, why: string): ContractError {
  const card = render?.({ computer, method, params });
  const detail: NeedsAnswer = { needsAnswer: true, computer, method, ...(card ? { card } : {}) };
  return new ContractError("refused", why, detail as unknown as Record<string, unknown>);
}

/** The refusal's detail, when an answer would lift it. */
export function answerNeeded(err: unknown): NeedsAnswer | null {
  if (!isContractError(err, "refused")) return null;
  const d = err.detail as Partial<NeedsAnswer> | undefined;
  return d?.needsAnswer === true && typeof d.computer === "string" && typeof d.method === "string" ? (d as NeedsAnswer) : null;
}

export async function judgePeer(o: {
  computer: string;
  ownLevel: Level | undefined;
  callLevel: Level;
  effect: ActionEffect;
  method: string;
  /** What an answer binds: the call's method and params without session, level and answer. */
  params: unknown;
  as: Caller;
  answer?: SignedCardAnswer;
  reviewer?: PeerReviewer;
  answers?: Answers;
  now: number;
}): Promise<void> {
  // The computer the card names: this one, or for a move or copy between two (R15) the destination its params name,
  // whichever end asks; the answer is checked as this computer either way (`bindsComputer`).
  const cardComputer = o.method === TREE_TRANSFER ? (o.params as TreeTransferParams).destination : o.computer;
  const level = strictestLevel([o.ownLevel ?? DEFAULT_LEVEL, o.callLevel])!;
  const d = levelDecision(level, o.effect);
  if (d === "allow") return;
  if (d === "deny") throw new ContractError("refused", `${o.computer} doesn't let another computer do this at its level`);
  if (!o.answer) {
    if (d === "review" && o.reviewer) {
      const verdict = await o.reviewer({ computer: o.computer, method: o.method, params: o.params, as: o.as, effect: o.effect });
      if (verdict === "safe") return;
    }
    throw needsAnswer(cardComputer, o.method, o.params, o.answers?.render, `${o.computer} needs the user's answer for this, signed and bound to it`);
  }
  if (!o.answers) throw new ContractError("refused", `${o.computer} takes no signed answers`);
  // Too old to take: checked before the signature, so a stale answer never claims its card id.
  if (!answerFresh(o.answer, o.now)) {
    throw needsAnswer(cardComputer, o.method, o.params, o.answers.render, `that answer is too old; ${o.computer} needs a new one`);
  }
  // Each end checks the one answer as itself: for `tree.transfer` its card binds both computers (`bindsComputer`).
  const verdict = await verifySignedAnswer(o.answer, { self: o.computer, method: o.method, params: o.params, now: o.now, sha256, ...o.answers });
  // An answer spent already, or too old, is the user's real answer to an earlier try: the card goes back to them
  // (#177's review), and the caller asks again. Anything else is refused outright.
  if (verdict === "used" || verdict === "bad-time") {
    throw needsAnswer(cardComputer, o.method, o.params, o.answers.render, `that answer was ${verdict === "used" ? "used already" : "too old"}; ${o.computer} needs a new one`);
  }
  if (verdict !== "ok") throw new ContractError("refused", `the answer doesn't hold for this call (${verdict})`, { verdict });
}

/** The calling computer's side (R1, "the card on the caller"): shows the user the holder's own card, on any of their
 *  devices, and gives back their signed answer, or null for a deny or no answer (lanes B and C's broker). */
export type AnswerAsker = (need: NeedsAnswer, ctx: AskContext) => Promise<SignedCardAnswer | null>;

/** Whose call the card is for, on the calling computer (askUser raises it through this computer's broker): the
 *  caller (a bot's or a coding session's, the user's own surface, a plugin), the turn's origin when the tool layer
 *  knows it, and the call's signal. A card from a turn the user didn't start is denied 10 minutes after it shows. */
export interface AskContext {
  as: Caller;
  origin?: TurnOrigin;
  signal?: AbortSignal;
}

/** The origin a card shows with when the call didn't say: the user's own surfaces' calls are the user's; anything
 *  else is taken as unattended (its card expires), never as the user's. */
export function askOrigin(ctx: AskContext): TurnOrigin {
  if (ctx.origin !== undefined) return ctx.origin;
  switch (ctx.as.kind) {
    case "user": return "user";
    case "plugin": return "plugin";
    case "peer": return "peer";
    case "session": return ctx.as.sessionKind === "agent" ? "agent" : "bot";
    default: return "bot";
  }
}

/** The ask context for an in-process call. */
export function askContextOf(call: { as: Caller; origin?: TurnOrigin; signal?: AbortSignal }): AskContext {
  return { as: call.as, ...(call.origin === undefined ? {} : { origin: call.origin }), ...(call.signal === undefined ? {} : { signal: call.signal }) };
}

/** Runs a call; when the holder says an answer would lift its refusal, asks the user with the holder's card (for
 *  `ctx`'s caller) and runs it once more with their signed answer. */
export async function withAnswer<T>(ask: AnswerAsker | undefined, ctx: AskContext, run: (answer?: SignedCardAnswer) => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const need = answerNeeded(e);
    if (!need || !ask) throw e;
    const answer = await ask(need, ctx);
    if (!answer) throw e;
    return run(answer);
  }
}
