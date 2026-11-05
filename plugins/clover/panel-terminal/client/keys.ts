// A key press as the bytes a terminal sends. Printable keys are themselves; Enter is a carriage
// return; Ctrl with a letter is its control code; the arrows and the rest are their escape sequences.
export function keyToData(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | undefined {
  if (e.metaKey) return undefined;
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
