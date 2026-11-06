// A stand-in for the plugin SDK's `usePluginApi()` and `useViewFrame()` (spec §5.5), written against lane B's
// declaration in `packages/plugin-sdk/src/api/ui-api.ts` and lane E's `packages/plugin-sdk/src/ui/index.tsx` (#168).
// Lane E builds the real module; when it is on main, this file becomes a re-export of it, the way lane F's other parts
// do (`plugins/clover/conversation/client/sdk.tsx`). Until then a host (the gallery, the tests) hands the API in
// through <PluginApiProvider>, and the view's frame through its `viewFrame`.
import { createContext, useContext, type ReactNode } from "react";
import type { PluginApi } from "./types";

const ApiContext = createContext<PluginApi | null>(null);

/** Lane E's `useViewFrame` (a hook): the ref callback that places a native view the core draws over this part. */
export type ViewFrameHook = (name: string) => (el: HTMLElement | null) => void;
const noFrame: ViewFrameHook = () => noRef;
const noRef = (): void => undefined;
const ViewFrameContext = createContext<ViewFrameHook>(noFrame);

export function PluginApiProvider({ api, viewFrame, children }: { api: PluginApi; viewFrame?: ViewFrameHook; children: ReactNode }) {
  return (
    <ApiContext.Provider value={api}>
      <ViewFrameContext.Provider value={viewFrame ?? noFrame}>{children}</ViewFrameContext.Provider>
    </ApiContext.Provider>
  );
}

/** Places the native view `name` (the Clover Browser's live view, "browser") over the element the returned ref goes
 *  on; the core keeps it there as it moves and gives it to the part the person used last (R8). Without a host that
 *  places views, a ref that does nothing. */
export function useViewFrame(name: string): (el: HTMLElement | null) => void {
  return useContext(ViewFrameContext)(name);
}

/** The plugin API in this layer; `null` before a host provides one. */
export function usePluginApi(): PluginApi | null {
  return useContext(ApiContext);
}
