import { describe, expect, test } from "bun:test";
import { oneLine, project, readDisplay } from "../client/project";
import { titleFor } from "../client/tool-phrases";

describe("a plugin tool's display", () => {
  test("text only, the swatch only as a hex colour", () => {
    expect(readDisplay({ kind: "scene", label: "Scene", value: "Starry night", swatch: "#1A2B3C" })).toEqual({ kind: "scene", label: "Scene", value: "Starry night", swatch: "#1A2B3C" });
    expect(readDisplay({ kind: "mood", label: "Mood", value: "joy", swatch: "red; background:url(x)" })).toEqual({ kind: "mood", label: "Mood", value: "joy" });
    expect(readDisplay({ kind: "Bad Kind", label: "a", value: "b" })).toBeUndefined();
    expect(readDisplay({ kind: "x", label: "", value: "b" })).toBeUndefined();
    expect(oneLine("a\nb\u0007c", 10)).toBe("a b c");
    expect(oneLine(5, 10)).toBeUndefined();
  });
  test("the events carry it onto the call", () => {
    const { items } = project([
      { type: "tool_call", seq: 1, callId: "c1", name: "mcp__alpha-stage__set_scene", argsJson: "{}", displayTitle: "Change the scene" },
      { type: "tool_result", seq: 2, callId: "c1", output: "Scene: Starry night", display: { kind: "scene", label: "Scene", value: "Starry night" } },
    ] as never);
    const call = (items[0] as { call: { displayTitle?: string; display?: { value: string } } }).call;
    expect(call.displayTitle).toBe("Change the scene");
    expect(call.display?.value).toBe("Starry night");
  });
  test("a third-party plugin's title always carries the plugin's name; only the bot's own plugin shows it alone", () => {
    expect(titleFor({ name: "mcp__tarot__draw", displayTitle: "Read" }, "alpha")).toBe("tarot: Read");
    expect(titleFor({ name: "mcp__tarot__draw", displayTitle: "Bash" }, "alpha")).toBe("tarot: Bash");
    expect(titleFor({ name: "mcp__alpha-stage__set_scene", displayTitle: "Change the scene" }, "alpha")).toBe("Change the scene");
    expect(titleFor({ name: "Read", displayTitle: "Read" }, "alpha")).toBeUndefined();
  });
});
