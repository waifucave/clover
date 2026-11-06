// The UI API the `clover` tree's parts get in the app. Each part's `client/sdk.ts` is lane F's stand-in (its gallery's
// and its tests' runtime, `shell/runtime/ui.ts`); in the app's `clover` layer the build puts this module in its place,
// so every part runs on the app's own runtime (`@waifucave/clover-plugin-sdk/ui`) with no change to a component: lane
// B's UiApi, plus the two hooks lane F's parts use that B doesn't declare (`useCore`, `useEntry`) and a provider that
// only hosts need, which here passes its children through.
import type { ReactNode } from "react";

export * from "@waifucave/clover-plugin-sdk/ui";
export { SEALED_FIELDS, type SealedField, type SealedRenderers, type UiRuntime } from "@clover-child/shell/runtime/ui";

/** The stand-in's provider, for the gallery and the tests; the app's runtime needs none. */
export function UiRuntimeProvider({ children }: { runtime?: unknown; children?: ReactNode }): ReactNode {
  return children ?? null;
}
