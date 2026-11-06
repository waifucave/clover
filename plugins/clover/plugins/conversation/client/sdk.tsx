// The plugin SDK's UI API (lane B's `UiApi`). Lane E's `@waifucave/clover-plugin-sdk/ui` provides it in the app; until
// E-M1 lands it is the shell's stand-in (`shell/runtime/ui.ts`), built from this part's own React. Then this file
// becomes `export * from "@waifucave/clover-plugin-sdk/ui"`, and no component changes.
//
// The view never sees a sealed field's text or an option's label: `<Card>` and its parts only say where each frame
// goes. Each part takes `className` (B pinned it); this view still wraps each sealed part in an element of its own and
// passes none, so its layout never depends on how the core draws a frame.
import * as React from "react";
import { uiFor } from "../../shell/runtime/ui";

export { SEALED_FIELDS, type SealedField, type SealedRenderers, type UiRuntime } from "../../shell/runtime/ui";

export const { Spot, Card, AppView, usePluginApi, useCore, useTokens, useT, useApprovals, useEntry, useSpotEntries, UiRuntimeProvider } = uiFor(React);
