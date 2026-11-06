// The link protocol's versions (spec §14.2 item 22: links negotiate a protocol version and support one release
// back). The dialler's `peer.hello` names its version; the acceptor answers with the one both speak.
export type { LinkPath, LinkView } from "@waifucave/clover-protocol";

const CURRENT = 1;
const OLDEST = 1;

export const PEER_PROTOCOL_VERSION_RANGE = {
  current: CURRENT,
  oldest: OLDEST,
  /** Whether a peer's version is one this side speaks. */
  accepts(v: unknown): boolean {
    return typeof v === "number" && Number.isInteger(v) && v >= OLDEST;
  },
  /** The version both sides speak: the lower of the two. */
  agree(theirs: number): number {
    return Math.min(theirs, CURRENT);
  },
} as const;
