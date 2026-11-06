// The plugin SDK's UI API (lane B's `UiApi`). Lane E's `@waifucave/clover-plugin-sdk/ui` provides it in the app; until
// E-M1 lands it is the shell's stand-in (`shell/runtime/ui.ts`), built from this part's own React. Then this file
// becomes `export * from "@waifucave/clover-plugin-sdk/ui"`, and no component changes.
import * as React from "react";
import { uiFor } from "../runtime/ui";

export const { Spot, Card, AppView, usePluginApi, useCore, useTokens, useT, useApprovals, useEntry, useSpotEntries, UiRuntimeProvider } = uiFor(React);
