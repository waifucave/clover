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
// * `canAct` never reads shared or wall time (review S11). The holder's deadline is the moment it sent its last
//   successful acquire or renew, on a monotonic clock that counts sleep (CLOCK_BOOTTIME, mach_continuous_time,
//   QueryUnbiasedInterruptTime's sleep-counting twin), plus the TTL, minus the margin: the lease can't have run longer
//   on the handshake's side than on this device's. A main that can't renew stops starting turns, tool calls and memory
//   writes before its lease ends. After the OS reports a wake (`wake`), `canAct` is false until a renew succeeds, so a
//   main that slept past its lease never acts on it. With that, 30 s and a 5 s margin are sound. Lane H adds the spec's
//   exceptions (no other computer could take over; a live link to each one that could) in the real implementation.
// * `release` (Hand over and quit, §3.1) lets another computer take the lease at once.
// * The fencing token (H-M2's review, check 2) is the lease's scope, epoch and holder (`fencingTokenOf`). Every act a
//   computer asks of another (`peer.call`, a tree call, a level change) carries the sender's as `fence`. The receiver
//   judges it against its own lease, filled only from its own lease events (`FenceGuard`): it takes only its own
//   lease's scope and epoch and holder, so an older epoch, one ahead of its records (until they catch up) and the same
//   epoch from another holder (a split takeover) are refused, and once it has seen a token for its scope an act without
//   one is. So a main that lost its lease without knowing, asleep or cut off,
//   can't act through the others.
// * Without an account the user's account-less devices form one group (item 85): their lease is the group's record at
//   the handshake, which members admit one another to when they pair, so a takeover works as with an account. Only a
//   computer that can reach neither the handshake nor the last holder over any link leaves taking over to the user
//   (§6.4, `{ byUser: true }`).
import { fenceVerdict, type FenceVerdict, type FenceView, type FencingToken, type LeaseView } from "@waifucave/clover-protocol";
import type { Unsubscribe } from "./common";

export type LeaseState = LeaseView;

/** The token a lease's holder puts on its acts between computers; none without a scope or a holder. */
export function fencingTokenOf(state: LeaseState): FencingToken | undefined {
  return state.scope !== undefined && state.holder !== null ? { scope: state.scope, epoch: state.epoch, holder: state.holder } : undefined;
}

/** A receiver's check of the tokens on acts asked of it (check 2): its own lease's view, from its own lease events
 *  (`observe`). An act without a token is refused once it has seen a token for its scope, and outright whenever its own
 *  lease has a scope and a holder (the controller's ruling on #237): every sender in a group with a lease sends one, so
 *  a receiver that restarted, and so has seen none yet, still refuses a tokenless act. */
export class FenceGuard {
  #own: FenceView | undefined;
  #seen = false;

  /** This computer's own lease changed (its `watch`). */
  observe(state: LeaseState): void {
    // Out of its group (no scope): no view, so nothing it knew of the old group's lease still passes (#237's ruling).
    if (state.scope === undefined) {
      this.#own = undefined;
      this.#seen = false;
      return;
    }
    if (this.#own?.scope !== state.scope) this.#seen = false;
    const own = this.#own?.scope === state.scope && this.#own.epoch > state.epoch ? this.#own : { scope: state.scope, epoch: state.epoch, holder: state.holder };
    this.#own = own;
  }

  /** Judges an act's token. Its view moves only from `observe`, never from a token (#187's check 2). */
  check(token: FencingToken | undefined): FenceVerdict {
    const held = this.#own !== undefined && this.#own.holder !== null;
    const v = fenceVerdict(this.#own, token, this.#seen || held);
    if (v === "ok" && token !== undefined) this.#seen = true;
    return v;
  }
}

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
  /** The OS reported a wake from sleep: `canAct` stays false until the next successful renew. */
  wake(): void;
  watch(fn: (state: LeaseState) => void): Unsubscribe;
}
