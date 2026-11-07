// The UI API the `clover` tree's parts get in the app. Each part's `client/sdk.ts` is lane F's stand-in (its gallery's
// and its tests' runtime, `shell/runtime/ui.ts`); in the app's `clover` layer the build puts this module in its place,
// so every part runs on the app's own runtime (`@waifucave/clover-plugin-sdk/ui`) with no change to a component.
//
// The names are taken from the SDK by name, not re-exported: Bun's bundler lowers `export *` and namespace re-exports
// through a bundle in a way this graph mishandles (the clover bundle crashed at its own boot: `ReferenceError`),
// while a `const {...} = Ui` destructure compiles to plain bindings. Lane F's stand-ins hand their parts the same
// spread, so anything a part uses is here, beside the two hooks lane F's parts use that lane B doesn't declare
// (`useCore`, `useEntry`).
import * as Ui from "@waifucave/clover-plugin-sdk/ui";
import { SEALED_FIELDS } from "@clover-child/shell/runtime/ui";
import type { SealedField, SealedRenderers, UiRuntime } from "@clover-child/shell/runtime/ui";
import type { ReactNode } from "react";

export const { Spot, Card, AppView } = Ui;
export const { useApprovals, useCore, useDrag, useEntry, useMenu, useOpen, usePluginApi,
  useQuestions, useSpotEntries, useSurface, useTokens, useT, useUserSend, useViewFrame,
  useLayerMessage, useMountContext } = Ui;
export { SEALED_FIELDS };
export type { SealedField, SealedRenderers, UiRuntime };

/** The stand-in's provider, for the gallery and the tests; the app's runtime needs none. */
export function UiRuntimeProvider({ children }: { runtime?: unknown; children?: ReactNode }): ReactNode {
  return children ?? null;
}

/** The browser view's stand-in provider: in the app each part calls `usePluginApi()` on its own, so this accepts
 *  anything a host passes and draws the children (lane L's part keeps the name its manifest and tests bind). */
export function PluginApiProvider(props: { api?: unknown; viewFrame?: unknown; children?: ReactNode }): ReactNode {
  return props.children ?? null;
}
