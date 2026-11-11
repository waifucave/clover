// askUser (R1, "the card on the caller"): when another computer's holder refuses a call until the user answers, this
// computer shows the user that holder's own card through its approval broker and hands back their signed answer.
//
// * The card is the holder's, raised as it is (`ApprovalRequest.boundCard`, lane C): exactly its content and its
//   sealed binding, never re-rendered here, so what the user signs is what the holder rebuilds from the call itself
//   and compares (`verifySignedAnswer`). The card is checked against the refusal first: one bound call, the method
//   the refusal names, on the computer it names (and, for a transfer, its source).
// * It is the asking call's card: its session (withdrawn on the user's interrupt, cancelled when it stops), its bot,
//   and its turn's origin (`askOrigin`: a call that didn't say is unattended, so its card is denied after 10 minutes).
// * Its first line is Clover's (`callCardTitle`), naming the computer that holds the call; a card that doesn't open
//   with exactly that line isn't shown (the holder words the rest of its card, never the line that says whose it is).
// * Only a device's signature travels: the broker hands back the proof that approved the card
//   (`ApprovalDecision.signed`). An answer in a sealed frame (the app without an answer key), a deny, an expired or
//   withdrawn card, a refusal or a broker that fails all give null, and the call stays refused.
import { CallBinding, Card, type SignedCardAnswer } from "@waifucave/clover-protocol";
import type { ActionEffect, ApprovalBroker } from "../contracts/approval-broker";
import { askOrigin, type AnswerAsker } from "../tree/judge";
import { callCardTitle } from "./call-cards";

/** The holder's card as a refusal carries it: a card's content, its binding sealed. */
const HolderCard = Card.pick({ kind: true, fields: true, options: true, change: true, children: true }).extend({ binds: CallBinding });

/** What each call a card may bind does, for the request's effect (the card is always shown: rule 9). */
export function effectOfCall(method: string): ActionEffect {
  switch (method) {
    case "tree.remove": return "delete";
    case "tree.move": case "tree.transfer": return "move";
    case "tree.write": case "tree.mkdir": case "tree.symlink": return "edit";
    case "tool.run": case "terminal.open": case "mcp.mirror": return "execute";
    default: return "other";
  }
}

export function brokerAsker(o: { broker: Pick<ApprovalBroker, "request" | "get">; log?: (line: string) => void }): AnswerAsker {
  const log = o.log ?? (() => {});
  return async (need, ctx) => {
    const parsed = HolderCard.safeParse(need.card);
    if (!parsed.success) {
      log(`askUser: ${need.computer}'s refusal of ${need.method} carried no card this computer can show`);
      return null;
    }
    const card = parsed.data;
    const b = card.binds;
    // The card binds the call the refusal names, on the computer it names.
    if (b.method !== need.method || b.computer !== need.computer) {
      log(`askUser: ${need.computer}'s card for ${need.method} binds another call`);
      return null;
    }
    // Its first line is Clover's, naming the computer that holds the call (the stage 1 review): a paired computer words
    // the rest of its card, never that line. A card without it isn't shown.
    const title = card.fields.title;
    if (title?.type !== "text" || title.text !== callCardTitle(need.computer)) {
      log(`askUser: ${need.computer}'s card for ${need.method} doesn't open with Clover's line naming it`);
      return null;
    }
    const as = ctx.as;
    const session = as.kind === "session" ? as.sessionId : undefined;
    const bot = as.kind === "session" ? as.bot : undefined;
    try {
      const d = await o.broker.request({
        kind: card.kind, ...(card.change === undefined ? {} : { change: card.change }),
        origin: askOrigin(ctx), computers: [b.computer, ...(b.source === undefined ? [] : [b.source])],
        effect: effectOfCall(need.method), fields: card.fields, boundCard: card,
        ...(session === undefined ? {} : { session }), ...(bot === undefined ? {} : { bot }),
      }, ctx.signal ? { signal: ctx.signal } : {});
      if (!d.allowed || d.signed === undefined || d.cardId === undefined || d.optionId === undefined) return null;
      const shown = o.broker.get(d.cardId)?.card;
      // The card the user answered is the one raised: the holder's binding, as sealed.
      if (!shown || shown.binds?.params !== b.params || shown.binds.method !== b.method || shown.binds.computer !== b.computer) return null;
      const answer: SignedCardAnswer = {
        card: shown, option: d.optionId, device: d.signed.device, at: d.signed.at, signature: d.signed.signature,
        ...(d.signed.children === undefined ? {} : { children: d.signed.children }),
      };
      return answer;
    } catch (e) {
      log(`askUser: the approval broker failed on ${need.computer}'s card: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
}
