// The app's own shortcuts (S9: the host owns them through `before-input-event`, ahead of every layer, so a focused
// layer can't take them): ⌘Q, ⌘W and ⌘, on macOS, Ctrl+Q, Ctrl+W and Ctrl+, elsewhere. On macOS the menu's
// accelerators stay too, for when no page has the focus. Pure, so it is unit-tested.
export type AppShortcut = "quit" | "close-window" | "settings";

// The smoke run's real input (E-M3's end-to-end): CDP-dispatched presses travel the browser's real input path
// into out-of-process sealed frames, where sendInputEvent's mouse path stops at the main frame. Test-only on every
// axis: an unpackaged, headless run alone. A packaged app started with the smoke's env vars must never attach
// webContents.debugger or dispatch CDP input (B1's gate), so both click paths ask first. Pure, so it is unit-tested
// (packaged mode ignores the smoke's presses). A test-marked build takes them packaged too in a headless run, folded
// at each call site (index.ts's `testBuildPress`), so a real build has no such path.
export function sealedInputAllowed(input: { packaged: boolean; headless: boolean }): boolean {
  return input.packaged !== true && input.headless === true;
}

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

/** Whether the app's own fallback card window may show. A headless run never shows a window on the owner's screen, except the
 *  sealed smoke run that asks for it (`CLOVER_SMOKE_SEALED_FALLBACK=1`, an unpackaged or test-marked run) because it has to press
 *  the card's button; that one logs that it showed a window while headless. */
export function fallbackMayShow(input: { headless: boolean; smokeFallback: boolean; testInput: boolean }): boolean {
  return !input.headless || (input.smokeFallback && input.testInput);
}
