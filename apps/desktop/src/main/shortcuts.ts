// The app's own shortcuts (S9: the host owns them through `before-input-event`, ahead of every layer, so a focused
// layer can't take them): ⌘Q, ⌘W and ⌘, on macOS, Ctrl+Q, Ctrl+W and Ctrl+, elsewhere. On macOS the menu's
// accelerators stay too, for when no page has the focus. Pure, so it is unit-tested.
export type AppShortcut = "quit" | "close-window" | "settings";

// The smoke run's real input (E-M3's end-to-end): CDP-dispatched presses travel the browser's real input path
// into out-of-process sealed frames, where sendInputEvent's mouse path stops at the main frame. Test-only on every
// axis: an unpackaged, headless run alone. A packaged app started with the smoke's env vars must never attach
// webContents.debugger or dispatch CDP input (B1's gate), so both click paths ask first. Pure, so it is unit-tested
// (packaged mode ignores the smoke's presses).
export function sealedInputAllowed(input: { packaged: boolean; headless: boolean }): boolean {
  return input.packaged !== true && input.headless === true;
}

/** The app's own reserved keys, ahead of every layer: the shortcuts above, in the manifest's `mod+…` chord grammar
 *  (lane F's palette checks user bindings against this list, F-M3). */
export const APP_KEYS = ["mod+q", "mod+w", "mod+,"] as const;

/** Electron's Edit-menu keys (the `editMenu` role's own accelerators, both platforms' redo): reserved with the app's
 *  own, so a layer or a plugin command never takes them silently. */
export const EDIT_MENU_KEYS = ["mod+z", "mod+shift+z", "mod+y", "mod+x", "mod+c", "mod+v", "mod+a"] as const;

/** Every key the app keeps: its own plus the Edit menu's. */
export const RESERVED_KEYS: readonly string[] = [...APP_KEYS, ...EDIT_MENU_KEYS];

export interface KeyInput {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export function appShortcut(input: KeyInput, platform: NodeJS.Platform): AppShortcut | undefined {
  if (input.type !== "keyDown" || input.alt) return undefined;
  const mac = platform === "darwin";
  const primary = mac ? input.meta && !input.control : input.control && !input.meta;
  if (!primary) return undefined;
  const key = input.key.toLowerCase();
  if (key === "q" && !input.shift) return "quit";
  if (key === "w" && !input.shift) return "close-window";
  if (key === ",") return "settings";
  return undefined;
}
