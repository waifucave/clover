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
