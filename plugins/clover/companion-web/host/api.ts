// The slice of the Clover plugin API (spec §5.4) this plugin's host half uses. Lane B pins the real API in
// @waifucave/clover-plugin-sdk; until it lands, host/index.ts is written against this, and this file is the one
// place to map onto the SDK when it does. What lane B's API doesn't have yet is marked; each is in the I-M2 PR.

import type { AdoptLink, ConfirmPairing, DeviceRegistryLike, PairStore } from "../src/contracts";

export interface HostApi {
  /** The plugin's own settings: `handshakeOrigin` and `webOrigin` for development profiles. */
  settings: { get<T = unknown>(key: string): Promise<T | undefined> };
  /** The computer this host half runs on. */
  computer: { name: string };
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  /** Not in lane B's API: the device registry (lane H). */
  devices: DeviceRegistryLike;
  /** Not in lane B's API: the sealed card that shows a browser's four words (lane H's pairing flow). */
  confirmPairing: ConfirmPairing;
  /** Not in lane B's API: where a browser's link goes (lane H's LinkTransport). */
  adoptLink: AdoptLink;
  /** Not in lane B's API: the core's secret store for this plugin's browser pairs. */
  pairs: PairStore;
}
