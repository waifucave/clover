// The Devices tab of the island: an `island.tab` entry of its own plugin. The island declares the slot and draws its tab
// dots; this plugin reads `devices.read` and draws the rows with the island's own row kit. It imports `./sdk`, which the
// layer's build binds to the app's runtime.
import { useCallback, type ReactElement } from "react";
import { DevicesTab, setTranslator, type DevicesSource, type Translator } from "@waifucave/clover-plugin-island";
import { useOpen, usePluginApi, useT } from "./sdk";

export function DevicesTabEntry(_: { props?: { expanded: boolean } }): ReactElement | null {
  const api = usePluginApi() as { devices?: DevicesSource };
  const open = useOpen();
  // The island's words (the rows' status, groups) come in the user's language through the app's translator.
  setTranslator(useT() as unknown as Translator);
  const openDevices = useCallback((device?: string) => { void open({ kind: "settings", section: "devices", ...(device !== undefined ? { item: device } : {}) }); }, [open]);
  if (api.devices === undefined) return null;
  return <DevicesTab source={api.devices} onOpenDevices={openDevices} />;
}
