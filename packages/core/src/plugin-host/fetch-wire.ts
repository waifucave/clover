// A plugin's `net.fetch` across the plugin host (spec §5.4 "The keyed fetch"; §5.2): what its worker's request and the
// daemon's response are on the two legs (the worker's port, structured clone; the process's pipe, JSON with bytes as
// base64), where a `RequestInit` and a `Response` can't go as they are.
//
//   worker → daemon  pluginHost.fetch        (a request) the head: url, method, headers as pairs, a bounded body as
//                                            bytes or `upload: true`, the keyed options. Answers the response's head
//                                            once the daemon has it: status, statusText, headers as pairs, `body`.
//   worker → daemon  pluginHost.fetchSend    an upload's next piece (`seq`, `bytes`) or its `end`, within the credit
//                                            the daemon gave.
//   daemon → worker  pluginHost.fetchSendCredit  more upload the daemon takes (`bytes`).
//   daemon → worker  pluginHost.fetchBody    the response body's next piece (`seq`, `bytes`), its `end`, or an
//                                            `error` (the fetch's code and message): the last message of a fetch.
//   worker → daemon  pluginHost.fetchCredit  more body the worker takes (`bytes`).
//   worker → daemon  pluginHost.fetchCancel  the plugin let go (an abort, a cancelled body): the daemon aborts the
//                                            request upstream.
//
// The daemon enforces every limit (`FETCH_LIMITS`); the worker is the plugin's code and is trusted for nothing. Each
// direction of a body moves within a credit window: the reader gives credit as it takes bytes, and the sender sends
// only within it. An upload past its credit, a piece past `chunkBytes`, or one out of order cuts the fetch off.
import { ContractError } from "../contracts/common";

export const FETCH_LIMITS = {
  /** A request body given whole (a string, bytes, a form…); a bigger one goes as a stream. */
  bodyBytes: 16 * 1024 * 1024,
  /** A request's header pairs, and their names' and values' bytes together. */
  headerPairs: 256,
  headerBytes: 64 * 1024,
  /** Fetches open at once: one plugin's, and one plugin-host process's. */
  perPlugin: 32,
  perProcess: 128,
  /** One piece of a body, either way. */
  chunkBytes: 64 * 1024,
  /** The credit a reader gives at once: the bytes of a body in flight between the two ends. */
  window: 256 * 1024,
  /** A URL's length. */
  urlChars: 16 * 1024,
} as const;

export type HeaderPairs = [string, string][];

/** The worker's request head (`pluginHost.fetch`'s params, less what the host stamps). */
export interface FetchHead {
  fetchId: string;
  url: string;
  method: string;
  headers: HeaderPairs;
  /** A body given whole. */
  body?: Uint8Array;
  /** The body is a stream: its pieces follow as `pluginHost.fetchSend`. */
  upload?: boolean;
  /** The keyed fetch's own options (`auth`, `idleTimeoutMs`): data only. */
  options?: Record<string, unknown>;
}

/** The response head the daemon answers. */
export interface FetchResponseHead {
  status: number;
  statusText: string;
  headers: HeaderPairs;
  /** The response has a body, which follows as `pluginHost.fetchBody`. */
  body: boolean;
}

/** A headers value as pairs, each `set-cookie` its own. */
export function headerPairs(h: Headers): HeaderPairs {
  const out: HeaderPairs = [];
  h.forEach((value, name) => {
    if (name !== "set-cookie") out.push([name, value]);
  });
  for (const c of h.getSetCookie()) out.push(["set-cookie", c]);
  return out;
}

/** The error a fetch fails with across the link: the contract's code, and the keyed fetch's own (`host_not_declared`,
 *  `redirect_refused`, `idle_timeout`, …) in `detail.fetch`, so the worker can rebuild it. */
export function fetchFailure(err: unknown): ContractError {
  if (err instanceof ContractError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return new ContractError("failed", message, typeof code === "string" ? { fetch: code } : undefined);
}

/** The error the plugin's `net.fetch` rejects with: the keyed fetch's own failure as an Error named
 *  "KeyedFetchError" whose `code` is its code (`host_not_declared`, `redirect_refused`, `idle_timeout`, …); any other
 *  (the gate's refusal, a limit) as the contract's error, code and all, as every plugin-API call fails. */
export function fetchErrorFrom(wire: { code?: unknown; message?: unknown; detail?: unknown }): Error {
  const fetchCode = (wire.detail as { fetch?: unknown } | undefined)?.fetch;
  if (typeof fetchCode !== "string") return ContractError.fromJSON(wire);
  const err = new Error(typeof wire.message === "string" ? wire.message : "the fetch failed") as Error & { code?: string };
  err.name = "KeyedFetchError";
  err.code = fetchCode;
  return err;
}
