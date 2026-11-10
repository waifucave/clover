// Contract: ComputerRegistry (spec §5.4 `computers.read` and `computers.control`, §5.5 "A click counts only while …",
// §9.1 computers and levels, §9.2 cloud computers and "Sharing rules"). Owner: lane J.
//
// A computer is any device running clover-core that the user connected. The registry keeps each one's name, OS,
// display, installed ACP agents and approval level, and, for computer use, its holds, the user-working mark, whether
// an action is running, and where Clover's own windows are. Holds and the mark are the core's; plugins with
// `computers.control` take and release them through the plugin API.
//
// What it promises:
// * Names are unique, letters, digits and hyphens; a renamed computer keeps its old name as an alias (§9.1).
// * A computer's level changes only through this registry. Raising it takes proof (`LevelRaiseProof`, review S10): the
//   approved card that binds `computer.setLevel` for exactly this computer and level, from this computer's own broker
//   (looked up there by id, `cardRecord`: the record a caller hands over only names it, and without the lookup no card
//   raises; `cardRaiseProblem`), or a paired device's signed answer when the raise comes from elsewhere (§8.5: levels
//   stay on each computer, and a raise travels only with its signed answer), or the IPC layer's word that the user's own
//   terminal asked. A card id counts once, across restarts too (the node keeps the ledger on disk). Lowering needs
//   none (§5.5, §9.1).
// * Holds (the inherited computer-use code's held apps): an app hold and a window hold of that app conflict across
//   sessions, as do two holds of one window; a session taking what it already holds gets its hold back. A hold is
//   refused `held` (naming the holder), `user_working` while the user's mark is on that app, or `computer_offline`.
//   Every session lets go at its turn end (`releaseSession`).
// * The user-working mark lifts only on the user's message or a card answer, never on a release (as computer-use
//   helper 1.22.0 does).
// * While an action runs on a computer, a click on a sealed card there doesn't count (§5.5).
import { callBindingInput, cardHashInput, UNATTENDED_CARD_TIMEOUT_MS, type CloverWindow, type ComputerView, type HoldTarget, type HoldView, type Level, type SignedCardAnswer } from "@waifucave/clover-protocol";
import type { AnswerLedger, CardRecord } from "./approval-broker";
import type { Unsubscribe } from "./common";

/** What a raise takes: this computer's approved card record, a paired device's signed answer, or the user's own
 *  terminal, which only the IPC layer may claim, after its caller check (§3.1), and never for a peer. */
export type LevelRaiseProof = { via: "card"; record: CardRecord } | { via: "signed"; answer: SignedCardAnswer } | { via: "terminal" };

/** How long after the person's answer a card still raises a level: the unattended card timeout (10 minutes). A raise
 *  is asked for and done at once, so an older approval (a card answered and kept for later) never counts. */
export const CARD_PROOF_MAX_AGE_MS = UNATTENDED_CARD_TIMEOUT_MS;

/** Why a `{ via: "card" }` raise isn't proof, or null when it is (#342's review; C's call-binding review):
 *  * there is a broker to ask (`cardRecord`): without one, no card raises, whatever is handed over;
 *  * the broker's own record for the handed record's id is used from here on; the handed one only names it, and must
 *    carry the same hash;
 *  * its hash checks; it was approved with an approve option;
 *  * it was answered (`resolvedAt`) no longer than `CARD_PROOF_MAX_AGE_MS` ago and not before `since` (the registry's
 *    start);
 *  * it binds `computer.setLevel` for exactly this computer and level under `computer-level`, with no `source`
 *    (defense in depth: the broker refuses a source on any call but `tree.transfer`);
 *  * then the ledger takes its id, once (on disk in the node, so a restart doesn't make it count again). */
export function cardRaiseProblem(
  handed: CardRecord,
  c: { name: string; level: Level; cardRecord: ((id: string) => CardRecord | undefined) | undefined; now: number; since: number; sha256(text: string): string; ledger: AnswerLedger },
): string | null {
  if (!c.cardRecord) return "no approval broker here to check a card";
  const own = c.cardRecord(handed.card.id);
  if (!own) return "this computer's approval broker holds no such card";
  const { card, outcome, optionId, resolvedAt } = own;
  if (card.id !== handed.card.id || c.sha256(cardHashInput(card)) !== card.hash || card.hash !== handed.card.hash) return "the card isn't the one this computer's approval broker holds";
  if (outcome !== "approved" || card.options.find((o) => o.id === optionId)?.kind !== "approve") return "the card wasn't approved";
  if (resolvedAt === undefined || resolvedAt < c.since || resolvedAt > c.now || c.now - resolvedAt > CARD_PROOF_MAX_AGE_MS) return "the card's answer is too old";
  const { method, params } = levelRaiseCall(c.name, c.level);
  const b = card.binds;
  if (card.change !== "computer-level" || !b || b.source !== undefined || b.computer !== c.name || b.method !== method || b.params !== c.sha256(callBindingInput(method, params))) {
    return "the card is for another change";
  }
  return c.ledger.claim(card.id) ? null : "the card was used already";
}

/** The method and params a raise's card binds. */
export function levelRaiseCall(name: string, level: Level): { method: "computer.setLevel"; params: { name: string; level: Level } } {
  return { method: "computer.setLevel", params: { name, level } };
}

export type ComputerChange =
  | { type: "computer"; computer: ComputerView }
  | { type: "removed"; name: string }
  | { type: "holds"; computer: string; holds: HoldView[] }
  | { type: "user-working"; computer: string; apps: string[] }
  | { type: "action-running"; computer: string; running: boolean };

export interface HoldRequest {
  computer: string;
  target: HoldTarget;
  /** The session acting. */
  session?: string;
  /** The plugin taking the hold for it. */
  pluginId: string;
}

export interface ComputerRegistry {
  /** This computer. */
  self(): ComputerView;
  list(): ComputerView[];
  /** By name or by an old name. */
  get(nameOrAlias: string): ComputerView | undefined;
  /** Raising takes proof; lowering doesn't. Rejects `refused` for a raise without valid proof, or with a card already
   *  used. */
  setLevel(name: string, level: Level, proof?: LevelRaiseProof): Promise<void>;
  /** Rejects `conflict` when the name is taken, `invalid` when it isn't letters, digits and hyphens. */
  rename(name: string, newName: string): Promise<void>;

  holds(computer?: string): HoldView[];
  takeHold(req: HoldRequest): HoldView;
  releaseHold(id: string): void;
  /** At a session's turn end, it lets go of everything it holds. How many holds that was. */
  releaseSession(session: string): number;
  /** A computer-use plugin saw the user working in an app (their typing or click, never the helper's own input). */
  markUserWorking(computer: string, app: string): void;
  /** The user's message, or their answer to a card or question, lifts the mark on every app of that computer. */
  liftUserWorking(computer: string): void;
  userWorking(computer: string): string[];
  setActionRunning(computer: string, running: boolean): void;
  isActionRunning(computer: string): boolean;
  /** The app reports where Clover's windows are; a computer-use plugin must not act on them (§5.5). */
  setCloverWindows(computer: string, windows: CloverWindow[]): void;
  cloverWindows(computer: string): CloverWindow[];
  watch(fn: (change: ComputerChange) => void): Unsubscribe;
}

/** Whether two hold targets overlap: the same app, unless they are two different windows of it. */
export function holdsOverlap(a: HoldTarget, b: HoldTarget): boolean {
  if (a.app !== b.app) return false;
  if (a.kind === "window" && b.kind === "window") return a.window === b.window;
  return true;
}
