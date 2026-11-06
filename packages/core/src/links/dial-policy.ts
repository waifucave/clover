// The dial policy (owner decision 80, edit 6's policy (c), per pair): a two-STUN check tells whether this device's
// NAT keeps one public address for every destination. When both devices' answers match (each saw the same address
// from two STUN servers), a direct path is likely: dial direct first, again 100 ms later (S1: the first packets often
// open the other side's mapping), and give the relay a 0.5 s head start's worth of wait. Otherwise race the relay
// from the start. A device on the same LAN is always tried direct first.
import type { DialPlanner, DialStep } from "./transport";
import type { DialTarget } from "./wire";

export type NatMapping = "same" | "varies" | "unknown";

/** The steps for one dial. */
export const DIRECT_FIRST: readonly DialStep[] = [
  { atMs: 0, directOnly: true },
  { atMs: 100, directOnly: true },
  { atMs: 500, directOnly: false },
];
export const RACE_RELAY: readonly DialStep[] = [
  { atMs: 0, directOnly: true },
  { atMs: 0, directOnly: false },
];

/** Whether two STUN servers' answers show an address that doesn't vary by destination. */
export function mappingOf(answers: readonly (string | undefined)[]): NatMapping {
  const seen = answers.filter((a): a is string => typeof a === "string" && a.length > 0);
  if (seen.length < 2) return "unknown";
  return seen.every((a) => a === seen[0]) ? "same" : "varies";
}

export interface DialPolicyOptions {
  /** This device's own mapping, from its latest two-STUN check (or the sidecar's `net_report`). */
  selfMapping(): NatMapping;
  /** The peer's, from its last `addr` record. */
  peerMapping(peer: string, target: DialTarget): NatMapping;
}

export class DialPolicy implements DialPlanner {
  readonly #o: DialPolicyOptions;

  constructor(opts: DialPolicyOptions) {
    this.#o = opts;
  }

  plan(peer: string, target: DialTarget): DialStep[] {
    const hasDirect = (target.lan?.length ?? 0) > 0 || (target.direct?.length ?? 0) > 0;
    if (!target.relay) return [{ atMs: 0, directOnly: true }, { atMs: 100, directOnly: true }];
    if (!hasDirect) return [{ atMs: 0, directOnly: false }];
    if ((target.lan?.length ?? 0) > 0) return [...DIRECT_FIRST];
    return this.#o.selfMapping() === "same" && this.#o.peerMapping(peer, target) === "same" ? [...DIRECT_FIRST] : [...RACE_RELAY];
  }
}
