// The pill's side of its surface window: the window it asks for and the regions that take clicks, sent through the SDK's
// `useSurface()` (merged once per frame by `./coalesce`). Its own (F2b: no plugin imports another's folder); `Rect` and
// `SurfaceEnvironment` are the SDK's.
import { useEffect, useMemo } from "react";
import type { Rect, SurfaceEnvironment } from "@waifucave/moss-plugin-sdk/ui";
import { coalesced } from "./coalesce";

export type { Rect, SurfaceEnvironment };

/** What the pill opens: a frameless transparent overlay on top of everything, or a normal framed window. */
export interface SurfaceWindowSpec {
  /** Screen CSS pixels. A normal window's `x` and `y` are a first suggestion its compositor may ignore. */
  bounds: Rect;
  overlay: boolean;
  alwaysOnTop: boolean;
  transparent: boolean;
  frame: boolean;
  /** An overlay takes clicks only inside the regions the pill reports; outside them they pass through. */
  clickThrough: boolean;
  /** Shown in the task switcher and the taskbar: a normal window is, an overlay isn't. */
  inTaskSwitcher: boolean;
  /** An overlay with nothing drawn is hidden, so it covers nothing at all. */
  visible: boolean;
}

/** What the pill needs from its window. */
export interface SurfaceHostApi {
  /** Open the window this way, or move, resize or hide it. Called again only when it changes. */
  setWindow(spec: SurfaceWindowSpec): void;
  /** The regions that take clicks, in the window's own space; every other click passes through an overlay. */
  setInteractiveRegions(regions: readonly Rect[]): void;
}

/** One coalescing host for the pill's window, cleared when the part unmounts. */
export function useCoalesced(surface: unknown): SurfaceHostApi {
  const host = useMemo(() => coalesced(surface as never), [surface]);
  useEffect(() => () => host.dispose(), [host]);
  return host;
}
