// Where the keyed fetch puts a key, and what it hands back (spec §5.4 "The keyed fetch"; lane A's review B1: with a
// placement chosen per call, an adapter could send its key in a header the service echoes and read it back).
//
// * The placement is the `auth` entry's, declared in the manifest and held by the core, never the caller's. It is one
//   of a fixed list: `authorization` with a scheme (`Bearer` when the entry names none), `x-api-key`, `api-key` or
//   `x-goog-api-key`. The waifucave token always goes as `authorization: Bearer`.
// * A request that sets the placement's header itself fails `credential_header`.
// * Every response the fetch hands back, a redirect's or a 401's included, has each header whose value holds the key
//   removed (`stripEchoedKey`).
//
// The core's `net.fetch` keeps these rules, and so does lane A's reference `createKeyedFetch`; the conformance kit
// (`runKeyedFetchConformance`) checks both.

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

/** A response's headers with every header whose value holds the key, as sent or %-encoded, taken out. */
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
