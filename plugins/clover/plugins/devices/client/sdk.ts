// The plugin SDK's UI API for the Devices entry's default host. The app's layer build binds this file to the app's own
// runtime (`@waifucave/clover-plugin-sdk/ui`); here, in a unit test or a gallery, it is the shell's stand-in, built from
// this part's own React, and `useOpen` does nothing.
import * as React from "react";
import { uiFor } from "../../shell/runtime/ui";

export const { usePluginApi, useT, UiRuntimeProvider } = uiFor(React);
export const useOpen = (): ((target: { kind: "settings"; section?: string; item?: string }) => Promise<void>) => () => Promise.resolve();
