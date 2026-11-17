// The protocol's card methods (`APPROVALS_METHODS`: card.list, card.get, card.frame, card.answer) over lane C's broker,
// for the MOSS server. The broker comes up with the daemon's parts (the bot side and the agents) and goes with them,
// so each call reads it through a getter; until it is up, and after it stops, a call is refused, never answered by a
// second broker. The server has checked the role and the params against the method's spec before a handler runs.
//
// card.list and card.get hand out a card's sealed fields (the exact command, the paths, a sign-in link), so they are read
// for the user alone: the spec says so (`noSessions`), the server's gate and `peer.call`'s verdict refuse a session, a
// plugin or the core (here or on a paired computer), and the handlers check again.
//
// card.answer's origin is the connection's, never the answer's: its role (a sealed frame's proof counts only through the
// app) and, for a device link, the device the link authenticated. A user's own device link answers with its own key
// only: a device proof naming another device is refused there. A paired computer (a `peer` caller, which reaches this
// through `peer.call` as `remote`) may relay another device's signed answer, which holds end to end (the broker's
// `deviceProofVerifier`).
import { APPROVALS_METHODS, MOSS_ERR, ERR, type Card, type CardAnswerProof, type MossRole } from "@waifucave/moss-protocol";
import { isTheUsersOwn } from "../auth/moss-caller";
import type { AnswerOrigin, AnswerResult, ApprovalBroker } from "../contracts/approval-broker";
import { MossRpcError, type MossConn, type MossHandler } from "../ipc/moss";
import { cardMetaOf } from "../contracts/approval-broker";
import { cardAudience } from "./core-events";

/** The test-marked build's label (scripts/test-build.ts): `false` in every real build, a string only in a test one. */
declare const __MOSS_TEST_BUILD__: string | false | undefined;

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

function notRunning(): MossRpcError {
  return new MossRpcError(ERR.RETRY, "MOSS's approval broker isn't running on this computer yet: try again in a moment");
}

/** The device a device link (`remote`, `peer`) authenticated; none for a connection on this computer. */
function linkDevice(role: MossRole, caller: { kind: string; device?: string }): string | undefined {
  if (role !== "remote" && role !== "peer") return undefined;
  return caller.kind === "user" || caller.kind === "peer" ? caller.device : undefined;
}

function usersOwn(conn: MossConn, method: string): void {
  if (!isTheUsersOwn(conn.caller)) throw new MossRpcError(MOSS_ERR.NOT_THE_USER, `${method} is read for the user alone`);
}

/** What `card.answer` checks on this computer's own app connections before the broker (lane RT, spec revision 19 §3.5,
 *  §5.5): where the router placed the card (`surfaces/routing.ts`'s `cardPressGate`: the press is taken only by the
 *  program and window, or the island, drawing it), and whether computer use is acting here, read at the answer itself
 *  rather than by a round trip from the app before it (a 3 s request at the press, refused under load). */
export interface AnswerGates {
  press?(conn: MossConn, cardId: string): string | undefined;
  acting?(): boolean;
}

export function cardMethods(broker: () => CardBroker | undefined, capabilitiesOf: (pluginId: string) => readonly string[] | undefined = () => undefined, gates: AnswerGates = {}): Record<string, MossHandler> {
  const up = (): CardBroker => {
    const b = broker();
    if (!b) throw notRunning();
    return b;
  };
  return {
    [APPROVALS_METHODS.cardList.name]: async (conn): Promise<{ cards: Card[] }> => {
      usersOwn(conn, APPROVALS_METHODS.cardList.name);
      return { cards: up().cards() };
    },
    [APPROVALS_METHODS.cardGet.name]: async (conn, params) => {
      usersOwn(conn, APPROVALS_METHODS.cardGet.name);
      const { id } = params as { id: string };
      const r = up().get(id);
      if (!r) throw new MossRpcError(ERR.NOT_FOUND, `no card ${id}`);
      return {
        card: r.card,
        ...(r.outcome === undefined ? {} : { outcome: r.outcome }),
        ...(r.optionId === undefined ? {} : { option: r.optionId }),
        ...(r.device === undefined ? {} : { device: r.device }),
        ...(r.resolvedAt === undefined ? {} : { resolvedAt: r.resolvedAt }),
      };
    },
    // A layer's own list of what waits, scoped like the events it hears (`cardAudience`): the cards its plugin's own tools' calls
    // raised and its moved bot's (a plugin with `approvals.all`: all), ids and places, never a card's text. A caller that is no
    // plugin hears none.
    [APPROVALS_METHODS.cardPending.name]: async (conn) => {
      const mine = conn.caller.kind === "plugin" ? conn.caller.pluginId : undefined;
      if (mine === undefined) return { cards: [] };
      return { cards: up().cards().filter((c) => cardAudience(c)(mine, capabilitiesOf(mine) ?? [])).map(cardMetaOf) };
    },
    [APPROVALS_METHODS.cardFrame.name]: async (_conn, params) => {
      const { id } = params as { id: string };
      const channel = up().frameChannel(id);
      if (channel === undefined) throw new MossRpcError(ERR.NOT_FOUND, `no pending card ${id}`);
      return { channel };
    },
    [APPROVALS_METHODS.cardAnswer.name]: async (conn, params) => {
      const p = params as { id: string; hash: string; option: string; proof: CardAnswerProof; children?: string[] };
      const device = linkDevice(conn.role, conn.caller);
      // A test-marked build: the harness's own `cli` connection (the user's, outside any session) is marked, so the
      // broker may take its sealed-frame answer as the app's; a real build compiles this out.
      const from: AnswerOrigin = {
        role: conn.role, ...(device === undefined ? {} : { device }),
        ...(typeof __MOSS_TEST_BUILD__ === "string" && conn.role === "cli" && conn.caller.kind === "user" ? { testHarness: true as const } : {}),
      };
      // A user's own device link answers for itself: its device must be the one whose key signed. A paired computer
      // (a `peer` caller, through `peer.call`) may relay another device's signed answer, which binds that device end to end.
      if (conn.caller.kind === "user" && conn.role === "remote" && p.proof.via === "device" && p.proof.device !== device) {
        up();
        return { accepted: false, reason: REASONS["bad-origin"] };
      }
      if (conn.role === "app") {
        up();
        // A click counts only while no computer-use action runs on this computer (§5.5).
        if (gates.acting?.() === true) return { accepted: false, reason: "computer use is acting right now" };
        // No press is forwarded from one program to another: a proof names the key of the program whose connection
        // sends it (MOSS Code's may still use the device's single key, which is its own).
        if (p.proof.via === "device" && conn.program !== undefined && (p.proof.program ?? "code") !== conn.program) return { accepted: false, reason: REASONS["bad-origin"] };
        const placed = gates.press?.(conn, p.id);
        if (placed !== undefined) return { accepted: false, reason: placed };
      }
      const result = await up().answer(p.id, { optionId: p.option, hash: p.hash, proof: p.proof, ...(p.children ? { children: p.children } : {}) }, from);
      return result === "accepted" ? { accepted: true } : { accepted: false, reason: REASONS[result] };
    },
  };
}
