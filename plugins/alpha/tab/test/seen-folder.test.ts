import { describe, expect, test } from "bun:test";
import { localDay, seenFolder } from "../../client/seen";

describe("what Alpha has seen of her conversation, folded one event at a time", () => {
  test("a tool, its result, a reply and a card fold as they arrive, and an event that changes nothing says so", () => {
    const f = seenFolder();
    expect(f.take({ type: "tool_call", name: "Read", argsJson: JSON.stringify({ file_path: "/a/b/c.txt" }) })).toBe(true);
    expect(f.seen().tool).toEqual({ name: "read", detail: "b/c.txt", status: "running" });
    expect(f.take({ type: "tool_result", isError: false, fileDiff: { x: 1 } })).toBe(true);
    expect(f.seen()).toMatchObject({ tools: 1, files: 1, tool: { status: "done" } });
    expect(f.take({ type: "assistant_message", text: "hi" })).toBe(true);
    expect(f.seen().replies).toBe(1);
    expect(f.take({ type: "card_requested", card: { id: "c1" } })).toBe(true);
    expect(f.seen().waiting).toBe(true);
    expect(f.take({ type: "card_resolved", cardId: "c1" })).toBe(true);
    expect(f.seen().waiting).toBe(false);
    // Events she shows nothing for draw nothing.
    expect(f.take({ type: "text_delta", text: "x" })).toBe(false);
    expect(f.take({ type: "turn_completed" })).toBe(false);
  });

  test("a long conversation folds to the same as it would whole, one fold per event", () => {
    const f = seenFolder();
    for (let i = 0; i < 500; i++) f.take(i % 2 === 0 ? { type: "assistant_message" } : { type: "tool_call", name: "bash", argsJson: "{}" });
    expect(f.seen()).toMatchObject({ replies: 250, tools: 250 });
  });

  test("the day's tally counts today's events by their own time, and a file she wrote counts without a diff on its result", () => {
    const noon = new Date(2026, 10, 12, 12, 0, 0).getTime();
    const f = seenFolder(() => noon);
    const yesterday = noon - 24 * 3600_000;
    f.take({ type: "assistant_message", ts: yesterday });
    f.take({ type: "tool_call", name: "Write", ts: yesterday, argsJson: JSON.stringify({ file_path: "/a/old.txt" }) });
    expect(f.seen().today).toEqual({ replies: 0, tools: 0, files: 0 });
    f.take({ type: "assistant_message", ts: noon - 1000 });
    f.take({ type: "tool_call", name: "Write", ts: noon - 900, argsJson: JSON.stringify({ file_path: "/a/new.txt" }) });
    f.take({ type: "tool_call", name: "Edit", ts: noon - 800, argsJson: JSON.stringify({ file_path: "/a/new.txt" }) });
    f.take({ type: "tool_call", name: "mcp__fs__write", ts: noon - 700, argsJson: JSON.stringify({ file_path: "/a/other.txt" }) });
    f.take({ type: "tool_call", name: "Read", ts: noon - 600, argsJson: JSON.stringify({ file_path: "/a/read.txt" }) });
    expect(f.seen().today).toEqual({ replies: 1, tools: 4, files: 2 });
    expect(f.seen()).toMatchObject({ replies: 2, tools: 5 });
    expect(localDay(noon)).toBe("2026-11-12");
  });
});
