import { expect, test } from "bun:test";
import { appendHeard, canSend, endsTalkKey, isTalkKey, keyAction, type KeyInfo } from "../client/keys";

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

test("Ctrl+Shift+Space holds push-to-talk; no other chord, no composing input method", () => {
  const chord = (extra: Partial<KeyInfo & { code: string }> = {}) => ({ ...key(" ", { ctrlKey: true, shiftKey: true }), code: "Space", ...extra });
  expect(isTalkKey(chord())).toBe(true);
  expect(isTalkKey(chord({ key: "Dead", code: "Space" }))).toBe(true);
  for (const bad of [{ ctrlKey: false }, { shiftKey: false }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }, { key: "a", code: "KeyA" }]) {
    expect([bad, isTalkKey(chord(bad))]).toEqual([bad, false]);
  }
  // Enter and Escape are not it: Enter still sends, Esc still stops.
  expect(isTalkKey({ ...key("Enter", { ctrlKey: true, shiftKey: true }), code: "Enter" })).toBe(false);
});

test("letting go of any key of the chord ends the hold", () => {
  for (const k of [{ key: "Control" }, { key: "Shift" }, { key: " ", code: "Space" }, { key: "Dead", code: "Space" }]) expect(endsTalkKey(k)).toBe(true);
  expect(endsTalkKey({ key: "a", code: "KeyA" })).toBe(false);
});

test("what was heard goes after what is in the box, with a space only where one is needed, and an empty hearing changes nothing", () => {
  expect(appendHeard("", "hello there")).toBe("hello there");
  expect(appendHeard("and", " hello there \n")).toBe("and hello there");
  expect(appendHeard("and ", "hello")).toBe("and hello");
  expect(appendHeard("line\n", "hello")).toBe("line\nhello");
  expect(appendHeard("keep", "   ")).toBe("keep");
});
