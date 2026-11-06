import type { AccountDO } from "./account-do";
import type { KeysDO } from "./keys";

export interface Env {
  /** One object per account: its devices. */
  ACCOUNTS: DurableObjectNamespace<AccountDO>;
  /** The local profile's signing keys, in memory (keys.ts). */
  KEYS: DurableObjectNamespace<KeysDO>;
  /** Per client address, before the sign-in is checked: each check is a call to the Supabase project. */
  ADDRESS_RATE: RateLimit;
  /** Per account. */
  API_RATE: RateLimit;

  /** The `iss` of the tokens minted here: this service's public URL, its path prefix included. */
  ISSUER: string;
  /** Where this Worker's paths start: "" on a host of its own, "/auth" under https://waifucave.com/auth. */
  PATH_PREFIX?: string;
  /** Waifucave's Supabase project, whose sessions are the sign-in, and its public (anon) key. */
  AUTH_URL: string;
  AUTH_ANON_KEY: string;
  /** The audiences tokens may be minted for, comma-separated: the hooks forwarder, push and the handshake. */
  AUDIENCES: string;
  /** Seconds a token lives, at most 300 (the default). */
  TOKEN_TTL?: string;

  /** Secret: {"keys":[private JWK with kid, ...]}; the first signs, every key is published. */
  SIGNING_JWKS?: string;
  /** The local profile only: "1" makes signing keys in memory when SIGNING_JWKS is unset. */
  EPHEMERAL_KEYS?: string;
  /** The local profile only: "1" opens POST /dev/token, a mint without a sign-in, for emulator tests. */
  DEV_MINT?: string;
}
