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
import type { Caller, CardContent, Level, SignedCardAnswer } from "@waifucave/clover-protocol";
import { DEFAULT_LEVEL } from "@waifucave/clover-protocol";
import {
  levelDecision, strictestLevel, verifySignedAnswer,
  type ActionEffect, type AnswerDevices, type AnswerLedger, type CallCardRenderer,
} from "../contracts/approval-broker";
import { ContractError, isContractError } from "../contracts/common";

/** The holder's reviewer for a peer's call at `ask-risky` (lane C's; the shape of B-M1's `TreeReviewer`): `safe` runs;
 *  `risky`, or `unavailable` (no model can run), needs the user's answer. */
export type PeerReviewer = (call: { computer: string; method: string; params: unknown; as: Caller; effect: ActionEffect }) => Promise<"safe" | "risky" | "unavailable">;

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
  /** The computer the card binds, when one card covers an operation on several (a move or copy between two: the
   *  destination; the controller's one-card ruling). Its params name every computer, and this one must be among
   *  them; each holder rebuilds the same card and checks the answer against it. Default: this computer. */
  boundTo?: string;
}): Promise<void> {
  const level = strictestLevel([o.ownLevel ?? DEFAULT_LEVEL, o.callLevel])!;
  const d = levelDecision(level, o.effect);
  if (d === "allow") return;
  if (d === "deny") throw new ContractError("refused", `${o.computer} doesn't let another computer do this at its level`);
  if (!o.answer) {
    if (d === "review" && o.reviewer) {
      const verdict = await o.reviewer({ computer: o.computer, method: o.method, params: o.params, as: o.as, effect: o.effect });
      if (verdict === "safe") return;
    }
    throw needsAnswer(o.boundTo ?? o.computer, o.method, o.params, o.answers?.render, `${o.computer} needs the user's answer for this, signed and bound to it`);
  }
  if (!o.answers) throw new ContractError("refused", `${o.computer} takes no signed answers`);
  const verdict = await verifySignedAnswer(o.answer, { self: o.boundTo ?? o.computer, method: o.method, params: o.params, now: o.now, sha256, ...o.answers });
  // An answer spent already, or too old, is the user's real answer to an earlier try: the card goes back to them
  // (#177's review), and the caller asks again. Anything else is refused outright.
  if (verdict === "used" || verdict === "bad-time") {
    throw needsAnswer(o.boundTo ?? o.computer, o.method, o.params, o.answers.render, `that answer was ${verdict === "used" ? "used already" : "too old"}; ${o.computer} needs a new one`);
  }
  if (verdict !== "ok") throw new ContractError("refused", `the answer doesn't hold for this call (${verdict})`, { verdict });
}

/** The calling computer's side (R1, "the card on the caller"): shows the user the holder's own card, on any of their
 *  devices, and gives back their signed answer, or null for a deny or no answer (lanes B and C's broker). */
export type AnswerAsker = (need: NeedsAnswer) => Promise<SignedCardAnswer | null>;

/** Runs a call; when the holder says an answer would lift its refusal, asks the user with the holder's card and runs it
 *  once more with their signed answer. */
export async function withAnswer<T>(ask: AnswerAsker | undefined, run: (answer?: SignedCardAnswer) => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const need = answerNeeded(e);
    if (!need || !ask) throw e;
    const answer = await ask(need);
    if (!answer) throw e;
    return run(answer);
  }
}
