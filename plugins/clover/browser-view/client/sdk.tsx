// A stand-in for the plugin SDK's `usePluginApi()` (spec §5.5), written against lane B's declaration in
// `packages/plugin-sdk/src/api/ui-api.ts`. Lane E builds the real module; when it is on main, this file becomes
// a re-export of it, the way lane F's other parts do (`plugins/clover/conversation/client/sdk.tsx`). Until then a
// host (the gallery, the tests) hands the API in through <PluginApiProvider>.
import { createContext, useContext, type ReactNode } from "react";
import type { PluginApi } from "./types";

const ApiContext = createContext<PluginApi | null>(null);

export function PluginApiProvider({ api, children }: { api: PluginApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

/** The plugin API in this layer; `null` before a host provides one. */
export function usePluginApi(): PluginApi | null {
  return useContext(ApiContext);
}
