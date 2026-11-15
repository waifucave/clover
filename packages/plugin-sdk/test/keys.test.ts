import { describe, expect, test } from "bun:test";
import { APP_CHORDS, appChords, canonicalChord, chordOfPress, resolveKeys } from "../src";

const press = (o: Partial<Parameters<typeof chordOfPress>[0]> & { key: string }) => ({ control: false, meta: false, alt: false, shift: false, ...o });

describe("canonicalChord", () => {
  test("modifier order does not matter and mod is the platform's primary key", () => {
    expect(canonicalChord("shift+mod+k", "darwin")).toBe("shift+meta+k");
    expect(canonicalChord("mod+shift+k", "darwin")).toBe("shift+meta+k");
    expect(canonicalChord("mod+shift+k", "win32")).toBe("ctrl+shift+k");
    expect(canonicalChord("meta+k", "darwin")).toBe(canonicalChord("mod+k", "darwin"));
    expect(canonicalChord("meta+k", "linux")).not.toBe(canonicalChord("mod+k", "linux"));
  });
  test("a repeated modifier is one", () => expect(canonicalChord("ctrl+ctrl+k", "linux")).toBe("ctrl+k"));
});

describe("chordOfPress", () => {
  test("matches the physical key, so shift and alt don't change it", () => {
    expect(chordOfPress(press({ key: "K", code: "KeyK", meta: true, shift: true }))).toBe("shift+meta+k");
    expect(chordOfPress(press({ key: "å", code: "KeyA", alt: true, meta: true }))).toBe("alt+meta+a");
    expect(chordOfPress(press({ key: "!", code: "Digit1", control: true, shift: true }))).toBe("ctrl+shift+1");
    expect(chordOfPress(press({ key: "<", code: "Comma", control: true, shift: true }))).toBe("ctrl+shift+,");
    expect(chordOfPress(press({ key: "F5", code: "F5" }))).toBe("f5");
    expect(chordOfPress(press({ key: "ArrowUp", code: "ArrowUp", alt: true }))).toBe("alt+up");
  });
  test("falls back to key without a code, and a lone modifier is no chord", () => {
    expect(chordOfPress(press({ key: "K", meta: true }))).toBe("meta+k");
    expect(chordOfPress(press({ key: " ", control: true }))).toBe("ctrl+space");
    expect(chordOfPress(press({ key: "Meta", code: "MetaLeft", meta: true }))).toBeUndefined();
  });
  test("a manifest chord and its press are the same string", () => {
    expect(chordOfPress(press({ key: "k", code: "KeyK", meta: true, shift: true }))).toBe(canonicalChord("mod+shift+k", "darwin")!);
  });
});

describe("resolveKeys", () => {
  test("a free chord binds", () => {
    expect(resolveKeys([{ name: "a.go", key: "mod+shift+k" }], "darwin").get("a.go")).toEqual({ state: "bound", chord: "shift+meta+k" });
  });
  test("commands without a key are left out", () => {
    expect(resolveKeys([{ name: "a.go" }], "darwin").size).toBe(0);
  });
  test("the app's chord wins, in either spelling of mod", () => {
    const r = resolveKeys([{ name: "a.q", key: "mod+q" }, { name: "a.m", key: "meta+q" }, { name: "a.s", key: "mod+," }, { name: "a.u", key: "shift+mod+z" }], "darwin");
    expect(r.get("a.q")).toEqual({ state: "app", what: "Quit" });
    expect(r.get("a.m")).toEqual({ state: "app", what: "Quit" });
    expect(r.get("a.s")).toEqual({ state: "app", what: "Settings" });
    expect(r.get("a.u")).toEqual({ state: "app", what: "Redo" });
  });
  test("macOS-only chords are free elsewhere", () => {
    expect(resolveKeys([{ name: "a.h", key: "mod+h" }], "darwin").get("a.h")).toEqual({ state: "app", what: "Hide" });
    expect(resolveKeys([{ name: "a.h", key: "mod+h" }], "win32").get("a.h")).toEqual({ state: "bound", chord: "ctrl+h" });
  });
  test("every app chord reserves itself", () => {
    for (const a of APP_CHORDS) expect(resolveKeys([{ name: "x.y", key: a.chord }], "darwin").get("x.y")?.state).toBe("app");
    expect(appChords("linux").has("ctrl+q")).toBe(true);
  });
  test("two commands on one chord: neither is bound, each names the other", () => {
    const r = resolveKeys([{ name: "a.go", key: "mod+k" }, { name: "b.go", key: "meta+k" }, { name: "c.go", key: "mod+j" }], "darwin");
    expect(r.get("a.go")).toEqual({ state: "clash", with: ["b.go"] });
    expect(r.get("b.go")).toEqual({ state: "clash", with: ["a.go"] });
    expect(r.get("c.go")).toEqual({ state: "bound", chord: "meta+j" });
  });
  test("on macOS alt alone types a character, so alt+letter and alt+shift+letter are not bindable; elsewhere alt is a real modifier", () => {
    const mac = resolveKeys([{ name: "a.e", key: "alt+e" }, { name: "a.s", key: "alt+shift+k" }, { name: "a.c", key: "ctrl+alt+e" }, { name: "a.m", key: "meta+alt+e" }, { name: "a.f", key: "alt+f6" }], "darwin");
    expect(mac.get("a.e")).toEqual({ state: "bare" });
    expect(mac.get("a.s")).toEqual({ state: "bare" });
    expect(mac.get("a.c")).toEqual({ state: "bound", chord: "ctrl+alt+e" });
    expect(mac.get("a.m")).toEqual({ state: "bound", chord: "alt+meta+e" });
    expect(mac.get("a.f")).toEqual({ state: "bound", chord: "alt+f6" });
    for (const platform of ["win32", "linux"] as const) {
      expect(resolveKeys([{ name: "a.e", key: "alt+e" }], platform).get("a.e")).toEqual({ state: "bound", chord: "alt+e" });
    }
  });
  test("the window's own reload, developer-tools, zoom and full-screen chords are the app's", () => {
    const r = resolveKeys([{ name: "a.r", key: "f5" }, { name: "a.d", key: "ctrl+shift+i" }, { name: "a.z", key: "mod+=" }, { name: "a.fs", key: "f11" }], "win32");
    expect(r.get("a.r")).toEqual({ state: "app", what: "Reload" });
    expect(r.get("a.d")).toEqual({ state: "app", what: "Developer tools" });
    expect(r.get("a.z")).toEqual({ state: "app", what: "Zoom in" });
    expect(r.get("a.fs")).toEqual({ state: "app", what: "Full screen" });
  });
  test("a chord that would take typing is not bound; a function key is", () => {
    const r = resolveKeys([{ name: "a.k", key: "k" }, { name: "a.e", key: "enter" }, { name: "a.s", key: "shift+a" }, { name: "a.f", key: "f6" }, { name: "a.sf", key: "shift+f6" }], "linux");
    expect(r.get("a.k")).toEqual({ state: "bare" });
    expect(r.get("a.e")).toEqual({ state: "bare" });
    expect(r.get("a.s")).toEqual({ state: "bare" });
    expect(r.get("a.f")).toEqual({ state: "bound", chord: "f6" });
    expect(r.get("a.sf")).toEqual({ state: "bound", chord: "shift+f6" });
  });
});
