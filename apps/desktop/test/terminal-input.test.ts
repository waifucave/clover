// What reaches a terminal is the user's (lane J's terminal.write, lane B's TerminalApi.input): a key press the main
// process saw, used once, its bytes from that record; a paste through the paste door, bracketed when the program asked
// and confirmed when it is more than one line.
import { describe, expect, test } from "bun:test";
import { KEY_MATCH_MS, KeyLog, PasteModes, isPasteChord, keyBytes, preparePaste } from "../src/main/terminal-input";

const key = (k: string, mods: Partial<{ control: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) => ({ key: k, code: "", control: false, alt: false, shift: false, meta: false, ...mods });

describe("key presses", () => {
  test("a press the main process saw, in that window, within a second, once", () => {
    let now = 0;
    const log = new KeyLog(() => now);
    log.saw(1, key("a"));
    expect(log.take(2, "a")).toBeUndefined();
    expect(log.take(1, "b")).toBeUndefined();
    expect(log.take(1, "a")?.key).toBe("a");
    expect(log.take(1, "a")).toBeUndefined();
    log.saw(1, key("a"));
    now += KEY_MATCH_MS + 1;
    expect(log.take(1, "a")).toBeUndefined();
  });

  test("its bytes, as an xterm-style terminal sends them; the app's own ⌘ shortcuts send nothing", () => {
    expect(keyBytes(key("a"), "linux")).toBe("a");
    expect(keyBytes(key("A", { shift: true }), "linux")).toBe("A");
    expect(keyBytes(key("c", { control: true }), "darwin")).toBe("\u0003");
    expect(keyBytes(key("b", { alt: true }), "linux")).toBe("\u001bb");
    expect(keyBytes(key("Enter"), "linux")).toBe("\r");
    expect(keyBytes(key("Backspace"), "linux")).toBe("\u007f");
    expect(keyBytes(key("ArrowUp"), "linux")).toBe("\u001b[A");
    expect(keyBytes(key("Tab", { shift: true }), "linux")).toBe("\u001b[Z");
    expect(keyBytes(key("F5"), "win32")).toBe("\u001b[15~");
    expect(keyBytes(key("é"), "linux")).toBe("é");
    expect(keyBytes(key("k", { meta: true }), "darwin")).toBeUndefined();
    expect(keyBytes(key("Shift", { shift: true }), "linux")).toBeUndefined();
  });
});

describe("the paste door", () => {
  test("the chord is the OS's own", () => {
    expect(isPasteChord(key("v", { meta: true }), "darwin")).toBe(true);
    expect(isPasteChord(key("v", { control: true }), "darwin")).toBe(false);
    expect(isPasteChord(key("v", { control: true }), "win32")).toBe(true);
    expect(isPasteChord(key("V", { control: true, shift: true }), "linux")).toBe(true);
    expect(isPasteChord(key("Insert", { shift: true }), "linux")).toBe(true);
    const log = new KeyLog();
    expect(log.takePaste(1, "darwin")).toBe(false);
    log.saw(1, key("v", { meta: true }));
    expect(log.takePaste(1, "darwin")).toBe(true);
    expect(log.takePaste(1, "darwin")).toBe(false);
  });

  test("bracketed when the program turned it on, even across two pieces of output; off again when it says so", () => {
    const modes = new PasteModes();
    expect(modes.bracketed("t")).toBe(false);
    modes.output("t", "prompt \u001b[?20");
    modes.output("t", "04h$ ");
    expect(modes.bracketed("t")).toBe(true);
    modes.output("t", "\u001b[?2004l");
    expect(modes.bracketed("t")).toBe(false);
    modes.output("t", "\u001b[?2004h");
    modes.output("t", "", true);
    expect(modes.bracketed("t")).toBe(false);
  });

  test("whole, its markers taken out so it can't end itself early; more than one line waits for the OK", () => {
    expect(preparePaste("ls", false)).toEqual({ data: "ls", lines: 1, needsOk: false });
    expect(preparePaste("ls\n", false)).toEqual({ data: "ls\r", lines: 1, needsOk: false });
    expect(preparePaste("a\r\nb", true)).toEqual({ data: "\u001b[200~a\rb\u001b[201~", lines: 2, needsOk: true });
    expect(preparePaste("x\u001b[201~rm -rf ~", true).data).toBe("\u001b[200~xrm -rf ~\u001b[201~");
  });
});
