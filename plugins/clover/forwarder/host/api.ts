// The slice of the Clover plugin API (spec §5.4) this plugin's host half uses. Lane B pins the real API in
// @waifucave/clover-plugin-sdk; until it lands, host/index.ts is written against this, and this file is the
// one place to map onto the SDK when it does. Each assumption here is listed in the I-M1 PR for lane B.

import type { CoreKeys } from "../src/keys";

export interface HostApi {
  /**
   * The core's keyed fetch. With `auth: "waifucave"` (a name reserved for bundled clover/* plugins) it adds
   * this computer's waifucave account token, scoped to the request's host, which must be a *.waifucave.com
   * host in the plugin's `network:` list; plugin code never sees the token, and the core refreshes it after
   * a 401. With no account signed in it rejects with an error whose `code` is "no_account".
   */
  net: { fetch(url: string, init?: RequestInit, options?: { auth?: string }): Promise<Response> };
  /**
   * This computer's own keys, held by the core: per computer, never synced, never handed to the plugin host.
   * publicKey(name) makes the key on first use; open(name, input) is an HPKE base-mode single-shot open with
   * DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM. Both throw while the key store is unavailable.
   */
  keys: CoreKeys;
  /** The computer this host half runs on. */
  computer?: { id: string; name: string };
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  /** Environment overrides for development profiles (CLOVER_HOOKS_ORIGIN points at a local emulator). */
  env?: Record<string, string | undefined>;
}
