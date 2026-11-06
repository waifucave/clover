// Where a service finds the account service's public keys: a JWKS at a URL (ACCOUNT_JWKS_URL), fetched and cached
// per Worker instance, or inline (ACCOUNT_JWKS) for tests and emulators. The URL wins when both are set.
//
// A fetched set is used for 10 minutes, then fetched again; if that fails, the old set keeps working for up to a day,
// so a short outage of the account service never signs anyone out. A token whose `kid` the set doesn't have makes one
// early fetch, at most once a minute, so a key the account service has just added works within seconds.

import { type AccountIdentity, verifyAccountToken } from "./account-token";
import { fromB64u } from "./encoding";
import { fetchableUrl } from "./web";

export interface JwksEnv {
  ACCOUNT_JWKS?: string;
  ACCOUNT_JWKS_URL?: string;
  ACCOUNT_ISSUER: string;
}

const FRESH_MS = 10 * 60_000;
const STALE_MAX_MS = 24 * 3600_000;
const REFETCH_MIN_MS = 60_000;
/** After a failed or stale fetch, the next try waits this long, so an outage isn't met with a fetch per request. */
const RETRY_MS = 10_000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_JWKS_BYTES = 64 * 1024;

interface Cached {
  text: string;
  kids: Set<string>;
  fetchedAt: number;
}

const cache = new Map<string, Cached>();
const lastAttempt = new Map<string, number>();
const inflight = new Map<string, Promise<Cached | null>>();

function kidsOf(text: string): Set<string> {
  const kids = new Set<string>();
  try {
    const parsed = JSON.parse(text) as { keys?: { kid?: unknown }[] };
    for (const key of parsed.keys ?? []) if (typeof key.kid === "string") kids.add(key.kid);
  } catch {
    // An unreadable set has no keys.
  }
  return kids;
}

/** Whether a JWKS URL is one a service may fetch: https, or plain http to this machine for the local emulators. */
export function allowedJwksUrl(raw: string): boolean {
  return fetchableUrl(raw);
}

async function fetchJwks(url: string, fetcher: typeof fetch, now: number): Promise<Cached | null> {
  lastAttempt.set(url, now);
  const running = inflight.get(url);
  if (running) return running;
  const attempt = (async (): Promise<Cached | null> => {
    try {
      const response = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const text = await response.text();
      if (text.length > MAX_JWKS_BYTES) return null;
      const kids = kidsOf(text);
      if (kids.size === 0) return null;
      const entry = { text, kids, fetchedAt: now };
      cache.set(url, entry);
      return entry;
    } catch {
      return null;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, attempt);
  return attempt;
}

/** The kid in a token's header, or null. */
function kidOf(token: string): string | null {
  const header = token.split(".", 1)[0] ?? "";
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromB64u(header))) as { kid?: unknown };
    return typeof parsed.kid === "string" ? parsed.kid : null;
  } catch {
    return null;
  }
}

/** The JWKS to check a token against now, or null when none can be had. */
async function currentJwks(env: JwksEnv, kid: string | null, fetcher: typeof fetch, now: number): Promise<string | null> {
  const url = env.ACCOUNT_JWKS_URL;
  if (!url) return env.ACCOUNT_JWKS ?? null;
  if (!allowedJwksUrl(url)) return null;
  let entry = cache.get(url);
  const sinceAttempt = now - (lastAttempt.get(url) ?? 0);
  let due: boolean;
  if (!entry) due = sinceAttempt >= RETRY_MS;
  else if (now - entry.fetchedAt >= FRESH_MS) due = sinceAttempt >= RETRY_MS;
  else due = kid !== null && !entry.kids.has(kid) && sinceAttempt >= REFETCH_MIN_MS;
  if (due) entry = (await fetchJwks(url, fetcher, now)) ?? cache.get(url);
  if (!entry || now - entry.fetchedAt >= STALE_MAX_MS) return null;
  return entry.text;
}

/**
 * Verifies an account token against the service's configured keys (see the top of this file). Returns the identity,
 * or null for any token that isn't valid for this service.
 */
export async function verifyAccountTokenFrom(
  token: string,
  env: JwksEnv,
  audience: string,
  fetcher: typeof fetch = fetch,
): Promise<AccountIdentity | null> {
  const jwks = await currentJwks(env, kidOf(token), fetcher, Date.now());
  if (jwks === null) return null;
  try {
    return await verifyAccountToken(token, { jwks, issuer: env.ACCOUNT_ISSUER, audience });
  } catch {
    return null;
  }
}

/** For tests: forget every fetched set. */
export function clearJwksCache(): void {
  cache.clear();
  lastAttempt.clear();
  inflight.clear();
}
