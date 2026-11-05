// Where the keyed fetch puts a key, and what it hands back (spec §5.4 "The keyed fetch"; lane A's review B1: with a
// placement chosen per call, an adapter could send its key in a header the service echoes and read it back).
//
// * The placement is the `auth` entry's, declared in the manifest and held by the core, never the caller's. It is one
//   of a fixed list: `authorization` with a scheme (`Bearer` when the entry names none), `x-api-key`, `api-key` or
//   `x-goog-api-key`. The waifucave token always goes as `authorization: Bearer`.
// * The core checks every `auth` entry's placement when it builds a plugin's `net.fetch` (`keyPlacementsFor`), so a
//   placement off the list refuses the fetch there, before any request (the kit's `placement-closed-list`).
// * A request that sets the placement's header itself fails `credential_header`.
// * Only silence ends a request: `idle_timeout` after five minutes with no data either way, or the request's own
//   `idleTimeoutMs`, held to 1 s - 30 min (`clampKeyedIdleTimeoutMs`), as lane A's interface v1 holds it.
// * Every response the fetch hands back, a redirect's or a 401's included, has each header whose value holds the key
//   removed (`stripEchoedKey`).
//
// The core's `net.fetch` keeps these rules, and so does lane A's reference `createKeyedFetch`; the conformance kit
// (`runKeyedFetchConformance`) checks both.

/** The idle limit a request has unless it names its own: five minutes. */
export const DEFAULT_KEYED_IDLE_TIMEOUT_MS = 300_000;
/** The shortest idle limit a request may ask for: below this, it is held to it. */
export const MIN_KEYED_IDLE_TIMEOUT_MS = 1_000;
/** The longest idle limit a request may ask for: a silent server holds a socket no longer than this. */
export const MAX_KEYED_IDLE_TIMEOUT_MS = 1_800_000;

/** A request's own `idleTimeoutMs`, held to 1 s - 30 min; anything that isn't a number (NaN included) is the default,
 *  five minutes. The same bounds as lane A's `clampKeyedIdleTimeoutMs`. */
export function clampKeyedIdleTimeoutMs(requested: unknown): number {
  if (typeof requested !== "number" || Number.isNaN(requested)) return DEFAULT_KEYED_IDLE_TIMEOUT_MS;
  return Math.min(MAX_KEYED_IDLE_TIMEOUT_MS, Math.max(MIN_KEYED_IDLE_TIMEOUT_MS, Math.round(requested)));
}

/** The headers a key may go in. */
export const KEY_HEADERS = ["authorization", "x-api-key", "api-key", "x-goog-api-key"] as const;
export type KeyHeader = (typeof KEY_HEADERS)[number];

/** An `auth` entry's `placement`: `authorization` takes a scheme, the others the bare key. */
export type KeyPlacement = { header: "authorization"; scheme?: string } | { header: Exclude<KeyHeader, "authorization"> };

/** An HTTP auth scheme: an RFC 9110 token. */
export const AUTH_SCHEME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,32}$/;

/** The default: `Authorization: Bearer <key>`. */
export const DEFAULT_KEY_PLACEMENT: KeyPlacement = { header: "authorization", scheme: "Bearer" };

/** The header and value the core sends for a key, or `null` for a placement outside the list. */
export function keyHeaderFor(placement: KeyPlacement | undefined, key: string): { header: KeyHeader; value: string } | null {
  const p = placement ?? DEFAULT_KEY_PLACEMENT;
  if (!(KEY_HEADERS as readonly string[]).includes(p.header)) return null;
  if (p.header !== "authorization") return { header: p.header, value: key };
  const scheme = p.scheme ?? "Bearer";
  return AUTH_SCHEME_RE.test(scheme) ? { header: "authorization", value: `${scheme} ${key}` } : null;
}

/** Every `auth` entry's placement, checked when the core builds a plugin's `net.fetch`: the header each entry's key
 *  goes in (by its `secret` name, or its handler's name for a `custom` entry). Throws for a placement off the list or
 *  a scheme that isn't a token, naming the entry, so the fetch is never built (never at request time). */
export function keyPlacementsFor(entries: readonly { name: string; placement?: KeyPlacement }[]): Map<string, { header: KeyHeader; scheme?: string }> {
  const out = new Map<string, { header: KeyHeader; scheme?: string }>();
  for (const e of entries) {
    const p = e.placement ?? DEFAULT_KEY_PLACEMENT;
    if (!(KEY_HEADERS as readonly string[]).includes(p.header)) throw new Error(`auth entry ${e.name}: placement ${String(p.header)} is not one of ${KEY_HEADERS.join(", ")}`);
    if (p.header !== "authorization") {
      out.set(e.name, { header: p.header });
      continue;
    }
    const scheme = p.scheme ?? "Bearer";
    if (!AUTH_SCHEME_RE.test(scheme)) throw new Error(`auth entry ${e.name}: the scheme isn't an HTTP auth scheme`);
    out.set(e.name, { header: "authorization", scheme });
  }
  return out;
}

/** A response's headers with every header whose value holds the key, as sent or %-encoded, taken out. It covers
 *  headers only: a body that echoes the key reaches the plugin as the service sent it, so an adapter must not log or
 *  return a body it didn't expect (review minor). */
export function stripEchoedKey(headers: Headers, key: string): Headers {
  const out = new Headers(headers);
  if (key.length === 0) return out;
  const forms = new Set([key, encodeURIComponent(key)]);
  const names = new Set<string>();
  headers.forEach((value, name) => {
    for (const form of forms) if (value.includes(form)) names.add(name);
  });
  for (const cookie of headers.getSetCookie?.() ?? []) {
    for (const form of forms) if (cookie.includes(form)) names.add("set-cookie");
  }
  for (const name of names) out.delete(name);
  return out;
}
