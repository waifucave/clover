// What a key press in the field does. Pure, so the rules are tested apart from the DOM.

export interface KeyInfo {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** An input method is composing (Japanese, Chinese…): Enter picks a candidate, never sends. */
  isComposing: boolean;
  keyCode?: number;
}

export type KeyAction = "send" | "stop" | "none";

export function keyAction(e: KeyInfo, running: boolean): KeyAction {
  if (e.isComposing || e.keyCode === 229) return "none";
  if (e.key === "Enter" && !e.shiftKey && !e.altKey) return "send";
  if (e.key === "Escape" && running) return "stop";
  return "none";
}

/** Whether a message can go now: something to send, a reachable bot, and not too many attachments. */
export function canSend(text: string, attachments: number, max: number, asleep: boolean): boolean {
  if (asleep) return false;
  if (attachments > max) return false;
  return text.trim().length > 0 || attachments > 0;
}

/** The key that holds push-to-talk while the box has the focus: Ctrl+Shift+Space (no system shortcut takes it on any of the three
 *  desktops; Ctrl+Space and Option+Space are input-source and launcher keys). Pure, like `keyAction`. */
export function isTalkKey(e: KeyInfo & { code?: string }): boolean {
  if (e.isComposing || e.keyCode === 229) return false;
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === "Space" || e.key === " ");
}

/** Whether releasing this key ends a hold that Ctrl+Shift+Space began: any of the three keys of the chord. */
export function endsTalkKey(e: { key: string; code?: string }): boolean {
  return e.key === "Control" || e.key === "Shift" || e.key === " " || e.code === "Space";
}

/** The words heard, put after what is already in the box: a space between when the box ends in a word, none after a space,
 *  a line break or nothing. The box stays the user's to edit and send. */
export function appendHeard(draft: string, heard: string): string {
  const text = heard.trim();
  if (text === "") return draft;
  return draft === "" || /\s$/.test(draft) ? `${draft}${text}` : `${draft} ${text}`;
}
