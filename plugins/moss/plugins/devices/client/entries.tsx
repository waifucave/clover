// The Devices tab of the island: an `island.tab` entry of its own plugin. The island declares the slot and draws its tab
// dots; this plugin reads `devices.read` and draws the rows in the island's row language (its own copy, ./ui).
import { useOpen, usePluginApi, useT } from "@waifucave/moss-plugin-sdk/ui";
import { useCallback, type ReactElement } from "react";
import { DevicesTab, type DevicesSource } from "./DevicesTab";
import { setTranslator, type Translator } from "./strings";

export function DevicesTabEntry(_: { props?: { expanded: boolean } }): ReactElement | null {
  const api = usePluginApi() as { devices?: DevicesSource };
  const open = useOpen();
  // The tab's words (the rows' status, groups) come in the user's language through the app's translator.
  setTranslator(useT() as unknown as Translator);
  const openDevices = useCallback((device?: string) => { void open({ kind: "settings", section: "devices", ...(device !== undefined ? { item: device } : {}) }); }, [open]);
  if (api.devices === undefined) return null;
  return <DevicesTab source={api.devices} onOpenDevices={openDevices} />;
}
