// What this plugin's host half uses of the plugin API (spec §5.4): lane B's PluginApi, plus the one thing it lacks.

import type { PluginApi } from "@waifucave/clover-plugin-sdk";

export type HostApi = Pick<PluginApi, "net" | "settings"> & {
  /**
   * This device's id, as the link layer and the device registry know it: whose mailbox this device reads. Not in
   * lane B's API yet (`PluginSelf.computer` is the folder-tree name, which phones and browsers lack); listed in the
   * I-M2 PR for lane B.
   */
  device: { id: string };
};
