import { describe, expect, test } from "bun:test";
import { afterContentChange, distanceFromBottom, FOLLOW_THRESHOLD_PX, isAtBottom } from "../client/follow";
import { basename, clip, dayKey, dayLabel, firstLine, formatDuration, formatTime, hostOf, minutesUntil } from "../client/format";
import { buildTimeline, streamingText } from "../client/timeline";
import { formOf, runStatus, sharedComputer, splitPluginTool, stretches, toolFragment, toolSentence } from "../client/tool-phrases";
import type { ConversationItem, ToolCall } from "../client/types";
import { at, bot, FORMAT, NOW, note, thinking, tool, user } from "../gallery/fixtures";

const call = (name: string, extra: Partial<ToolCall> = {}): ToolCall => ({ callId: `${name}-${Math.random()}`, name, status: "succeeded", ...extra });

describe("format", () => {
  test("times and days read in the pinned zone", () => {
    expect(formatTime(at(0, 9, 5), FORMAT)).toBe("9:05 AM");
    expect(dayKey(at(0, 23, 59), FORMAT)).toBe("2026-11-05");
    expect(dayKey(at(1, 0, 0), FORMAT)).toBe("2026-11-06");
  });

  test("day labels say today, yesterday, then the date, with the year only when it differs", () => {
    expect(dayLabel(at(0, 8, 0), NOW, FORMAT)).toBe("Today");
    expect(dayLabel(at(-1, 8, 0), NOW, FORMAT)).toBe("Yesterday");
    expect(dayLabel(at(-2, 8, 0), NOW, FORMAT)).toBe("Tuesday, November 3");
    expect(dayLabel(Date.UTC(2025, 11, 31, 12), NOW, FORMAT)).toBe("Wednesday, December 31, 2025");
  });

  test("durations", () => {
    expect(formatDuration(200)).toBe("1s");
    expect(formatDuration(4_200)).toBe("4s");
    expect(formatDuration(12 * 60_000)).toBe("12 min");
    expect(formatDuration(60 * 60_000)).toBe("1 h");
    expect(formatDuration(65 * 60_000)).toBe("1 h 5 min");
  });

  test("minutes until a deadline round up and never go below zero", () => {
    expect(minutesUntil(NOW + 9 * 60_000 + 1, NOW)).toBe(10);
    expect(minutesUntil(NOW + 60_000, NOW)).toBe(1);
    expect(minutesUntil(NOW - 60_000, NOW)).toBe(0);
  });

  test("paths, hosts, clipping, first lines", () => {
    expect(basename("home/Studio/projects/a.ts")).toBe("a.ts");
    expect(basename("C:\\Users\\me\\b.txt")).toBe("b.txt");
    expect(basename("home/Studio/")).toBe("Studio");
    expect(hostOf("https://www.electronjs.org/docs")).toBe("www.electronjs.org");
    expect(hostOf("not a url")).toBe("not a url");
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
    expect(firstLine("\n\n  error: boom \nmore")).toBe("error: boom");
  });
});

describe("tool phrases", () => {
  test("core tools, shipped tools, plugin tools and unknown names", () => {
    expect(toolFragment("Bash", 1)).toBe("ran a command");
    expect(toolFragment("Bash", 3)).toBe("ran 3 commands");
    expect(toolFragment("Read", 2)).toBe("read 2 files");
    expect(toolFragment("Glob", 1)).toBe("looked for files");
    expect(toolFragment("Grep", 4)).toBe("searched files 4 times");
    expect(toolFragment("mcp__clover__WebSearch", 2)).toBe("searched the web 2 times");
    expect(toolFragment("mcp__blender__Render", 1)).toBe("used Render (blender)");
    expect(toolFragment("mcp__mcp-figma__Export", 2)).toBe("used Export (mcp-figma) 2 times");
    expect(toolFragment("Mystery", 1)).toBe("used Mystery");
  });

  test("a run reads as one sentence, stretch by stretch", () => {
    const calls = [call("Read"), call("Read"), call("Glob"), call("Bash"), call("Bash"), call("Bash"), call("Read")];
    expect(stretches(calls).map((s) => [s.name, s.calls.length])).toEqual([
      ["Read", 2], ["Glob", 1], ["Bash", 3], ["Read", 1],
    ]);
    expect(toolSentence(calls)).toBe("Read 2 files, looked for files, and 4 more");
  });

  test("a call still going reads in the present, a held one as waiting; done ones stay past", () => {
    expect(formOf("running")).toBe("doing");
    expect(formOf("waiting")).toBe("waiting");
    expect(formOf("failed")).toBe("done");
    expect(toolFragment("Bash", 1, "doing")).toBe("running a command");
    expect(toolFragment("Bash", 1, "waiting")).toBe("waiting to run a command");
    expect(toolFragment("Edit", 2, "doing")).toBe("making 2 edits");
    expect(toolFragment("mcp__clover__WebSearch", 1, "doing")).toBe("searching the web");
    expect(toolFragment("mcp__blender__Render", 1, "waiting")).toBe("waiting to use Render (blender)");
    expect(toolSentence([call("Bash"), call("Bash"), call("Bash", { status: "running" })])).toBe("Ran 2 commands and running a command");
    expect(toolSentence([call("Bash", { status: "waiting" })])).toBe("Waiting to run a command");
    expect(toolSentence([call("Edit"), call("Bash", { status: "interrupted" })])).toBe("Made an edit and stopped running a command");
  });

  test("a run's status: still going outranks failed outranks interrupted", () => {
    expect(runStatus([call("Bash"), call("Bash", { status: "failed" }), call("Bash", { status: "running" })])).toBe("running");
    expect(runStatus([call("Bash", { status: "running" }), call("Bash", { status: "waiting" })])).toBe("waiting");
    expect(runStatus([call("Bash", { status: "interrupted" }), call("Bash", { status: "failed" })])).toBe("failed");
    expect(runStatus([call("Bash", { status: "interrupted" }), call("Bash")])).toBe("interrupted");
    expect(runStatus([call("Bash")])).toBe("succeeded");
  });

  test("a shared computer only when every call names the same one", () => {
    expect(sharedComputer([call("Bash", { computer: "Studio" }), call("Read", { computer: "Studio" })])).toBe("Studio");
    expect(sharedComputer([call("Bash", { computer: "Studio" }), call("Read", { computer: "Laptop" })])).toBeUndefined();
    expect(sharedComputer([call("Bash"), call("Read")])).toBeUndefined();
    expect(splitPluginTool("Bash")).toBeNull();
  });
});

describe("timeline", () => {
  test("consecutive tool calls fold into one run; anything else breaks it", () => {
    const items: ConversationItem[] = [
      user(at(0, 9, 0), "go"),
      tool(at(0, 9, 0), { name: "Bash" }),
      tool(at(0, 9, 0), { name: "Read" }),
      thinking(at(0, 9, 1)),
      tool(at(0, 9, 1), { name: "Bash" }),
      bot(at(0, 9, 2), "done"),
    ];
    const units = buildTimeline(items, NOW, FORMAT);
    expect(units.map((u) => (u.type === "tools" ? `tools×${u.calls.length}` : u.type === "message" ? u.item.kind : u.type))).toEqual([
      "day", "user", "tools×2", "thinking", "tools×1", "bot",
    ]);
  });

  test("a day divider opens each new day", () => {
    const units = buildTimeline([user(at(-1, 22, 0), "late"), user(at(0, 7, 0), "early"), user(at(0, 8, 0), "again")], NOW, FORMAT);
    expect(units.filter((u) => u.type === "day").map((u) => (u.type === "day" ? u.label : ""))).toEqual(["Yesterday", "Today"]);
  });

  test("only the bot's last word in a stretch of work is final", () => {
    const items: ConversationItem[] = [
      user(at(0, 9, 0), "go"),
      bot(at(0, 9, 0), "first I'll look"),
      tool(at(0, 9, 0), { name: "Bash" }),
      bot(at(0, 9, 1), "a step"),
      bot(at(0, 9, 1), "the answer"),
      note(at(0, 9, 2), "Compacted", { variant: "divider" }),
      user(at(0, 9, 3), "again"),
      bot(at(0, 9, 3), "streaming…", { streaming: true }),
    ];
    const finals = buildTimeline(items, NOW, FORMAT)
      .filter((u) => u.type === "message" && u.item.kind === "bot")
      .map((u) => (u.type === "message" ? [u.item.kind === "bot" ? u.item.text : "", u.final === true] : []));
    expect(finals).toEqual([
      ["first I'll look", false],
      ["a step", false],
      ["the answer", true],
      ["streaming…", false],
    ]);
  });

  test("the streaming text is the last streaming bot message's", () => {
    expect(streamingText([bot(at(0, 1, 0), "a"), bot(at(0, 1, 1), "abc", { streaming: true })])).toBe("abc");
    expect(streamingText([bot(at(0, 1, 0), "a")])).toBeUndefined();
  });
});

describe("following the bottom", () => {
  test("near the bottom counts as at the bottom", () => {
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })).toBe(600);
    expect(isAtBottom({ scrollTop: 600 - FOLLOW_THRESHOLD_PX, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isAtBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
  });

  test("a follower is scrolled down; a reader who scrolled up is offered the way back", () => {
    const up = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    expect(afterContentChange(true, up)).toEqual({ scrollToBottom: true, showJump: false });
    expect(afterContentChange(false, up)).toEqual({ scrollToBottom: false, showJump: true });
    expect(afterContentChange(false, { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toEqual({ scrollToBottom: false, showJump: false });
  });
});

describe("summary lines and days (review items 10 and the run summary)", () => {
  test("past three stretches, the rest count as calls: \"…, and N more\"", () => {
    const calls = [call("Bash"), call("Edit"), call("Edit"), call("Read"), call("Grep"), call("Bash")];
    expect(toolSentence(calls)).toBe("Ran a command, made 2 edits, and 3 more");
    expect(toolSentence([call("Bash"), call("Edit"), call("Read")])).toBe("Ran a command, made an edit, and read a file");
    expect(toolSentence([call("Bash"), call("Edit"), call("Read"), call("Bash")])).toBe("Ran a command, made an edit, and 2 more");
    expect(toolSentence([call("Bash")])).toBe("Ran a command");
  });

  test("an interrupted call never reads as one that ran", () => {
    expect(formOf("interrupted")).toBe("stopped");
    expect(toolSentence([call("Bash", { status: "interrupted" })])).toBe("Stopped running a command");
  });

  test("days only move forward: a late arrival from yesterday stays under today, and no day shows twice", () => {
    const items: ConversationItem[] = [
      user(at(-1, 23, 58), "Before midnight"),
      bot(at(0, 0, 1), "After midnight"),
      user(at(-1, 23, 59), "Late, from yesterday", { late: true }),
      bot(at(0, 0, 2), "Still today"),
    ];
    const units = buildTimeline(items, NOW, FORMAT);
    const days = units.filter((u) => u.type === "day");
    expect(days.map((d) => d.label)).toEqual(["Yesterday", "Today"]);
    const keys = units.map((u) => u.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

