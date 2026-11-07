// The app's own shortcuts (S9: the host owns them through `before-input-event`, ahead of every layer, so a focused
// layer can't take them): ⌘Q, ⌘W and ⌘, on macOS, Ctrl+Q, Ctrl+W and Ctrl+, elsewhere. On macOS the menu's
// accelerators stay too, for when no page has the focus. Pure, so it is unit-tested.
export type AppShortcut = "quit" | "close-window" | "settings";

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
