// A code session's plugin tool calls show what a bot's do (runtime-sdk/tool-display.ts): the tool's declared title on its
// `tool_call` and its successful result's display on its `tool_result`, from the bridge through the driver to the wire.
import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentSession, AgentTurnEnd } from "../../contracts/agent-backend";
import type { SessionRecord, TurnControl } from "../../contracts/session-host";
import { projectRecords } from "../../sessions/wire";
import type { BotMcpServer } from "../../runtime-sdk/turn-loop/servers";
import { AgentDriver } from "../driver";
import { agentPluginTools } from "../plugin-reach";
import { AgentToolDisplays, AGENT_DISPLAYS_MAX } from "../tool-shows";

const PIN = { kind: "note", label: "Pinned", value: "milk, eggs", swatch: "#ffcc00" };
const BRIDGE = "mcp__moss_0123456789abcdef__notes__pin";

describe("AgentToolDisplays", () => {
  test("a title by the call's bridge name; a display taken once, the same input first", () => {
    const s = new AgentToolDisplays();
    s.listed([{ name: "notes__pin", displayTitle: "Pin a note" }, { name: "notes__list" }]);
    expect(s.title(BRIDGE)).toBe("Pin a note");
    expect(s.title(`${BRIDGE} {"text":"x"}`)).toBe("Pin a note");
    expect(s.title("mcp__moss_0123456789abcdef__notes__list")).toBeUndefined();
    expect(s.title("Bash")).toBeUndefined();
    s.put("notes__pin", { text: "a" }, { ...PIN, value: "a" });
    s.put("notes__pin", { text: "b" }, { ...PIN, value: "b" });
    expect(s.take(BRIDGE, { text: "b" })?.value).toBe("b");
    expect(s.take(BRIDGE, { text: "b" })?.value).toBe("a");
    expect(s.take(BRIDGE, { text: "b" })).toBeUndefined();
    // Another agent's title holding the bridge name.
    s.put("notes__pin", {}, PIN);
    expect(s.take("moss.notes__pin", {})).toEqual(PIN);
    for (let i = 0; i < AGENT_DISPLAYS_MAX + 5; i++) s.put("notes__pin", { i }, PIN);
    let n = 0;
    while (s.take(BRIDGE, {}) !== undefined) n++;
    expect(n).toBe(AGENT_DISPLAYS_MAX);
  });
});

describe("the bridge", () => {
  test("a plugin tool's title is on its bridge listing (never listed to the agent), and its successful result's display comes back beside the content", async () => {
    const server: BotMcpServer = {
      server: "notes", plugin: "acme.notes",
      tools: [{ name: "pin", title: "Pin a note", inputSchema: { type: "object" } } as BotMcpServer["tools"][number]],
    };
    let structured: unknown = { ...PIN, extra: "never leaves" };
    let isError = false;
    const tools = agentPluginTools({
      servers: () => [server],
      runner: { run: async () => ({ result: { content: [{ type: "text", text: "pinned" }], isError, structuredContent: structured }, computer: "Studio" }) },
      judge: async (_s, _c, call) => ({ allowed: true, input: call.input }),
      registry: { entries: () => [], get: () => undefined, list: () => [], points: () => [] } as never,
    });
    const session = { id: "s_code", kind: "coding" as const, backend: "moss-code", computer: "Studio", root: "/tmp" };
    const listed = await tools.tools("s_code", session);
    expect(listed.find((t) => t.name === "notes__pin")?.displayTitle).toBe("Pin a note");
    const ctx = { computer: "Studio", origin: "user" as const, session };
    expect(await tools.call("s_code", { callId: "c1", tool: "notes__pin", input: {} }, ctx)).toEqual({ content: [{ type: "text", text: "pinned" }], isError: false, display: PIN });
    // No valid display, or an error: none.
    structured = { kind: "BAD KIND", label: "x", value: "y" };
    expect((await tools.call("s_code", { callId: "c2", tool: "notes__pin", input: {} }, ctx)).display).toBeUndefined();
    structured = PIN;
    isError = true;
    expect((await tools.call("s_code", { callId: "c3", tool: "notes__pin", input: {} }, ctx)).display).toBeUndefined();
  });
});

/** An agent session that emits what it's given on its prompt. */
function scriptedSession(script: AgentEvent[]): AgentSession {
  const fns: ((e: AgentEvent) => void)[] = [];
  return {
    agentSessionId: "a1",
    state: () => "idle" as never,
    prompt: async (): Promise<AgentTurnEnd> => {
      for (const e of script) for (const fn of fns) fn(e);
      return { stopReason: "end_turn", text: "done" } as AgentTurnEnd;
    },
    cancel: async () => {},
    setConfig: async () => {},
    stop: async () => {},
    onPermission: () => {},
    onEvent: (fn) => {
      fns.push(fn);
      return () => void fns.splice(fns.indexOf(fn), 1);
    },
    lastProgressAt: () => Date.now(),
  };
}

describe("the driver and the wire", () => {
  test("the call carries its tool's title and its end the display; the wire shows both as a bot's call does; a failed call and another tool none", async () => {
    const shows = new AgentToolDisplays();
    shows.listed([{ name: "notes__pin", displayTitle: "Pin a note" }]);
    shows.put("notes__pin", { text: "milk" }, PIN);
    const session = scriptedSession([
      { type: "tool_call", id: "t1", kind: "other", title: BRIDGE, status: "pending", rawInput: { text: "milk" } },
      { type: "tool_call_update", id: "t1", status: "completed", output: "pinned" },
      { type: "tool_call", id: "t2", kind: "execute", title: "Bash", status: "pending", rawInput: {} },
      { type: "tool_call_update", id: "t2", status: "completed", output: "ok" },
      { type: "tool_call", id: "t3", kind: "other", title: BRIDGE, status: "pending", rawInput: { text: "x" } },
      { type: "tool_call_update", id: "t3", status: "failed", output: "no" },
    ]);
    const driver = new AgentDriver({ start: async () => session, promptOf: async (i) => ({ text: (i as { text?: string }).text ?? "" }), toolShows: shows, coalesceMs: 0 });
    const recorded: { type: string; [k: string]: unknown }[] = [];
    const ctl = { origin: "user", signal: new AbortController().signal, onFold: () => () => {}, record: (e: { type: string }) => recorded.push(e as never) } as unknown as TurnControl;
    await driver.turn({ from: "user", text: "pin milk", device: "d", sentAt: 1, clientMessageId: "m1" } as never, ctl);
    const records = recorded.map((event, seq) => ({ type: "driver", seq, sessionId: "s_code", ts: 1, event })) as SessionRecord[];
    const wire = projectRecords(records, { kind: "coding" });
    const calls = wire.filter((e) => e.type === "tool_call");
    const results = wire.filter((e) => e.type === "tool_result");
    expect(calls.map((c) => [c.callId, c.name, c.displayTitle])).toEqual([["t1", "mcp__notes__pin", "Pin a note"], ["t2", "Bash", undefined], ["t3", "mcp__notes__pin", "Pin a note"]]);
    expect(results.map((r) => [r.callId, r.display])).toEqual([["t1", PIN], ["t2", undefined], ["t3", undefined]]);
  });

  test("a log's display or title that isn't plain and bounded is cleaned, or left out, on the wire", () => {
    const records = [
      { type: "driver", seq: 0, sessionId: "s", ts: 1, event: { type: "agent_tool_call", id: "a", kind: "other", title: BRIDGE, status: "pending", displayTitle: "Pin‮ a note" } },
      { type: "driver", seq: 1, sessionId: "s", ts: 1, event: { type: "agent_tool_call_update", id: "a", status: "completed", display: { kind: "<b>", label: "x", value: "y" } } },
    ] as SessionRecord[];
    const [call, result] = projectRecords(records, { kind: "coding" });
    expect(call!.displayTitle).toBe("Pin a note");
    expect(result!.display).toBeUndefined();
  });
});

describe("the bridge's Glossary answer", () => {
  test("a loaded skill's words follow the JSON in their tag, unescaped; with none, the JSON alone", async () => {
    const { glossaryResultText } = await import("../bridge/tools");
    expect(glossaryResultText({ results: [], loaded: [] })).toBe(JSON.stringify({ results: [], loaded: [] }, null, 2));
    const text = glossaryResultText({ results: [], loaded: [{ name: "kit:haiku", kind: "skill", text: '<skill name="kit:haiku">\nfive "seven" five\n</skill>' }, { name: "x", found: false }] });
    expect(text).toContain('\n\n<skill name="kit:haiku">\nfive "seven" five\n</skill>');
    expect(JSON.parse(text.slice(0, text.indexOf("\n\n<skill")))).toEqual({ results: [], loaded: [{ name: "kit:haiku", kind: "skill", text: "(below)" }, { name: "x", found: false }] });
  });
});
