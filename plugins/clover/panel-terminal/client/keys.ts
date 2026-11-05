// A key press as the bytes a terminal sends. Printable keys are themselves; Enter is a carriage
// return; Ctrl with a letter is its control code; the arrows and the rest are their escape sequences.
//
// A paste is not a key press. On macOS it is ⌘V, which never reaches here. On Windows and Linux it is
// Ctrl+V or Ctrl+Shift+V, so those send nothing and let the paste happen, which goes through the
// terminal's paste door whole.

export type Platform = "mac" | "windows" | "linux";

/** The platform this runs on, from the browser's own report. */
export function currentPlatform(): Platform {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const name = ((nav as { userAgentData?: { platform?: string } } | undefined)?.userAgentData?.platform ?? nav?.platform ?? "").toLowerCase();
  if (name.startsWith("mac")) return "mac";
  if (name.startsWith("win")) return "windows";
  return "linux";
}

/** Whether this key press is the platform's paste. */
export function isPasteKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, platform: Platform): boolean {
  if (e.altKey || e.key.toLowerCase() !== "v") return false;
  return platform === "mac" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export function keyToData(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, platform: Platform = "mac"): string | undefined {
  if (e.metaKey) return undefined;
  if (isPasteKey(e, platform)) return undefined;
  if (e.ctrlKey && e.key.length === 1 && /[a-z]/i.test(e.key)) return String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96);
  switch (e.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
  }
  if (e.key.length === 1 && !e.ctrlKey) return e.altKey ? `\x1b${e.key}` : e.key;
  return undefined;
}
