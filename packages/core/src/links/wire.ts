// The wire under the LinkTransport: authenticated connections between device keys, each carrying independent,
// prioritised byte streams. Two implementations: iroh (QUIC) through Clover's link sidecar (`sidecar-wire.ts`, spike
// S1's decision), and an in-memory network for tests and several daemons in one process (`memory-wire.ts`). Nothing
// above this file sees iroh.
//
// What every wire promises:
// * A connection's `peerKey` is the peer's authenticated Ed25519 public key (iroh's endpoint id); a dial reaches the
//   key it names or fails.
// * Streams are independent: a stream's bytes arrive in order, and one stream never holds up another. Higher
//   `priority` is sent first when both have bytes waiting.
// * A lost connection ends every one of its streams with `RESET_CONN_LOST`, and resolves `closed`.
import type { Unsubscribe } from "../contracts/common";
import type { Bytes } from "../identity/bytes";

/** The link's own protocol; a different one carries pairing, which accepts devices that aren't paired yet. */
export const ALPN_LINK = "clover/link/1";
export const ALPN_PAIR = "clover/pair/1";

/** The wire priority of each LinkTransport class, highest first (§8.2). */
export const WIRE_PRIORITY = { control: 3, tokens: 2, screenshots: 1, files: 0 } as const;

/** Stream reset codes. */
export const RESET_ABORTED = 1;
export const RESET_NOT_FOUND = 2;
export const RESET_CONN_LOST = 3;
export const RESET_REFUSED = 4;

/** Connection close codes. */
export const CLOSE_NORMAL = 0;
export const CLOSE_SUPERSEDED = 1;
export const CLOSE_UNPAIRED = 2;
export const CLOSE_REVOKED = 3;
export const CLOSE_PROTOCOL = 4;
export const CLOSE_LOST = 5;
export const CLOSE_SHUTDOWN = 6;

export type PathKind = "lan" | "direct" | "relay";

export interface PathInfo {
  kind: PathKind;
  rttMs?: number;
  /** The relay carrying it, when `kind` is `relay`: its URL on the wire, the relay plugin's id above it. */
  relay?: string;
}

export interface WireStream {
  readonly priority: number;
  /** Resolves once the wire has taken the bytes; rejects after a reset or a lost connection. */
  write(chunk: Uint8Array): Promise<void>;
  /** Ends this side; the peer's `onFin` fires after the bytes already written. */
  finish(): void;
  /** Ends both directions at once. */
  reset(code: number): void;
  /** Bytes from the peer; chunks that arrive before the first listener are kept for it. A listener may return a
   *  promise: the sidecar's wire then holds the next chunk, and the peer, until it settles (backpressure, S6.2 of H-M1's
   *  review); the in-memory wire doesn't wait. */
  onData(fn: (chunk: Uint8Array) => void | Promise<void>): Unsubscribe;
  /** The peer finished its side. */
  onFin(fn: () => void): Unsubscribe;
  /** The peer reset the stream, or the connection was lost (`RESET_CONN_LOST`). */
  onReset(fn: (code: number) => void): Unsubscribe;
}

export interface WireClose {
  code: number;
  reason: string;
  /** This side closed it. */
  local: boolean;
}

export interface WireConn {
  readonly id: string;
  /** The peer's authenticated public key. */
  readonly peerKey: Bytes;
  readonly alpn: string;
  /** This side dialled. */
  readonly outbound: boolean;
  path(): PathInfo;
  onPath(fn: (path: PathInfo) => void): Unsubscribe;
  openStream(priority: number): WireStream;
  onStream(fn: (stream: WireStream) => void): Unsubscribe;
  close(code: number, reason: string): void;
  readonly closed: Promise<WireClose>;
}

/** Where a peer may be reached: its key, and the candidates the handshake, the LAN or the last link gave. */
export interface DialTarget {
  key: Bytes;
  /** `ip:port` candidates on the same LAN. */
  lan?: readonly string[];
  /** `ip:port` candidates across the internet (STUN's answers, port mappings). */
  direct?: readonly string[];
  /** The peer's home relay's URL; a dial that names it may go through the relay. */
  relay?: string;
}

export interface DialOptions {
  alpn: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Leave the relay out even when the target names one (the dial policy's direct-first leg). */
  directOnly?: boolean;
}

export interface WireEndpoint {
  readonly publicKey: Bytes;
  dial(target: DialTarget, opts: DialOptions): Promise<WireConn>;
  /** Takes incoming connections for one ALPN; a connection no one takes is closed. */
  onIncoming(alpn: string, fn: (conn: WireConn) => void): Unsubscribe;
  /** The OS reported a network change or a wake. */
  networkChanged(): void;
  close(): Promise<void>;
}

/** A connection or dial that failed because no path reached the peer. */
export class WireOffline extends Error {
  constructor(message = "the peer can't be reached") {
    super(message);
    this.name = "WireOffline";
  }
}
