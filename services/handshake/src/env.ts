import type { HandshakeDO } from "./handshake-do";

export interface Env {
  HANDSHAKE: DurableObjectNamespace<HandshakeDO>;
  /** Pair and group registrations, per client address (IPv6 by /64): the hardest limit. */
  REGISTER_RATE: RateLimit;
  /** Signed and token calls, per member (or device) and scope. */
  API_RATE: RateLimit;
  /** Signed calls per client address, before membership is known: caps what a stranger with fresh keys costs. */
  ADDRESS_RATE: RateLimit;

  /** The account service: its issuer, and its keys at a URL (fetched and cached) or inline. */
  ACCOUNT_ISSUER: string;
  ACCOUNT_JWKS?: string;
  ACCOUNT_JWKS_URL?: string;
  /** The `aud` an account token must carry for this service. */
  HANDSHAKE_AUDIENCE: string;
  /** Where clients reach this service: socket URLs are built from it. */
  HANDSHAKE_ORIGIN: string;
  /** Origins whose pages may call this service from a browser, comma-separated (the web companion's). */
  WEB_ORIGINS: string;
  /** Secret: signs socket tickets. Rotating it only voids tickets not yet used (they last a minute). */
  TICKET_SECRET: string;
}
