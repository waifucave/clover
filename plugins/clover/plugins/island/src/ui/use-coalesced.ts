// A surface part's one coalescing host, cleared when the part unmounts (see ./coalesce).
import { useEffect, useMemo } from "react";
import { coalesced } from "./coalesce";
import type { SurfaceHostApi } from "./IslandSurface";

/** One coalescing host for a surface part, cleared when the part unmounts. */
export function useCoalesced(surface: unknown): SurfaceHostApi {
  const host = useMemo(() => coalesced(surface as never), [surface]);
  useEffect(() => () => host.dispose(), [host]);
  return host;
}
