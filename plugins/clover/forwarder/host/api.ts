// The slice of the Clover plugin API (spec §5.4) this plugin's host half uses. Lane B pins the real API in
// @waifucave/clover-plugin-sdk; until it lands, host/index.ts is written against this, and this file is the
// one place to map onto the SDK when it does.

export interface HostApi {
  /**
   * The core's keyed fetch. It adds this computer's waifucave account token (the forwarder has no sign-in of
   * its own; see the lane report: the account token door is an open item for lanes B and H) and reaches only
   * the plugin's `network:` hosts.
   */
  net: { fetch(url: string, init?: RequestInit, options?: { auth?: string }): Promise<Response> };
  /**
   * This plugin's own secrets, in the credential store. The forwarder keeps its X25519 private key here.
   * §5.4 gives `secrets.get` only to a process of the plugin's own and has no `set`: also an open item.
   */
  secrets: { get(name: string): Promise<string | undefined>; set(name: string, value: string): Promise<void> };
  /** The computer this host half runs on. */
  computer?: { id: string; name: string };
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  /** Environment overrides for development profiles (CLOVER_HOOKS_ORIGIN). */
  env?: Record<string, string | undefined>;
}
