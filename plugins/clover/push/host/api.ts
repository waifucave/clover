// The slice of the Clover plugin API (spec §5.4) this plugin's host half uses. Lane B pins the real API in
// @waifucave/clover-plugin-sdk; until it lands, host/index.ts is written against this, and this file is the
// one place to map onto the SDK when it does.

export interface HostApi {
  /**
   * The core's keyed fetch. With `auth: "waifucave"` (a name reserved for bundled clover/* plugins) it adds
   * this computer's waifucave account token, scoped to the request's host, which must be a *.waifucave.com
   * host in the plugin's `network:` list; plugin code never sees the token, and the core refreshes it after a
   * 401. With no account signed in it rejects with an error whose `code` is "no_account".
   */
  net: { fetch(url: string, init?: RequestInit, options?: { auth?: string }): Promise<Response> };
  /** This plugin's synced store (spec §5.4: up to 1 MB, synced across the user's devices). */
  storage?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  /** Environment overrides for development profiles (CLOVER_PUSH_ORIGIN). */
  env?: Record<string, string | undefined>;
}
