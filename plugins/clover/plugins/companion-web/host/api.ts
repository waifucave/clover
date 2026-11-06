// What this plugin's host half uses of the plugin API (spec §5.4): lane B's PluginApi, plus what it lacks for a
// browser's pairing and link. Each addition is listed in the I-M2 PR for lanes B and H.

import type { PluginApi } from "@waifucave/clover-plugin-sdk";

import type { AdoptLink, DeviceRegistryLike, PairStore } from "../src/contracts";

export type HostApi = Pick<PluginApi, "plugin" | "settings" | "confirm"> & {
  /** Not in lane B's API: the device registry itself (lane H), to add a paired browser and hear of revocations. */
  registry: DeviceRegistryLike;
  /** Not in lane B's API: where a browser's link goes (lane H's LinkTransport). */
  adoptLink: AdoptLink;
  /** Not in lane B's API: the core's secret store for this plugin's browser pairs. */
  pairs: PairStore;
};
