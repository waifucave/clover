// Contract: LinkTransport (spec §8.2 "One persistent link per device pair", §8.3, §8.4; spike S1's "What M1 starts
// with" item 2). Owner: lane H.
//
// Each pair of devices keeps one long-lived, encrypted link, and everything travels over it: RPC, live event streams,
// sync, screenshots and files. Between devices it is iroh (QUIC) through Clover's own addon; the browser uses WebRTC
// data channels. Nothing outside lane H sees iroh.
//
// What the contract promises:
// * One link per device pair: `connect` returns the link that is already there, whichever side dialled.
// * Calls fail fast: `connect` and requests answer `offline` at once when no path reaches the peer, and a request in
//   flight when the link drops fails `offline`, never hangs (§9.1 "Offline computers fail fast").
// * The link re-dials by itself after a loss and at once on the OS's network-change and wake events (S1).
// * Four priority classes, highest first: control messages, token streams, screenshots, files. Bulk data goes on
//   streams of its own, so a screenshot never holds up the small messages behind it (§8.2).
// * Payloads are structured-clone data; a handler's ContractError reaches the caller with its code.
// * A revoked device's links are cut at once (§8.1); lane H wires DeviceRegistry's revocations to the transport.
import type { LinkView } from "@waifucave/clover-protocol";
import type { Unsubscribe } from "./common";

export const LINK_PRIORITIES = ["control", "tokens", "screenshots", "files"] as const;
export type LinkPriority = (typeof LINK_PRIORITIES)[number];

export interface LinkRequestOptions {
  /** Default `control`. */
  priority?: LinkPriority;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A stream of binary frames, for bulk data (screenshots, files, a tab's video, sync batches). */
export interface LinkStream {
  readonly id: string;
  readonly label: string;
  readonly priority: LinkPriority;
  write(chunk: Uint8Array): Promise<void>;
  end(): void;
  abort(reason?: string): void;
  onData(fn: (chunk: Uint8Array) => void): Unsubscribe;
  /** Once: after `end`, or with the error that cut it (`offline`, `closed`, the peer's abort). */
  onEnd(fn: (error?: Error) => void): Unsubscribe;
}

/** The link to one peer. It stays the same object across drops and re-dials. */
export interface Link {
  readonly peer: string;
  view(): LinkView;
  request<R = unknown>(method: string, params: unknown, opts?: LinkRequestOptions): Promise<R>;
  notify(method: string, params: unknown, opts?: { priority?: LinkPriority }): void;
  openStream(label: string, priority: LinkPriority, meta?: unknown): LinkStream;
}

export interface LinkTransport {
  /** This device's id. */
  readonly self: string;
  /** The link to `peer`, dialling it if needed. */
  connect(peer: string, opts?: { signal?: AbortSignal }): Promise<Link>;
  /** Serves a method for every peer. A second handler for a method replaces the first. */
  handle(method: string, fn: (params: unknown, from: string) => unknown | Promise<unknown>): Unsubscribe;
  onNotify(method: string, fn: (params: unknown, from: string) => void): Unsubscribe;
  /** Takes the streams peers open under `label`. */
  onStream(label: string, fn: (stream: LinkStream, meta: unknown, from: string) => void): Unsubscribe;
  links(): LinkView[];
  /** A link came up, went down, or changed path. */
  watch(fn: (view: LinkView) => void): Unsubscribe;
  /** The OS reported a network change or a wake: re-dial every link at once, keeping whichever answers first (S1). */
  networkChanged(): void;
  close(): Promise<void>;
}
