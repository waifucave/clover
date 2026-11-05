import { expect, test } from "bun:test";
import { canSend, keyAction, type KeyInfo } from "../client/keys";

const key = (k: string, extra: Partial<KeyInfo> = {}): KeyInfo => ({
  key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...extra,
});

test("Enter sends; Shift+Enter and Alt+Enter make a new line", () => {
  expect(keyAction(key("Enter"), false)).toBe("send");
  expect(keyAction(key("Enter", { metaKey: true }), false)).toBe("send");
  expect(keyAction(key("Enter", { shiftKey: true }), false)).toBe("none");
  expect(keyAction(key("Enter", { altKey: true }), false)).toBe("none");
});

test("Enter while an input method composes picks a candidate, never sends", () => {
  expect(keyAction(key("Enter", { isComposing: true }), false)).toBe("none");
  expect(keyAction(key("Enter", { keyCode: 229 }), false)).toBe("none");
});

test("Escape stops a running turn, and does nothing otherwise", () => {
  expect(keyAction(key("Escape"), true)).toBe("stop");
  expect(keyAction(key("Escape"), false)).toBe("none");
  expect(keyAction(key("a"), true)).toBe("none");
});

test("a message can go with text or attachments, never asleep or over the limit", () => {
  expect(canSend("hi", 0, 20, false)).toBe(true);
  expect(canSend("   ", 0, 20, false)).toBe(false);
  expect(canSend("", 1, 20, false)).toBe(true);
  expect(canSend("hi", 0, 20, true)).toBe(false);
  expect(canSend("hi", 21, 20, false)).toBe(false);
});
