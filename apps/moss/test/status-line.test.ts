// The status line's words (status-line.ts): a table of (state, tool, detail) to a phrase, and what a detail may ever be
// (a file's base name or a site's host; never a path, a command, a query or another argument). Plus the engine's seam:
// a tool call or its result is never a message, so no tool row can be drawn.
import { describe, expect, test } from "bun:test";
import { messageOf } from "../src/main/engine";
import { safeDetail, statusPhrase } from "../src/shared/status-line";
import type { ActivityState } from "@waifucave/moss-protocol";

const row = (state: ActivityState, tool: string | undefined, detail?: string, title?: string) => statusPhrase({ state, ...(tool !== undefined ? { tool } : {}), ...(detail !== undefined ? { detail } : {}), ...(title !== undefined ? { title } : {}) });

describe("statusPhrase", () => {
  const table: [string, ActivityState, string | undefined, string | undefined, string | undefined, string | undefined][] = [
    // [what, state, tool, detail, title, phrase]
    ["thinking", "thinking", undefined, undefined, undefined, "Thinking"],
    ["thinking ignores a tool", "thinking", "Bash", undefined, undefined, "Thinking"],
    ["working, no tool named", "working", undefined, undefined, undefined, "Working"],
    ["a web search", "working", "WebSearch", undefined, undefined, "Searching the web"],
    ["a web search by a plugin's name", "working", "mcp__search__search", undefined, undefined, "Searching the web"],
    ["a fetch with its host", "working", "WebFetch", "example.com", undefined, "Reading example.com"],
    ["a fetch without one", "working", "WebFetch", undefined, undefined, "Reading a page"],
    ["a shell", "working", "Bash", undefined, undefined, "Running commands"],
    ["a file read", "working", "Read", "notes.txt", undefined, "Reading notes.txt"],
    ["a file read, no name", "working", "Read", undefined, undefined, "Reading a file"],
    ["a write", "working", "Write", "plan.md", undefined, "Writing plan.md"],
    ["an edit", "working", "Edit", "plan.md", undefined, "Editing plan.md"],
    ["an edit, no name", "working", "MultiEdit", undefined, undefined, "Editing a file"],
    ["the browser", "working", "mcp__moss__Browser", undefined, undefined, "Using the browser"],
    ["a browser plugin's tool", "working", "mcp__moss_browser__Open", undefined, undefined, "Using the browser"],
    ["computer use", "working", "mcp__opensky__Click", undefined, undefined, "Using the computer"],
    ["a plugin's tool with its title", "working", "mcp__lamp__SetHue", undefined, "Lamp colour", "Using Lamp colour"],
    ["a plugin's tool without one", "working", "mcp__lamp__SetHue", undefined, undefined, "Using SetHue"],
    ["making a bot", "working", "mcp__moss__CreateBot", undefined, undefined, "Making a bot"],
    ["making a routine", "working", "mcp__moss__CreateRoutine", undefined, undefined, "Making a routine"],
    ["memory", "working", "mcp__moss__WriteMemory", undefined, undefined, "Saving to memory"],
    ["anything unknown", "working", "Frobnicate", undefined, undefined, "Working"],
    ["idle shows nothing", "idle", undefined, undefined, undefined, undefined],
    ["asking shows nothing (the card says it)", "asking", "Bash", undefined, undefined, undefined],
    ["stuck shows nothing", "stuck", undefined, undefined, undefined, undefined],
    ["done shows nothing", "done", undefined, undefined, undefined, undefined],
    ["asleep shows nothing", "asleep", undefined, undefined, undefined, undefined],
    ["listening shows nothing", "listening", undefined, undefined, undefined, undefined],
  ];
  for (const [what, state, tool, detail, title, phrase] of table) test(what, () => expect(row(state, tool, detail, title)).toBe(phrase));

  test("a title is one clean line, forty units at most", () => {
    expect(row("working", "mcp__x__T", undefined, "Line\none\u202e\u200b" + "x".repeat(80))?.length).toBeLessThanOrEqual("Using ".length + 40);
    expect(row("working", "mcp__x__T", undefined, "A\nB")).toBe("Using A B");
  });
});

describe("safeDetail: only a base name or a host", () => {
  test("a file's base name, never its folders", () => {
    expect(safeDetail("Read", JSON.stringify({ file_path: "/Users/someone/Documents/Budget 2026.xlsx" }))).toBe("Budget 2026.xlsx");
    expect(safeDetail("Edit", JSON.stringify({ file_path: "C:\\Users\\x\\secret\\plan.md", old_string: "password" }))).toBe("plan.md");
    expect(safeDetail("mcp__fs__read_file", JSON.stringify({ path: "/a/b/c.txt" }))).toBe("c.txt");
  });
  test("a site's host, never its path, query or credentials", () => {
    expect(safeDetail("WebFetch", JSON.stringify({ url: "https://user:pw@www.example.com:8443/a/b?token=abc#x" }))).toBe("example.com");
    expect(safeDetail("WebFetch", JSON.stringify({ url: "not a url" }))).toBeUndefined();
  });
  test("nothing for a command, a query or anything else", () => {
    expect(safeDetail("Bash", JSON.stringify({ command: "cat ~/.ssh/id_rsa" }))).toBeUndefined();
    expect(safeDetail("WebSearch", JSON.stringify({ query: "my medical results" }))).toBeUndefined();
    expect(safeDetail("mcp__lamp__SetHue", JSON.stringify({ path: "/x/y.txt" }))).toBeUndefined();
  });
  test("bad or huge input gives nothing", () => {
    expect(safeDetail("Read", "{")).toBeUndefined();
    expect(safeDetail("Read", "[]")).toBeUndefined();
    expect(safeDetail("Read", JSON.stringify({ file_path: 5 }))).toBeUndefined();
    expect(safeDetail("Read", JSON.stringify({ file_path: "/a/b.txt", pad: "x".repeat(200_001) }))).toBeUndefined();
  });
  test("a phrase made of a detail holds no path separator or query", () => {
    const d = safeDetail("WebFetch", JSON.stringify({ url: "https://example.org/private/path?q=secret" }));
    const p = row("working", "WebFetch", d)!;
    expect(p).toBe("Reading example.org");
    expect(p).not.toMatch(/[/?=]/);
  });
});

describe("no tool row is ever a message", () => {
  test("tool calls, results, reviews and thinking give no message at all", () => {
    const base = { sessionId: "s", ts: 1, seq: 1, threadId: "main" };
    for (const e of [
      { ...base, type: "tool_call", callId: "c", name: "Bash", argsJson: "{\"command\":\"ls\"}" },
      { ...base, type: "tool_result", callId: "c", output: "Used Bash", isError: false },
      { ...base, type: "tool_review", callId: "c" },
      { ...base, type: "tool_review_progress", callId: "c" },
      { ...base, type: "thinking", text: "hm" },
      { ...base, type: "assistant_delta", delta: "Hel" },
    ]) expect(messageOf(e)).toBeUndefined();
    expect(messageOf({ ...base, type: "assistant_message", text: "Done." })).toMatchObject({ from: "bot", text: "Done." });
  });
});
