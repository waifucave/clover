// The plugin SDK's UI API, from this part's own React (as every part's `client/sdk.ts`); in the `clover` layer the build
// swaps it for the app's runtime.
import * as React from "react";
import { uiFor } from "../../shell/runtime/ui";

export const { usePluginApi } = uiFor(React);
