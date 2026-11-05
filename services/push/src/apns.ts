// APNs with token-based authentication: a provider token (an ES256 JWT signed with the team's APNs key) and
// one POST per device token to /3/device/<token>.
//
// What goes to Apple is content-free (spec §10): a count and a fixed, localizable "you have N updates"; the
// app's notification service extension then connects to the user's own computer to fetch what happened.

import { importPkcs8, signJwt } from "./es256";

export interface ApnsConfig {
  /** The APNs key's 10-character Key ID, and the 10-character Team ID. */
  keyId: string;
  teamId: string;
  /** The iOS app's bundle id. */
  topic: string;
  /** The .p8 key (PKCS #8 PEM): a secret. */
  privateKey: string;
  productionOrigin: string;
  sandboxOrigin: string;
  /** How long one request may take; PUSH_TIMEOUT_MS when absent. */
  timeoutMs?: number;
}

export interface ApnsTarget {
  token: string;
  env: "production" | "sandbox";
}

/**
 * gone: the push service says the target no longer exists (APNs 410 Unregistered, Web Push 404/410): forget it.
 * suspect: APNs calls the token bad or not for this app, which a wrong topic or a sandbox/production mix-up
 * at our end also causes: forget the target only after several in a row.
 */
export type SendOutcome = { ok: true } | { ok: false; gone: boolean; suspect?: boolean; status: number; reason: string };

/** How long one request to a push service may take. */
export const PUSH_TIMEOUT_MS = 10_000;

// APNs wants a provider token refreshed at most every 20 minutes and at least every 60. Every Worker instance
// rounds iat down to the same 40-minute boundary, so the instances mint tokens with one iat between them.
const TOKEN_PERIOD_S = 40 * 60;
const SUSPECT = new Set(["BadDeviceToken", "DeviceTokenNotForTopic"]);

let cached: { cacheKey: string; token: string; iat: number } | null = null;
const keys = new Map<string, Promise<CryptoKey>>();

async function providerToken(config: ApnsConfig, now: number, fresh: boolean): Promise<string> {
  const cacheKey = `${config.teamId}/${config.keyId}`;
  const nowS = Math.floor(now / 1000);
  // After ExpiredProviderToken, mint one stamped now rather than at the boundary.
  const iat = fresh ? nowS : nowS - (nowS % TOKEN_PERIOD_S);
  if (!fresh && cached && cached.cacheKey === cacheKey && cached.iat === iat) return cached.token;
  let key = keys.get(config.privateKey);
  if (!key) {
    key = importPkcs8(config.privateKey);
    keys.set(config.privateKey, key);
  }
  const token = await signJwt({ alg: "ES256", kid: config.keyId }, { iss: config.teamId, iat }, await key);
  if (!fresh) cached = { cacheKey, token, iat };
  return token;
}

/** The notification body: a count, never content. A count of 0 only clears the badge. */
export function apnsPayload(badge: number): Record<string, unknown> {
  if (badge === 0) return { aps: { badge: 0 } };
  return {
    aps: {
      alert: { "loc-key": "CLOVER_UPDATES", "loc-args": [String(badge)] },
      badge,
      sound: "default",
      "mutable-content": 1,
      "thread-id": "clover",
    },
  };
}

export const APNS_TOKEN_RE = /^(?:[0-9a-f]{2}){32,100}$/;

export async function sendApns(config: ApnsConfig, target: ApnsTarget, badge: number, now: number): Promise<SendOutcome> {
  const origin = target.env === "sandbox" ? config.sandboxOrigin : config.productionOrigin;
  const body = JSON.stringify(apnsPayload(badge));
  let outcome: SendOutcome = { ok: false, gone: false, status: 0, reason: "not sent" };
  for (const fresh of [false, true]) {
    const response = await fetch(`${origin}/3/device/${target.token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${await providerToken(config, now, fresh)}`,
        "apns-topic": config.topic,
        "apns-push-type": "alert",
        "apns-priority": badge === 0 ? "5" : "10",
        "apns-expiration": String(Math.floor(now / 1000) + 24 * 3600),
        "apns-collapse-id": "clover-updates",
        "content-type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(config.timeoutMs ?? PUSH_TIMEOUT_MS),
    });
    if (response.status === 200) return { ok: true };
    const reason = ((await response.json().catch(() => ({}))) as { reason?: string }).reason ?? `http ${response.status}`;
    outcome = { ok: false, gone: response.status === 410, suspect: SUSPECT.has(reason), status: response.status, reason };
    // An expired provider token is retried once with a fresh one; nothing else is retried here.
    if (!(response.status === 403 && reason === "ExpiredProviderToken")) break;
  }
  return outcome;
}
