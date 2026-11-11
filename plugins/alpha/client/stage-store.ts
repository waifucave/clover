// The one place Alpha's stage components read their shared stage state from. Today it is the plugin's settings, the
// interim store; when the server-UI seam lands (`storage.synced.get("stage")` + `host.on("stage")`, state version 1:
// `{ v, expression?, motion?, scene, mood, outfit, activity?, pinned, tally, nonce }`) only this file changes.
import { useEffect, useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";

export interface StageState {
  /** A line she keeps in view on her stage. */
  pinned?: string;
}

export function useStageState(): StageState {
  const api = usePluginApi();
  const [state, setState] = useState<StageState>({});
  useEffect(() => {
    let live = true;
    const read = () => void api.settings.get<string>("pinned").then((v) => live && setState({ ...(v ? { pinned: v } : {}) }), () => undefined);
    read();
    const stop = api.settings.watch(null, read);
    return () => { live = false; stop(); };
  }, [api]);
  return state;
}
