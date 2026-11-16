import { describe, expect, test } from "bun:test";
import { APP_CHORDS, canonicalChord } from "@waifucave/moss-plugin-sdk";
import { PluginKeys, keysMayRun } from "../src/main/plugin-keys";
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

describe("a held key binding (`commands[].hold`): its down and its release", () => {
  const heldRows = [
    { name: "v.talk", pluginId: "v", key: "ctrl+shift+space", hold: true, keyState: { state: "bound", chord: "ctrl+shift+space" } },
    { name: "a.go", pluginId: "a", key: "mod+shift+k", keyState: { state: "bound", chord: "shift+meta+k" } },
  ];
  const chord = { key: " ", code: "Space", control: true, shift: true };
  const make = () => {
    const k = new PluginKeys("darwin");
    k.set(heldRows);
    return k;
  };

  test("the down is delivered once; repeats are no new press; neither is handled in main (Chromium would drop the release), the preload keeps both from the page; the key's up delivers the up once and is consumed", () => {
    const k = make();
    expect(k.hold(1, press(chord), true)).toMatchObject({ binding: { name: "v.talk", pluginId: "v", hold: true }, phase: "down", consume: false });
    expect(k.swallows(1, chord)).toBe(true);
    expect(k.swallows(2, chord)).toBe(false);
    expect(k.swallows(1, { key: "a", code: "KeyA" })).toBe(false);
    for (let i = 0; i < 3; i++) expect(k.hold(1, press({ ...chord, isAutoRepeat: true }), true)).toEqual({ binding: expect.objectContaining({ name: "v.talk" }), consume: false });
    expect(k.hold(1, press({ ...chord, type: "keyUp" }), true)).toMatchObject({ phase: "up", consume: true });
    expect(k.hold(1, press({ ...chord, type: "keyUp" }), true)).toBeUndefined();
    expect(k.swallows(1, chord)).toBe(false);
  });

  test("another key's up is not its up; another key's down passes by and the hold goes on", () => {
    const k = make();
    k.hold(1, press(chord), true);
    expect(k.hold(1, press({ key: "a", code: "KeyA", type: "keyUp", control: true, shift: true }), true)).toBeUndefined();
    expect(k.hold(1, press({ key: "a", code: "KeyA", control: true, shift: true }), true)).toBeUndefined();
    expect(k.hold(1, press({ key: "Alt", type: "keyUp", control: true, shift: true }), true)).toBeUndefined(); // not one of its modifiers
    expect(k.hold(1, press({ ...chord, type: "keyUp" }), true)).toMatchObject({ phase: "up" });
  });

  test("a modifier let go first ends it once (not consumed: the page sees the modifier go); its key's repeats are still kept from the page (the preload) and its up consumed", () => {
    const k = make();
    k.hold(1, press(chord), true);
    expect(k.hold(1, press({ key: "Shift", code: "ShiftLeft", type: "keyUp", control: true }), true)).toMatchObject({ phase: "up", consume: false });
    expect(k.hold(1, press({ key: "Control", code: "ControlLeft", type: "keyUp" }), true)).toBeUndefined();
    expect(k.hold(1, press({ key: " ", code: "Space", control: true, isAutoRepeat: true }), true)).toEqual({ binding: expect.objectContaining({ name: "v.talk" }), consume: false });
    expect(k.swallows(1, { key: " ", code: "Space" })).toBe(true);
    expect(k.hold(1, press({ key: " ", code: "Space", type: "keyUp" }), true)).toEqual({ binding: expect.objectContaining({ name: "v.talk" }), consume: true });
    // Pressed again, it is a new hold.
    expect(k.hold(1, press(chord), true)).toMatchObject({ phase: "down" });
    // An up whose state lost a modifier ends it too, whatever key it names (a synthesized modifier's up).
    expect(k.hold(1, press({ key: "Unidentified", type: "keyUp", control: true }), true)).toMatchObject({ phase: "up", consume: false });
  });

  test("per window; a hold starts only where a command's key may run; a press binding is no hold, and match never runs a held one as a press", () => {
    const k = make();
    expect(k.hold(1, press(chord), false)).toBeUndefined();
    expect(k.hold(1, press({ key: "K", code: "KeyK", meta: true, shift: true }), true)).toBeUndefined();
    expect(k.binding(press(chord))).toMatchObject({ name: "v.talk", hold: true });
    k.hold(1, press(chord), true);
    expect(k.hold(2, press({ ...chord, type: "keyUp" }), true)).toBeUndefined();
    expect(k.hold(1, press({ ...chord, type: "keyUp" }), true)).toMatchObject({ phase: "up" });
  });

  test("a stale hold (its up never came): the chord's key down afresh without its modifiers ends it as a cancel, goes on to the page, and its up is nobody's", () => {
    const k = make();
    k.hold(1, press(chord), true);
    // The chord pressed again with all its modifiers while still held: no new press.
    expect(k.hold(1, press(chord), true)).toEqual({ binding: expect.objectContaining({ name: "v.talk" }), consume: false });
    // A plain space later (the up was lost while the Mac slept): the hold ends with no release, and the space is the page's.
    expect(k.hold(1, press({ key: " ", code: "Space" }), true)).toEqual({ binding: expect.objectContaining({ name: "v.talk" }), phase: "cancel", consume: false, passOn: true });
    expect(k.swallows(1, { key: " ", code: "Space" })).toBe(false);
    expect(k.holding(1)).toBeUndefined();
    expect(k.hold(1, press({ key: " ", code: "Space", type: "keyUp" }), true)).toBeUndefined();
    // With only some of its modifiers it is stale too.
    k.hold(1, press(chord), true);
    expect(k.hold(1, press({ key: " ", code: "Space", control: true }), true)).toMatchObject({ phase: "cancel", passOn: true });
  });

  test("the window losing the focus ends a hold with no release of the user's (a cancel); nothing when none is held", () => {
    const k = make();
    expect(k.cancel(1)).toBeUndefined();
    k.hold(1, press(chord), true);
    expect(k.cancel(1)).toMatchObject({ binding: { name: "v.talk" }, phase: "cancel" });
    expect(k.cancel(1)).toBeUndefined();
    expect(k.hold(1, press({ ...chord, type: "keyUp" }), true)).toBeUndefined();
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

describe("a press's type", () => {
  test("a rawKeyDown is a key-down too (what some synthesized presses arrive as)", () => {
    const k = new PluginKeys("darwin");
    k.set(rows);
    expect(k.match(press({ key: "K", code: "KeyK", meta: true, shift: true, type: "rawKeyDown" }))).toBe("a.go");
    expect(k.match(press({ key: "K", code: "KeyK", meta: true, shift: true, type: "char" }))).toBeUndefined();
  });
});

describe("where the focus is", () => {
  test("a sealed frame (an approval or OK card) or an open secret field keeps a command's key from running", () => {
    expect(keysMayRun({ frameUrl: "moss-sealed://card/card_1/own?token=x", secureOpen: false })).toBe(false);
    expect(keysMayRun({ frameUrl: "moss-core://app/", secureOpen: true })).toBe(false);
    expect(keysMayRun({ frameUrl: undefined, secureOpen: true })).toBe(false);
  });
  test("any other focus, or none, lets it run", () => {
    expect(keysMayRun({ frameUrl: "moss-core://app/", secureOpen: false })).toBe(true);
    expect(keysMayRun({ frameUrl: "moss-plugin://alpha/?mount=1", secureOpen: false })).toBe(true);
    expect(keysMayRun({ frameUrl: null, secureOpen: false })).toBe(true);
    expect(keysMayRun({ frameUrl: undefined, secureOpen: false })).toBe(true);
  });
});
