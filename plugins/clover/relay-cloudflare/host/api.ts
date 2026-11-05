// The slice of the Clover plugin API (spec §5.4) this plugin's host half uses. Lane B pins the real API in
// @waifucave/clover-plugin-sdk; until it lands, host/index.ts is written against this, and this file is the one
// place to map onto the SDK when it does. Each assumption is listed in the I-M2 PR for lane B.

export interface HostApi {
  /** The core's keyed fetch: with this plugin's one `auth` entry (`relay-key`), the core adds the relay key. */
  net: { fetch(url: string, init?: RequestInit, options?: { auth?: string | false }): Promise<Response> };
  /** The plugin's own settings (`origin`). */
  settings: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    watch(key: string | null, listener: (key: string) => void): () => void;
  };
  /**
   * This device's id, as the link layer and the device registry know it: whose mailbox this device reads. Not in
   * lane B's API yet (its HandlerContext has the computer's folder-tree name, which phones and browsers lack).
   */
  device: { id: string };
}
