// The app's windows (spec §3.1, decision 86): the main window with an inset title bar over the window's material —
// the sidebar material (`vibrancy`) on macOS, acrylic (`backgroundMaterial`) on Windows 11, a solid colour on Linux —
// and the surface windows (the island, the pill: `app.surface` entries with `window`). Pure: the options are data,
// unit-tested; index.ts creates the windows.
import type { BrowserWindowConstructorOptions } from "electron";
import type { Material } from "./ui/runtime";

export interface WindowPlan {
  material: Material;
  options: BrowserWindowConstructorOptions;
}

/** The title bar's height, the catalog's `titlebar.height` (45px). */
export const TITLE_BAR_HEIGHT = 45;

/** Every window's page: sandboxed and isolated, no Node, no `<webview>`, and the preload in every frame (S9: with
 *  `nodeIntegrationInSubFrames`, a sandboxed preload reaches out-of-process frames; it exposes only the layer bridge,
 *  and only to the core's and the layers' own origins). */
export function webPreferences(input: { preload: string; partition: string; headless: boolean; offscreen: boolean }): NonNullable<BrowserWindowConstructorOptions["webPreferences"]> {
  return {
    preload: input.preload,
    partition: input.partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    enableWebSQL: false,
    autoplayPolicy: "user-gesture-required",
    // Headless runs (the tests, the smoke run) paint without a window on screen.
    backgroundThrottling: !input.headless,
    ...(input.offscreen ? { offscreen: true } : {}),
  };
}

/** The main window: hidden until its page is ready, never shown in a headless run. */
export function mainWindowPlan(input: {
  platform: NodeJS.Platform;
  /** Windows 11 22H2 or later, where acrylic exists. */
  acrylic: boolean;
  title: string;
  dark: boolean;
  solid: string;
  symbol: string;
  webPreferences: BrowserWindowConstructorOptions["webPreferences"];
}): WindowPlan {
  const base: BrowserWindowConstructorOptions = {
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 420,
    title: input.title,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: input.webPreferences,
  };
  if (input.platform === "darwin") {
    return {
      material: "vibrancy",
      options: {
        ...base,
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 16, y: 15 },
        vibrancy: "sidebar",
        visualEffectState: "followWindow",
        backgroundColor: "#00000000",
      },
    };
  }
  const overlay = { color: "#00000000", symbolColor: input.symbol, height: TITLE_BAR_HEIGHT };
  if (input.platform === "win32") {
    return {
      material: input.acrylic ? "acrylic" : "none",
      options: {
        ...base,
        titleBarStyle: "hidden",
        titleBarOverlay: input.acrylic ? overlay : { ...overlay, color: input.solid },
        ...(input.acrylic ? { backgroundMaterial: "acrylic" as const, backgroundColor: "#00000000" } : { backgroundColor: input.solid }),
      },
    };
  }
  return {
    material: "none",
    options: { ...base, titleBarStyle: "hidden", titleBarOverlay: { ...overlay, color: input.solid }, backgroundColor: input.solid },
  };
}

/** Whether this Windows has acrylic (`backgroundMaterial`): Windows 11 22H2 is build 22621. */
export function windowsHasAcrylic(release: string): boolean {
  const build = Number(release.split(".")[2]);
  return Number.isFinite(build) && build >= 22621;
}

export interface SurfaceWindow {
  type: "overlay" | "window";
  alwaysOnTop?: boolean;
  transparent?: boolean;
}

/** A surface window (`app.surface` with `window`): an overlay floats over everything without taking the focus. */
export function surfaceWindowPlan(input: { surface: SurfaceWindow; webPreferences: BrowserWindowConstructorOptions["webPreferences"]; title: string }): BrowserWindowConstructorOptions {
  const overlay = input.surface.type === "overlay";
  return {
    width: 480,
    height: 320,
    title: input.title,
    show: false,
    paintWhenInitiallyHidden: true,
    frame: !overlay,
    transparent: input.surface.transparent === true,
    backgroundColor: input.surface.transparent === true ? "#00000000" : undefined,
    alwaysOnTop: input.surface.alwaysOnTop === true,
    focusable: !overlay,
    skipTaskbar: overlay,
    hasShadow: !overlay,
    resizable: !overlay,
    fullscreenable: false,
    webPreferences: input.webPreferences,
  };
}
