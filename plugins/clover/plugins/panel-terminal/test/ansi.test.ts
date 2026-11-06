import { describe, expect, test } from "bun:test";
import { MAX_COLUMNS, MAX_PENDING, nearestHue, Screen } from "../client/ansi";

const text = (s: Screen) => s.view().map((line) => line.map((r) => r.text).join(""));

describe("the terminal's screen model (review S6)", () => {
  test("colours and looks become runs; the escape codes themselves never show", () => {
    const s = new Screen();
    s.write("\x1b[1;32mok\x1b[0m done \x1b[31merror\x1b[39m plain");
    expect(s.view()).toEqual([[{ text: "ok", bold: true, fg: "green" }, { text: " done " }, { text: "error", fg: "red" }, { text: " plain" }]]);
  });

  test("256-colour and true-colour values go to the nearest hue; backgrounds are skipped", () => {
    const s = new Screen();
    s.write("\x1b[38;5;196ma\x1b[38;2;20;200;40mb\x1b[48;5;21;34mc");
    expect(s.view()[0]!.map((r) => [r.text, r.fg])).toEqual([["a", "red"], ["b", "green"], ["c", "blue"]]);
    expect(nearestHue(128, 128, 128)).toBe("white");
  });

  test("a carriage return writes over the line, a backspace steps back, a tab goes to the next stop", () => {
    const s = new Screen();
    s.write("progress 10%\rprogress 99%\r\nab\bc\tx");
    expect(text(s)).toEqual(["progress 99%", "ac      x"]);
  });

  test("erase to the end of the line, and clear the screen", () => {
    const s = new Screen();
    s.write("hello world\r\x1b[5C\x1b[K!");
    expect(text(s)).toEqual(["hello!"]);
    s.write("\r\nmore\x1b[2J\x1b[Hfresh");
    expect(text(s)).toEqual(["fresh"]);
  });

  test("titles, hyperlinks' targets and private modes show nothing, even split across chunks", () => {
    const s = new Screen();
    s.write("\x1b]0;my title\x07a\x1b[?25l\x1b]8;;https://x.example\x1b\\link\x1b]8;;\x1b\\b\x1b[");
    s.write("1mc");
    expect(s.view()[0]!.map((r) => [r.text, r.bold])).toEqual([["alinkb", undefined], ["c", true]]);
  });
  test("a cursor move stops at the line's edge, and text past it wraps (N2)", () => {
    const s = new Screen(80);
    s.write("\x1b[500000Cx");
    expect(text(s)).toEqual([" ".repeat(79) + "x"]);
    s.write("y\x1b[2000000000Gz");
    expect(text(s)).toEqual([" ".repeat(79) + "x", "y".padEnd(79) + "z"]);
    const wide = new Screen();
    wide.write("\x1b[500000Cx");
    expect(text(wide)[0]!.length).toBe(MAX_COLUMNS);
  });

  test("a sequence that never ends is dropped past the cap, and what follows shows (N2)", () => {
    const s = new Screen();
    s.write("\x1b]0;");
    for (let k = 0; k < 10; k += 1) s.write("x".repeat(1000));
    s.write("visible");
    expect(text(s).join("")).toContain("visible");
    const one = new Screen();
    one.write("\x1b]0;" + "y".repeat(MAX_PENDING + 10) + "shown");
    expect(text(one).join("")).toContain("shown");
  });
});
