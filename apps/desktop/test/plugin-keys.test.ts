import { describe, expect, test } from "bun:test";
import { APP_CHORDS, canonicalChord } from "@waifucave/clover-plugin-sdk";
import { PluginKeys } from "../src/main/plugin-keys";
import { appShortcut } from "../src/main/shortcuts";

const press = (o: { key: string; code?: string; type?: string; control?: boolean; meta?: boolean; alt?: boolean; shift?: boolean; isAutoRepeat?: boolean }) =>
  ({ type: "keyDown", control: false, meta: false, alt: false, shift: false, ...o });

const rows = [
  { name: "a.go", key: "mod+shift+k", keyState: { state: "bound", chord: "shift+meta+k" } },
  { name: "a.clash", key: "mod+j", keyState: { state: "clash", with: ["b.clash"] } },
  { name: "a.quit", key: "mod+q", keyState: { state: "app", what: "Quit" } },
  { name: "a.nokey" },
];

describe("a plugin command's key in main", () => {
  test("a bound chord matches its command; the same chord by another route does not", () => {
    const k = new PluginKeys("darwin");
    k.set(rows);
    expect(k.size).toBe(1);
    expect(k.match(press({ key: "K", code: "KeyK", meta: true, shift: true }))).toBe("a.go");
    expect(k.match(press({ key: "k", code: "KeyK", meta: true }))).toBeUndefined();
    expect(k.match(press({ key: "k", code: "KeyK", control: true, shift: true }))).toBeUndefined();
  });
  test("only a fresh key-down: not a key-up, not a repeat", () => {
    const k = new PluginKeys("darwin");
    k.set(rows);
    const base = { key: "K", code: "KeyK", meta: true, shift: true };
    expect(k.match(press({ ...base, type: "keyUp" }))).toBeUndefined();
    expect(k.match(press({ ...base, isAutoRepeat: true }))).toBeUndefined();
  });
  test("a clash, an app chord and a command with no key are never in the table", () => {
    const k = new PluginKeys("darwin");
    k.set(rows);
    expect(k.match(press({ key: "j", code: "KeyJ", meta: true }))).toBeUndefined();
    expect(k.match(press({ key: "q", code: "KeyQ", meta: true }))).toBeUndefined();
  });
  test("a new list replaces the old one", () => {
    const k = new PluginKeys("linux");
    k.set(rows);
    k.set([]);
    expect(k.size).toBe(0);
  });
});

describe("the app's own chords", () => {
  test("every chord the resolver reserves for the three shortcuts is one appShortcut answers", () => {
    for (const [chord, expected] of [["mod+q", "quit"], ["mod+w", "close-window"], ["mod+,", "settings"]] as const) {
      expect(APP_CHORDS.some((a) => a.chord === chord)).toBe(true);
      for (const platform of ["darwin", "win32"] as const) {
        const canon = canonicalChord(chord, platform)!.split("+");
        const key = canon.pop()!;
        const input = { type: "keyDown", key, control: canon.includes("ctrl"), meta: canon.includes("meta"), alt: false, shift: false };
        expect(appShortcut(input, platform)).toBe(expected);
      }
    }
  });
});
