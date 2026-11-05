// Keys as DevTools `Input.dispatchKeyEvent` events: the page's own events only, never the computer's keyboard. Ported
// from Winter's `packages/core/src/computer-use/browser/input.ts`. Combos read "ctrl+a", "Enter", "shift+Tab".

export const MOD_ALT = 1;
export const MOD_CTRL = 2;
export const MOD_META = 4;
export const MOD_SHIFT = 8;

const MODIFIER_WORDS: Record<string, number> = {
  cmd: MOD_META, command: MOD_META, meta: MOD_META, super: MOD_META, win: MOD_META,
  ctrl: MOD_CTRL, control: MOD_CTRL,
  alt: MOD_ALT, option: MOD_ALT, opt: MOD_ALT,
  shift: MOD_SHIFT,
};

/** A key's DevTools identity: its `key`, `code` and Windows virtual key code, and the text it types (if any). */
export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED: Record<string, KeyDef> = {
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  forwarddelete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const PUNCT: Record<string, { code: string; keyCode: number; shift?: boolean }> = {
  "-": { code: "Minus", keyCode: 189 }, "_": { code: "Minus", keyCode: 189, shift: true },
  "=": { code: "Equal", keyCode: 187 }, "+": { code: "Equal", keyCode: 187, shift: true },
  "[": { code: "BracketLeft", keyCode: 219 }, "{": { code: "BracketLeft", keyCode: 219, shift: true },
  "]": { code: "BracketRight", keyCode: 221 }, "}": { code: "BracketRight", keyCode: 221, shift: true },
  "\\": { code: "Backslash", keyCode: 220 }, "|": { code: "Backslash", keyCode: 220, shift: true },
  ";": { code: "Semicolon", keyCode: 186 }, ":": { code: "Semicolon", keyCode: 186, shift: true },
  "'": { code: "Quote", keyCode: 222 }, "\"": { code: "Quote", keyCode: 222, shift: true },
  ",": { code: "Comma", keyCode: 188 }, "<": { code: "Comma", keyCode: 188, shift: true },
  ".": { code: "Period", keyCode: 190 }, ">": { code: "Period", keyCode: 190, shift: true },
  "/": { code: "Slash", keyCode: 191 }, "?": { code: "Slash", keyCode: 191, shift: true },
  "`": { code: "Backquote", keyCode: 192 }, "~": { code: "Backquote", keyCode: 192, shift: true },
};
const SHIFTED_DIGITS = ")!@#$%^&*(";

/** The key for one character (a letter, digit or punctuation mark); undefined for anything else, which is inserted as
 *  text instead. */
export function keyForChar(ch: string): (KeyDef & { shift: boolean }) | undefined {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch, shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: false };
  const sd = SHIFTED_DIGITS.indexOf(ch);
  if (sd >= 0) return { key: ch, code: `Digit${sd}`, keyCode: 48 + sd, text: ch, shift: true };
  const p = PUNCT[ch];
  if (p !== undefined) return { key: ch, code: p.code, keyCode: p.keyCode, text: ch, shift: p.shift === true };
  if (ch === " ") return { ...NAMED.space!, shift: false };
  return undefined;
}

/**
 * On a Mac it is the text system, not the page, that turns a key into an edit, so each combo carries the editing
 * commands AppKit's standard key bindings give it (`Input.dispatchKeyEvent`'s `commands`). Elsewhere the renderer
 * handles the keys itself, and no commands are sent. Never copy, cut or paste: those reach the person's clipboard.
 */
const MAC_COMMANDS: Record<string, string[]> = {
  "meta+a": ["selectAll"], "meta+z": ["undo"], "meta+shift+z": ["redo"],
  "backspace": ["deleteBackward"], "shift+backspace": ["deleteBackward"], "alt+backspace": ["deleteWordBackward"],
  "meta+backspace": ["deleteToBeginningOfLine"], "ctrl+backspace": ["deleteBackwardByDecomposingPreviousCharacter"],
  "delete": ["deleteForward"], "alt+delete": ["deleteWordForward"], "meta+delete": ["deleteToEndOfLine"],
  "ctrl+h": ["deleteBackward"], "ctrl+d": ["deleteForward"], "ctrl+k": ["deleteToEndOfParagraph"],
  "arrowleft": ["moveLeft"], "arrowright": ["moveRight"], "arrowup": ["moveUp"], "arrowdown": ["moveDown"],
  "alt+arrowleft": ["moveWordLeft"], "alt+arrowright": ["moveWordRight"],
  "alt+arrowup": ["moveBackward", "moveToBeginningOfParagraph"], "alt+arrowdown": ["moveForward", "moveToEndOfParagraph"],
  "meta+arrowleft": ["moveToBeginningOfLine"], "meta+arrowright": ["moveToEndOfLine"],
  "meta+arrowup": ["moveToBeginningOfDocument"], "meta+arrowdown": ["moveToEndOfDocument"],
  "ctrl+a": ["moveToBeginningOfParagraph"], "ctrl+e": ["moveToEndOfParagraph"],
  "ctrl+b": ["moveBackward"], "ctrl+f": ["moveForward"], "ctrl+p": ["moveUp"], "ctrl+n": ["moveDown"],
  "shift+arrowleft": ["moveLeftAndModifySelection"], "shift+arrowright": ["moveRightAndModifySelection"],
  "shift+arrowup": ["moveUpAndModifySelection"], "shift+arrowdown": ["moveDownAndModifySelection"],
  "alt+shift+arrowleft": ["moveWordLeftAndModifySelection"], "alt+shift+arrowright": ["moveWordRightAndModifySelection"],
  "alt+shift+arrowup": ["moveParagraphBackwardAndModifySelection"], "alt+shift+arrowdown": ["moveParagraphForwardAndModifySelection"],
  "meta+shift+arrowleft": ["moveToBeginningOfLineAndModifySelection"], "meta+shift+arrowright": ["moveToEndOfLineAndModifySelection"],
  "meta+shift+arrowup": ["moveToBeginningOfDocumentAndModifySelection"], "meta+shift+arrowdown": ["moveToEndOfDocumentAndModifySelection"],
};

export interface KeyPress {
  modifiers: number;
  def: KeyDef;
  commands?: string[];
  /** The combo in a fixed spelling ("ctrl+shift+tab"), for results. */
  name: string;
}

/** Why a combo can't be pressed, in words for the model. */
export class KeyRefusal extends Error {}

/** "ctrl+shift+z" → the press. `mac`: the browser runs on a Mac, so the press carries AppKit's editing commands. */
export function parseCombo(combo: string, mac: boolean): KeyPress {
  const trimmed = combo.trim();
  const parts = trimmed.split("+").map((p) => p.trim()).filter((p) => p.length > 0);
  // "ctrl++" (the plus key) splits into an empty last part: keep it as "+".
  if (trimmed.endsWith("++") || trimmed === "+") parts.push("+");
  if (parts.length === 0) throw new KeyRefusal('key needs a key or a combination, like "Enter", "Tab" or "ctrl+a".');
  let modifiers = 0;
  const last = parts[parts.length - 1]!;
  for (const m of parts.slice(0, -1)) {
    const bit = MODIFIER_WORDS[m.toLowerCase()];
    if (bit === undefined) throw new KeyRefusal(`"${m}" isn't a modifier; use cmd, ctrl, alt (or option) and shift.`);
    modifiers |= bit;
  }
  let def: KeyDef | undefined = NAMED[last.toLowerCase()];
  if (def === undefined && [...last].length === 1) {
    const k = keyForChar(last.length === 1 && /[A-Z]/.test(last) && modifiers !== 0 ? last.toLowerCase() : last);
    if (k !== undefined) {
      def = { key: k.key, code: k.code, keyCode: k.keyCode, ...(k.text === undefined ? {} : { text: k.text }) };
      if (k.shift) modifiers |= MOD_SHIFT;
    }
  }
  if (def === undefined) throw new KeyRefusal(`"${last}" isn't a key name; try Enter, Tab, Escape, Backspace, ArrowDown, PageDown, a letter or a digit.`);
  const k = def.key.toLowerCase();
  if ((modifiers & (MOD_META | MOD_CTRL)) !== 0 && (k === "c" || k === "x" || k === "v")) {
    throw new KeyRefusal("Copy, cut and paste would use the person's clipboard, so they're never pressed. To put text in a field, use type.");
  }
  if ((modifiers & MOD_SHIFT) !== 0 && k === "insert") throw new KeyRefusal("That key pastes from the person's clipboard. To put text in a field, use type.");
  const name = [
    modifiers & MOD_META ? "meta" : "", modifiers & MOD_CTRL ? "ctrl" : "", modifiers & MOD_ALT ? "alt" : "",
    modifiers & MOD_SHIFT ? "shift" : "", k,
  ].filter((x) => x.length > 0).join("+");
  const commands = mac ? MAC_COMMANDS[name] : undefined;
  return { modifiers, def, name, ...(commands === undefined ? {} : { commands }) };
}

/** The two `Input.dispatchKeyEvent` params (down, up) for a press. Text goes only with a printable key and no command
 *  modifier (shift alone still types). */
export function keyEvents(p: Pick<KeyPress, "modifiers" | "def" | "commands">): [Record<string, unknown>, Record<string, unknown>] {
  const types = p.def.text !== undefined && (p.modifiers & (MOD_META | MOD_CTRL | MOD_ALT)) === 0;
  const base = { modifiers: p.modifiers, key: p.def.key, code: p.def.code, windowsVirtualKeyCode: p.def.keyCode, nativeVirtualKeyCode: p.def.keyCode };
  const down: Record<string, unknown> = {
    type: types ? "keyDown" : "rawKeyDown", ...base,
    ...(types ? { text: p.def.text, unmodifiedText: p.def.text } : {}),
    ...(p.commands === undefined ? {} : { commands: p.commands }),
  };
  return [down, { type: "keyUp", ...base }];
}

/** Whether a press puts text in, or takes it out of, the focused field: the presses the secure-field floor stops.
 *  Moving the focus or the caret, Enter and Escape aren't edits. */
export function editsText(p: KeyPress): boolean {
  if (p.def.text !== undefined && p.def.key !== "Enter" && (p.modifiers & (MOD_META | MOD_CTRL | MOD_ALT)) === 0) return true;
  if (p.def.key === "Backspace" || p.def.key === "Delete") return true;
  if (p.commands?.some((c) => c.startsWith("delete") || c === "undo" || c === "redo")) return true;
  // Undo and redo on Windows and Linux (ctrl+z, ctrl+y, ctrl+shift+z), and the Mac's without its commands.
  const k = p.def.key.toLowerCase();
  if ((p.modifiers & (MOD_META | MOD_CTRL)) !== 0 && (k === "z" || k === "y")) return true;
  if ((p.modifiers & MOD_CTRL) !== 0 && (k === "h" || k === "d" || k === "k")) return true;
  return false;
}
