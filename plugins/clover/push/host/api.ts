// The slice of the Clover plugin API (spec §5.4) this plugin's host half uses. Lane B pins the real API in
// @waifucave/clover-plugin-sdk; until it lands, host/index.ts is written against this, and this file is the
// one place to map onto the SDK when it does.

export interface HostApi {
  /**
   * The core's keyed fetch. It adds this computer's waifucave account token (the notifier has no sign-in of
   * its own; the account token door is an open item for lanes B and H) and reaches only `network:` hosts.
   */
  net: { fetch(url: string, init?: RequestInit, options?: { auth?: string }): Promise<Response> };
  /** This plugin's synced store (spec §5.4: up to 1 MB, synced across the user's devices). */
  storage?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  /** Environment overrides for development profiles (CLOVER_PUSH_ORIGIN). */
  env?: Record<string, string | undefined>;
}
