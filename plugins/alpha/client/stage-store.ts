// The one place Alpha's stage components read their shared stage state from: her server's `stage` document (state version
// 1) in her plugin store, which her layer reads (`storage.synced.get`) and hears change (`host.on("stage")`, and
// `storage.synced.watch` as the fallback), never settings. Only her server writes it; a component calls her server with
// `host.call` (`setCatalog`).
import { useEffect, useState } from "react";
import { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";
import { EMPTY_STAGE, readStage, type StageState } from "./stage-doc";

export { EMPTY_STAGE, MOODS, readStage } from "./stage-doc";
export type { Mood, StageState } from "./stage-doc";

export function useStageState(): StageState {
  const api = usePluginApi();
  const [state, setState] = useState<StageState>(EMPTY_STAGE);
  useEffect(() => {
    let live = true;
    const take = (raw: unknown) => { const s = readStage(raw); if (s && live) setState(s); };
    const read = () => void api.storage.synced.get("stage").then(take, () => undefined);
    read();
    const stopOn = api.host.on("stage", take);
    const stopWatch = api.storage.synced.watch((key: string) => { if (key === "stage") read(); });
    return () => { live = false; stopOn(); stopWatch(); };
  }, [api]);
  return state;
}
