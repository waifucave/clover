// The protocol's card methods (`APPROVALS_METHODS`: card.list, card.get, card.frame, card.answer) over lane C's broker,
// for the Clover server. The broker comes up with the daemon's parts (the bot side and the agents) and goes with them,
// so each call reads it through a getter; until it is up, and after it stops, a call is refused, never answered by a
// second broker. The server has checked the role and the params against the method's spec before a handler runs.
//
// card.list and card.get hand out a card's sealed fields (the exact command, the paths, a sign-in link), so they are
// never read for a session: the spec says so (`noSessions`) and the server's gate refuses it; the handlers check again.
//
// card.answer's origin is the connection's, never the answer's: its role (a sealed frame's proof counts only through the
// app) and, for a device link, the device the link authenticated. A user's device (`remote`) answers with its own key
// only: a device proof naming another device is refused there. A paired computer (`peer`) may relay another device's
// signed answer, which holds end to end (the broker's `deviceProofVerifier`).
import { APPROVALS_METHODS, CLOVER_ERR, ERR, type Card, type CardAnswerProof, type CloverRole } from "@waifucave/clover-protocol";
import { isForSession } from "../auth/clover-caller";
import type { AnswerOrigin, AnswerResult, ApprovalBroker } from "../contracts/approval-broker";
import { CloverRpcError, type CloverConn, type CloverHandler } from "../ipc/clover";

type CardBroker = Pick<ApprovalBroker, "cards" | "get" | "frameChannel" | "answer">;

/** Why an answer wasn't taken, as `card.answer`'s `reason`. */
const REASONS: Record<Exclude<AnswerResult, "accepted">, string> = {
  "already-answered": "the card was already answered, or its time ran out",
  "unknown-card": "no such card",
  "hash-mismatch": "the card changed since it was shown",
  "bad-option": "that isn't one of the card's options",
  "bad-proof": "the answer's signature didn't check out",
  "bad-origin": "the answer can't come from here",
  "bad-time": "the answer's time is too far from this computer's",
};

function notRunning(): CloverRpcError {
  return new CloverRpcError(ERR.RETRY, "Clover's approval broker isn't running on this computer yet: try again in a moment");
}

/** The device a device link (`remote`, `peer`) authenticated; none for a connection on this computer. */
function linkDevice(role: CloverRole, caller: { kind: string; device?: string }): string | undefined {
  if (role !== "remote" && role !== "peer") return undefined;
  return caller.kind === "user" || caller.kind === "peer" ? caller.device : undefined;
}

function notForSessions(conn: CloverConn, method: string): void {
  if (isForSession(conn.caller)) throw new CloverRpcError(CLOVER_ERR.NOT_THE_USER, `${method} isn't read for a session`);
}

export function cardMethods(broker: () => CardBroker | undefined): Record<string, CloverHandler> {
  const up = (): CardBroker => {
    const b = broker();
    if (!b) throw notRunning();
    return b;
  };
  return {
    [APPROVALS_METHODS.cardList.name]: async (conn): Promise<{ cards: Card[] }> => {
      notForSessions(conn, APPROVALS_METHODS.cardList.name);
      return { cards: up().cards() };
    },
    [APPROVALS_METHODS.cardGet.name]: async (conn, params) => {
      notForSessions(conn, APPROVALS_METHODS.cardGet.name);
      const { id } = params as { id: string };
      const r = up().get(id);
      if (!r) throw new CloverRpcError(ERR.NOT_FOUND, `no card ${id}`);
      return {
        card: r.card,
        ...(r.outcome === undefined ? {} : { outcome: r.outcome }),
        ...(r.optionId === undefined ? {} : { option: r.optionId }),
        ...(r.device === undefined ? {} : { device: r.device }),
        ...(r.resolvedAt === undefined ? {} : { resolvedAt: r.resolvedAt }),
      };
    },
    [APPROVALS_METHODS.cardFrame.name]: async (_conn, params) => {
      const { id } = params as { id: string };
      const channel = up().frameChannel(id);
      if (channel === undefined) throw new CloverRpcError(ERR.NOT_FOUND, `no pending card ${id}`);
      return { channel };
    },
    [APPROVALS_METHODS.cardAnswer.name]: async (conn, params) => {
      const p = params as { id: string; hash: string; option: string; proof: CardAnswerProof; children?: string[] };
      const device = linkDevice(conn.role, conn.caller);
      const from: AnswerOrigin = { role: conn.role, ...(device === undefined ? {} : { device }) };
      // A user's device answers for itself: its link's device must be the one whose key signed.
      if (conn.role === "remote" && p.proof.via === "device" && p.proof.device !== device) {
        up();
        return { accepted: false, reason: REASONS["bad-origin"] };
      }
      const result = await up().answer(p.id, { optionId: p.option, hash: p.hash, proof: p.proof, ...(p.children ? { children: p.children } : {}) }, from);
      return result === "accepted" ? { accepted: true } : { accepted: false, reason: REASONS[result] };
    },
  };
}
