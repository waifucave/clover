// Turns a sender's webhook request into what is sealed for the user's computers: the method, the query less
// the routine's key, the sender's headers less credentials and Cloudflare's own, the sender's address and the body.

import { HOOK_KEY_RE } from "../../../plugins/clover/plugins/forwarder/src/wire/protocol";

/** Methods a webhook may not use: they carry no payload or are not requests a sender makes. */
export const REFUSED_METHODS = new Set(["HEAD", "OPTIONS", "CONNECT", "TRACE"]);

/** Headers never forwarded: credentials, hop-by-hop headers and what the edge adds. */
const DROPPED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "true-client-ip",
  "cdn-loop",
]);

/**
 * The routine's key, from "Authorization: Bearer <key>" or a single "?key=" parameter. An Authorization
 * header that is not a bearer key is the sender's own and is ignored here (and never forwarded).
 */
export function presentedKey(request: Request, url: URL): string | null {
  const auth = request.headers.get("authorization");
  if (auth !== null) {
    const match = /^Bearer (\S+)$/.exec(auth);
    if (match && HOOK_KEY_RE.test(match[1]!)) return match[1]!;
  }
  const fromQuery = url.searchParams.getAll("key");
  if (fromQuery.length === 1 && HOOK_KEY_RE.test(fromQuery[0]!)) return fromQuery[0]!;
  return null;
}

/** The query string without its `key` parameters, in the sender's order, without the leading "?". */
export function forwardedQuery(url: URL): string {
  if (url.search.length <= 1) return "";
  const kept = url.search
    .slice(1)
    .split("&")
    .filter((part) => part.length > 0 && decodeURIComponentSafe(part.split("=", 1)[0]!) !== "key");
  return kept.join("&");
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/** The headers to seal, or null when they exceed `maxBytes` in total. */
export function forwardedHeaders(request: Request, maxBytes: number): [string, string][] | null {
  const out: [string, string][] = [];
  let total = 0;
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (DROPPED_HEADERS.has(lower) || lower.startsWith("cf-")) continue;
    total += lower.length + value.length + 4;
    if (total > maxBytes) return null;
    out.push([lower, value]);
  }
  return out;
}
