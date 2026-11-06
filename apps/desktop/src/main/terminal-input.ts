// What reaches a terminal is the user's (lane J's `terminal.write`, lane B's `TerminalApi.input`; spec §5.5): the
// terminal panel's part hands over the key press or paste event itself, and the main process writes only what it can
// derive from input it saw come to that window. A key press is matched to the main process's own record of it (the
// window's `before-input-event`, within a second, used once), and its bytes come from that record, never from the
// layer. A paste goes through the paste door: the main process saw the paste chord, reads the clipboard itself,
// brackets the text when the program turned bracketed paste on (`ESC[?2004h` in its output), and asks the user
// before one of more than one line goes; a no drops it. Pure, so the rules are unit-tested.

/** A key press as the main process saw it (Electron's `Input`). */
export interface SeenKey {
  key: string;
  code: string;
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  at: number;
}

/** How soon after the key press its part must hand it over. */
export const KEY_MATCH_MS = 1_000;

/** Each window's recent key presses, as the main process saw them; each is used once. */
export class KeyLog {
  private readonly keys = new Map<number, SeenKey[]>();

  constructor(private readonly now: () => number = Date.now) {}

  saw(windowId: number, key: Omit<SeenKey, "at">): void {
    const list = (this.keys.get(windowId) ?? []).filter((k) => this.now() - k.at <= KEY_MATCH_MS);
    list.push({ ...key, at: this.now() });
    this.keys.set(windowId, list.slice(-64));
  }

  /** The oldest unused press of `key` in the window, within the second; it is used up. */
  take(windowId: number, key: string): SeenKey | undefined {
    const list = this.keys.get(windowId) ?? [];
    const i = list.findIndex((k) => k.key === key && this.now() - k.at <= KEY_MATCH_MS);
    if (i < 0) return undefined;
    const [k] = list.splice(i, 1);
    return k;
  }

  /** The paste chord, pressed in the window within the second (⌘V on macOS; Ctrl+V, Ctrl+Shift+V or Shift+Insert
   *  elsewhere); it is used up. */
  takePaste(windowId: number, platform: NodeJS.Platform): boolean {
    const list = this.keys.get(windowId) ?? [];
    const i = list.findIndex((k) => this.now() - k.at <= KEY_MATCH_MS && isPasteChord(k, platform));
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  }

  forget(windowId: number): void {
    this.keys.delete(windowId);
  }
}

export function isPasteChord(k: Pick<SeenKey, "key" | "control" | "meta" | "shift" | "alt">, platform: NodeJS.Platform): boolean {
  const v = k.key.toLowerCase() === "v";
  if (platform === "darwin") return v && k.meta && !k.control && !k.alt;
  return (v && k.control && !k.meta && !k.alt) || (k.key === "Insert" && k.shift && !k.control);
}

const SPECIAL: Readonly<Record<string, string>> = {
  Enter: "\r", Backspace: "\u007f", Tab: "\t", Escape: "\u001b",
  ArrowUp: "\u001b[A", ArrowDown: "\u001b[B", ArrowRight: "\u001b[C", ArrowLeft: "\u001b[D",
  Home: "\u001b[H", End: "\u001b[F", Insert: "\u001b[2~", Delete: "\u001b[3~", PageUp: "\u001b[5~", PageDown: "\u001b[6~",
  F1: "\u001bOP", F2: "\u001bOQ", F3: "\u001bOR", F4: "\u001bOS", F5: "\u001b[15~", F6: "\u001b[17~", F7: "\u001b[18~",
  F8: "\u001b[19~", F9: "\u001b[20~", F10: "\u001b[21~", F11: "\u001b[23~", F12: "\u001b[24~",
};

/** A key press's bytes, as an xterm-style terminal sends them; undefined for a press that sends nothing (a lone
 *  modifier, the app's own shortcuts with ⌘ on macOS). */
export function keyBytes(k: Pick<SeenKey, "key" | "control" | "alt" | "shift" | "meta">, platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin" && k.meta) return undefined;
  if (k.key === "Tab" && k.shift) return "\u001b[Z";
  const special = SPECIAL[k.key];
  if (special !== undefined) return k.alt && special.length === 1 ? `\u001b${special}` : special;
  if ([...k.key].length !== 1) return undefined;
  let out = k.key;
  if (k.control) {
    const c = k.key.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
    else if (k.key === " ") out = "\u0000";
    else if (k.key === "?") out = "\u007f";
    else return undefined;
  }
  return k.alt ? `\u001b${out}` : out;
}

/** Whether each terminal's program turned bracketed paste on, from its output. */
export class PasteModes {
  private readonly on = new Map<string, boolean>();
  /** The tail of each terminal's output, so a sequence split across two pieces is still seen. */
  private readonly tail = new Map<string, string>();

  output(terminalId: string, data: string, exited = false): void {
    if (exited) {
      this.on.delete(terminalId);
      this.tail.delete(terminalId);
      return;
    }
    const text = (this.tail.get(terminalId) ?? "") + data;
    const onAt = text.lastIndexOf("\u001b[?2004h");
    const offAt = text.lastIndexOf("\u001b[?2004l");
    if (onAt >= 0 || offAt >= 0) this.on.set(terminalId, onAt > offAt);
    this.tail.set(terminalId, text.slice(-7));
  }

  bracketed(terminalId: string): boolean {
    return this.on.get(terminalId) === true;
  }
}

/** The paste as it goes to the terminal: whole, bracketed when the program asked (the markers inside it taken out,
 *  so the text can't end the paste early), and whether it needs the user's OK first (more than one line). */
export function preparePaste(text: string, bracketed: boolean): { data: string; lines: number; needsOk: boolean } {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").filter((l, i, all) => l !== "" || i < all.length - 1).length;
  const body = normalized.replace(/\n/g, "\r");
  const data = bracketed ? `\u001b[200~${body.replace(/\u001b\[20[01]~/g, "")}\u001b[201~` : body;
  return { data, lines, needsOk: lines > 1 };
}
