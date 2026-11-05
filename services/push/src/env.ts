import { intVar } from "../../shared/http";
import type { ApnsConfig } from "./apns";
import type { PushDO } from "./push-do";
import type { VapidConfig } from "./webpush";

export interface Env {
  PUSH: DurableObjectNamespace<PushDO>;
  /** Notify calls per account. */
  NOTIFY_RATE: RateLimit;
  /** Target registrations per account. */
  API_RATE: RateLimit;

  ACCOUNT_ISSUER: string;
  ACCOUNT_JWKS: string;
  /** The `aud` an account token must carry for this service. */
  PUSH_AUDIENCE: string;

  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  /** The iOS app's bundle id. */
  APNS_TOPIC: string;
  APNS_PRODUCTION_ORIGIN: string;
  APNS_SANDBOX_ORIGIN: string;
  /** Secret: the APNs auth key (.p8, PKCS #8 PEM). */
  APNS_PRIVATE_KEY: string;

  VAPID_SUBJECT: string;
  VAPID_PUBLIC_KEY: string;
  /** Secret: the VAPID private scalar, base64url. */
  VAPID_PRIVATE_KEY: string;
  /** Push services a browser subscription may point at, comma-separated; "*." covers subdomains. */
  WEBPUSH_HOSTS: string;

  MAX_TARGETS?: string;
  /** How long one request to APNs or a Web Push service may take, in ms (10 s by default). */
  PUSH_TIMEOUT_MS?: string;
}

export function apnsConfig(env: Env): ApnsConfig {
  return {
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    topic: env.APNS_TOPIC,
    privateKey: env.APNS_PRIVATE_KEY,
    productionOrigin: env.APNS_PRODUCTION_ORIGIN,
    sandboxOrigin: env.APNS_SANDBOX_ORIGIN,
    timeoutMs: pushTimeoutMs(env),
  };
}

export function pushTimeoutMs(env: Env): number {
  return intVar(env.PUSH_TIMEOUT_MS, 10_000);
}

export function vapidConfig(env: Env): VapidConfig {
  return { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
}

export function maxTargets(env: Env): number {
  return intVar(env.MAX_TARGETS, 20);
}
