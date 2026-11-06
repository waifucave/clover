import { intVar } from "../../shared/http";
import type { ForwarderDO } from "./forwarder-do";

export interface Env {
  FORWARDER: DurableObjectNamespace<ForwarderDO>;
  /** Webhooks per routine, counted once its key has checked out. */
  HOOK_RATE: RateLimit;
  /** Webhooks per account, a higher ceiling over all its routines. */
  TAG_RATE: RateLimit;
  /** Keys checked against the Durable Object (none cached yet), per sender address and account. */
  CHECK_RATE: RateLimit;
  /** Device API calls per account. */
  API_RATE: RateLimit;

  /** The account service's token issuer and its public signing keys (JWKS JSON). */
  ACCOUNT_ISSUER: string;
  /** The account service's keys: inline, or at a URL fetched and cached (shared/jwks.ts), which wins when set. */
  ACCOUNT_JWKS?: string;
  ACCOUNT_JWKS_URL?: string;
  /** Production: a service binding to the account service, for its JWKS (shared/jwks.ts). */
  ACCOUNT_SERVICE?: Fetcher;
  /** The `aud` an account token must carry for this service. */
  HOOKS_AUDIENCE: string;
  /** Where webhook URLs point, e.g. https://hooks.waifucave.com */
  HOOKS_ORIGIN: string;

  /**
   * Secrets (identity.ts): TAG_KEYS, numbered keys that MAC the tags in webhook URLs, JSON {"1": "<base64url>"}
   * (rotatable); ACCOUNT_ID_KEY, which names each account's Durable Object (never rotated); TICKET_SECRET, which
   * MACs connection tickets (rotatable at any time). Each key is at least 32 random bytes, unpadded base64url.
   */
  TAG_KEYS: string;
  ACCOUNT_ID_KEY: string;
  TICKET_SECRET: string;

  HOLD_DAYS?: string;
  MAX_HELD?: string;
  MAX_HELD_BYTES?: string;
  MAX_BODY_BYTES?: string;
  MAX_HEADER_BYTES?: string;
  MAX_DEVICES?: string;
  MAX_ROUTINES?: string;
  WINDOW_FRAMES?: string;
  WINDOW_BYTES?: string;
}

export interface Limits {
  /** How long a payload is held for a computer that is away (spec §7: at most 7 days). */
  holdMs: number;
  /** Per account: held payloads and their bytes; past either, the oldest are dropped first. */
  maxHeld: number;
  maxHeldBytes: number;
  /** One webhook's body, and its forwarded headers. */
  maxBodyBytes: number;
  maxHeaderBytes: number;
  maxDevices: number;
  maxRoutines: number;
  /** Unacknowledged frames and bytes in flight on one connection. */
  windowFrames: number;
  windowBytes: number;
  /** Expiry runs at most once per gap; a payload is dropped up to one gap before holdMs, never after. */
  expiryGapMs: number;
  ticketTtlMs: number;
  /** A connection that has sent no keep-alive for this long is treated as gone. */
  staleMs: number;
}

const DAY = 24 * 3600 * 1000;

export function limitsFrom(env: Env): Limits {
  return {
    holdMs: intVar(env.HOLD_DAYS, 7) * DAY,
    maxHeld: intVar(env.MAX_HELD, 1000),
    maxHeldBytes: intVar(env.MAX_HELD_BYTES, 50_000_000),
    maxBodyBytes: intVar(env.MAX_BODY_BYTES, 1024 * 1024),
    maxHeaderBytes: intVar(env.MAX_HEADER_BYTES, 16 * 1024),
    maxDevices: Math.min(intVar(env.MAX_DEVICES, 32), 32),
    maxRoutines: intVar(env.MAX_ROUTINES, 1000),
    windowFrames: intVar(env.WINDOW_FRAMES, 32),
    windowBytes: intVar(env.WINDOW_BYTES, 4 * 1024 * 1024),
    expiryGapMs: 3600 * 1000,
    ticketTtlMs: 60 * 1000,
    staleMs: 90 * 1000,
  };
}
