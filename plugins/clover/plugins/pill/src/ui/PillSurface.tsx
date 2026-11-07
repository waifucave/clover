// The Dispatch pill as an `app.surface` entry on every OS (`pillWindow`): a transparent panel at the bottom centre,
// sized to the pill's canvas as it grows and shrinks, taking clicks only on the pill; on Wayland, a normal window. The
// surface host is lane E's, the island's: it opens the window the pill asks for and passes other clicks through.
// Until E's runtime hands it over, the gallery and the tests give a stand-in (`SurfaceHostApi`).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { SurfaceEnvironment, SurfaceHostApi } from "@waifucave/clover-plugin-island";
import { RESTING_CANVAS, pillInset, pillMode, pillRegions, pillWindow, type PillPieces } from "../model/placement";
import type { Size } from "../model/metrics";
import { DispatchPill, type DispatchPillProps } from "./DispatchPill";

export interface PillSurfaceProps extends DispatchPillProps {
  environment: SurfaceEnvironment;
  host?: SurfaceHostApi;
}

export function PillSurface({ environment, host, ...pill }: PillSurfaceProps): ReactElement {
  const [canvas, setCanvas] = useState<Size>(RESTING_CANVAS);
  const mode = pillMode(environment);
  const envKey = JSON.stringify(environment);
  const env = useMemo(() => environment, [envKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const spec = useMemo(() => pillWindow(env, canvas), [env, canvas]);
  const [pieces, setPieces] = useState<PillPieces | undefined>(undefined);
  const regions = useMemo(() => pillRegions(env, canvas, pieces), [env, canvas, pieces]);
  const lastSpec = useRef<string | null>(null);
  const lastRegions = useRef<string | null>(null);

  // The host hears a window or regions only when they change.
  useEffect(() => {
    const key = JSON.stringify(spec);
    if (key !== lastSpec.current) {
      lastSpec.current = key;
      host?.setWindow(spec);
    }
    const rkey = JSON.stringify(regions);
    if (rkey !== lastRegions.current) {
      lastRegions.current = rkey;
      host?.setInteractiveRegions(regions);
    }
  }, [host, spec, regions]);

  const onCanvas = pill.onCanvas;
  const measured = useCallback(
    (size: Size) => {
      setCanvas((c) => (c.width === size.width && c.height === size.height ? c : size));
      onCanvas?.(size);
    },
    [onCanvas],
  );

  const onPieces = pill.onPieces;
  const drawn = useCallback(
    (next: PillPieces) => {
      setPieces((p) => (p && JSON.stringify(p) === JSON.stringify(next) ? p : next));
      onPieces?.(next);
    },
    [onPieces],
  );

  const inset = pillInset(mode);
  return (
    <div
      className="clp-surface"
      data-mode={mode}
      style={{
        position: "relative",
        width: spec.bounds.width,
        height: spec.bounds.height,
        boxSizing: "border-box",
        padding: inset,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        alignItems: "center",
      }}
    >
      <DispatchPill {...pill} onCanvas={measured} onPieces={drawn} />
    </div>
  );
}
