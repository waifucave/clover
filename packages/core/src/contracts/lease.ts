// Contract: Lease (spec §6.4 "The main holds a lease", "Fencing the old main", "While the main is offline", "When the
// main returns"; §8.5 "the refresher"). Owner: lane H.
//
// The main computer renews a short lease through the waifucave handshake (metadata only). Another computer takes over
// only after the lease lapses, and only a computer running clover-core can. Events carry the lease epoch, which rises
// with each new holder, so late events from an earlier lease are recognized (§8.5 "Transcripts"). The holder is also
// the refresher, the one device that refreshes rotating logins.
//
// What the contract promises:
// * `acquire` succeeds only when no other holder's lease runs: never while it is live, whoever asks.
// * `canAct` is false from `expiresAt - margin` on, so a main that can't renew stops starting turns, tool calls and
//   memory writes before its lease ends, with a margin for clock error. Lane H adds the spec's exceptions (no other
//   computer could take over; a live link to each one that could) in the real implementation.
// * `release` (Hand over and quit, §3.1) lets another computer take the lease at once.
// * Without an account there is no handshake, so taking over is the user's action (§6.4); lane H's real lease then
//   refuses `acquire` without `{ byUser: true }`.
import type { LeaseView } from "@waifucave/clover-protocol";
import type { Unsubscribe } from "./common";

export type LeaseState = LeaseView;

export interface Lease {
  /** This device's id. */
  readonly self: string;
  state(): LeaseState;
  /** Whether this device may start turns, tool calls and memory writes now. */
  canAct(): boolean;
  /** Takes the lease after it lapsed or was released; rejects with `not_main` while another holder's lease runs, or
   *  `offline` when the handshake can't be reached. */
  acquire(opts?: { byUser?: boolean }): Promise<LeaseState>;
  /** Extends this device's lease; rejects with `not_main` if it lapsed or another device holds it. */
  renew(): Promise<LeaseState>;
  /** Gives the lease up at once. */
  release(): Promise<void>;
  watch(fn: (state: LeaseState) => void): Unsubscribe;
}
