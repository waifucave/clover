// Key combos as DevTools key events (ported from computer use's input.ts), and which presses count as editing text.

import { describe, expect, test } from "bun:test";

import { editsText, keyEvents, keyForChar, KeyRefusal, MOD_CTRL, MOD_META, MOD_SHIFT, parseCombo } from "../src/keys";

describe("parseCombo", () => {
  test("named keys, letters and modifiers", () => {
    expect(parseCombo("Enter", false)).toMatchObject({ modifiers: 0, def: { key: "Enter", code: "Enter", keyCode: 13 }, name: "enter" });
    expect(parseCombo("shift+Tab", false)).toMatchObject({ modifiers: MOD_SHIFT, def: { key: "Tab" }, name: "shift+tab" });
    expect(parseCombo("ctrl+A", false)).toMatchObject({ modifiers: MOD_CTRL, def: { key: "a" }, name: "ctrl+a" });
    expect(parseCombo("?", false)).toMatchObject({ modifiers: MOD_SHIFT, def: { key: "?", code: "Slash" } });
    expect(parseCombo("ctrl++", false)).toMatchObject({ modifiers: MOD_CTRL | MOD_SHIFT, def: { key: "+" } });
  });

  test("AppKit's editing commands only on a Mac", () => {
    expect(parseCombo("cmd+a", true).commands).toEqual(["selectAll"]);
    expect(parseCombo("cmd+a", false).commands).toBeUndefined();
    expect(parseCombo("ctrl+a", true).commands).toEqual(["moveToBeginningOfParagraph"]);
    expect(parseCombo("ctrl+a", false).commands).toBeUndefined();
  });

  test("clipboard keys and nonsense are refused in words", () => {
    for (const combo of ["cmd+c", "ctrl+v", "meta+x", "shift+insert"]) expect(() => parseCombo(combo, true)).toThrow(KeyRefusal);
    expect(() => parseCombo("hyper+a", false)).toThrow('"hyper" isn\'t a modifier');
    expect(() => parseCombo("", false)).toThrow(KeyRefusal);
  });
});

describe("keyEvents", () => {
  test("a printable key types its text; a command chord doesn't", () => {
    const [down, up] = keyEvents(parseCombo("a", false));
    expect(down).toEqual({ type: "keyDown", modifiers: 0, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: "a", unmodifiedText: "a" });
    expect(up).toEqual({ type: "keyUp", modifiers: 0, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    expect(keyEvents(parseCombo("cmd+a", true))[0]).toEqual({
      type: "rawKeyDown", modifiers: MOD_META, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, commands: ["selectAll"],
    });
  });

  test("characters with no key are left for insertText", () => {
    expect(keyForChar("é")).toBeUndefined();
    expect(keyForChar("😀")).toBeUndefined();
    expect(keyForChar("Z")).toMatchObject({ key: "Z", shift: true });
  });
});

describe("editsText", () => {
  test("characters, deletions and undo edit; moving, Enter and Escape don't", () => {
    for (const combo of ["a", "shift+B", "1", "space", "Backspace", "Delete", "alt+Backspace", "ctrl+z", "cmd+shift+z", "ctrl+y"]) {
      expect([combo, editsText(parseCombo(combo, true))]).toEqual([combo, true]);
    }
    for (const combo of ["Enter", "Tab", "shift+Tab", "Escape", "ArrowDown", "PageDown", "Home", "cmd+a", "ctrl+r", "F5"]) {
      expect([combo, editsText(parseCombo(combo, false))]).toEqual([combo, false]);
    }
  });
});
