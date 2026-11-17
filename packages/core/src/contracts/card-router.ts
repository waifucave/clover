// Contract: CardRouter (spec revision 19, §3.5 "The router and presence"; G2, ruling A, R1, item 119). Owner: lane RT.
//
// The engine routes everything that needs the user (approvals, questions, "a bot needs you") to one live place per
// computer, from the presence each window program reports. Presence decides only WHERE a card is drawn, never who may
// answer: a press still needs the sealed frame's own checks (§5.5), and is taken only from the place the card is at.
//
// What the contract promises, for each pending card:
// * A focused and visible window of the product draws it: in its conversation when that window shows the card's session
//   or bot, otherwise in its own strip (a card with no session included).
// * With no window focused, the island draws it while a background host is live; with none, it is `elsewhere` (the phone
//   or the CLI answers; every device still shows it, item 91).
// * A report holds `PRESENCE_TTL_MS` (from the clock) or until its connection drops; a program's new report replaces its
//   last. Any change places every pending card again, and `watch` hears each card that moved, with where it was.
// * After an engine restart there are no reports, so cards go to the island until one arrives.
// * `mayPress` follows the placement (`pressMatchesPlacement`): the island takes a press only for a card placed there, a
//   window only for one placed in it.
import type { CardPlacement, PresenceReport, PressPlace, RoutedCard, WindowProgram } from "@waifucave/moss-protocol";
import type { Unsubscribe } from "./common";

export interface PlacementChange {
  card: string;
  place: CardPlacement;
  before?: CardPlacement;
}

export interface CardRouter {
  /** A program's report on its connection; replaces that connection's last. Answers how long it holds. */
  report(from: { connId: number; program: WindowProgram }, report: PresenceReport): { ttlMs: number };
  /** The connection closed: its report goes at once. */
  dropped(connId: number): void;
  /** Whether a background host is live on this computer (the island's surface). */
  hostLive(live: boolean): void;
  /** A card is pending: where it goes now. */
  pending(card: RoutedCard): CardPlacement;
  /** It was answered or withdrawn: it leaves every place. */
  resolved(id: string): void;
  placementOf(id: string): CardPlacement | undefined;
  list(): { card: string; place: CardPlacement }[];
  /** Whether a press from `from` may be taken for the card now. */
  mayPress(id: string, from: PressPlace): boolean;
  watch(fn: (change: PlacementChange) => void): Unsubscribe;
}
