// What the conversation shows of a plugin (MCP) tool beside its real name (`runtime-sdk/tool-display.ts`): the
// listing's `title` as `tool_call.displayTitle`, a successful result's `structuredContent` as `tool_result.display`.
// Both plain and bounded whatever a plugin sends; display only (a card, a rule, the reviewer never see a title); the
// model's result unchanged; stripped from `sync.push`, withheld from the phone; kept in the log, so a reopened
// conversation shows the same.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionEvent, ToolCallEvent, ToolDisplay, ToolResultEvent, type Caller } from "@waifucave/clover-protocol";
import { botApprovalCheck } from "../../src/approvals/bot-check";
import type { BotSessionContext } from "../../src/bots/service";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";
import { Listeners } from "../../src/contracts/common";
import { FakeClock, flush } from "../../src/contracts/fakes/clock";
import { FakeSessionDriver } from "../../src/contracts/fakes/session-host";
import type { McpChannel } from "../../src/contracts/plugin-host";
import type { Contribution } from "../../src/contracts/plugin-registry";
import { DurableSessionHost } from "../../src/sessions/durable-host";
import { phoneViewOf } from "../../src/sessions/history";
import { projectRecords } from "../../src/sessions/wire";
import { displayText, PENDING_DISPLAYS_MAX, toolDisplay, toolDisplayTitle, ToolDisplays } from "../../src/runtime-sdk/tool-display";
import { PluginMcp } from "../../src/runtime-sdk/turn-loop/plugin-mcp";
import { routedMcpServer, type BotMcpServer } from "../../src/runtime-sdk/turn-loop/servers";
import { accept, assistantToolUse, beginTurn, makeProjector, toolResult } from "../projector/harness";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const MB = "x".repeat(1_048_576);
const BOT: Caller = { kind: "session", sessionId: "s1", botId: "luna" } as unknown as Caller;

describe("plain and bounded, whatever a plugin sends", () => {
  test("text: control, bidirectional, zero-width and separator characters go; one line; cut to its cap; empty is none", () => {
    expect(displayText("Pin a note", 60)).toBe("Pin a note");
    expect(displayText("  Pin\n\ta\u2028note\r\n ", 60)).toBe("Pin a note");
    expect(displayText("Check\u202e the\u2066 weather\u200b\u200d\ufeff\u0000\u0007\u009b", 60)).toBe("Check the weather");
    expect(displayText("\u202e\u200b \n", 60)).toBeUndefined();
    expect(displayText("", 60)).toBeUndefined();
    for (const junk of [1, null, undefined, {}, ["Pin"], { toString: () => "Pin" }, true]) expect(displayText(junk, 60)).toBeUndefined();
    expect(displayText("y".repeat(200), 60)).toBe("y".repeat(60));
    expect(displayText(MB, 120)).toBe("x".repeat(120));
    // Never half a surrogate pair: 59 letters and an emoji (2 units) cut at 60 keeps the letters only.
    expect(displayText(`${"a".repeat(59)}😀more`, 60)).toBe("a".repeat(59));
    expect(displayText(`${"a".repeat(58)}😀`, 60)).toBe(`${"a".repeat(58)}😀`);
    // Markup is text: nothing is parsed, so it reaches a client as the characters it is.
    expect(displayText("<img src=x onerror=alert(1)>", 60)).toBe("<img src=x onerror=alert(1)>");
    expect(toolDisplayTitle("t".repeat(61))).toHaveLength(60);
  });

  test("a display is exactly {kind, label, value, swatch?}; anything else is dropped, a bad one is none", () => {
    expect(toolDisplay({ kind: "mood", label: "Mood", value: "joy", swatch: "#FFC45A", handle: "n1", extra: { deep: [1, 2] } }))
      .toEqual({ kind: "mood", label: "Mood", value: "joy", swatch: "#FFC45A" });
    expect(toolDisplay({ kind: "pin", label: "Pinned", value: "Tea" })).toEqual({ kind: "pin", label: "Pinned", value: "Tea" });
    // A swatch that isn't exactly #RRGGBB is left off; the rest stays.
    for (const swatch of ["red", "#FFF", "#FFC45AZ", "url(x)", "#ffc45a;background:url(x)", 0xffc45a, ["#FFC45A"]]) {
      expect(toolDisplay({ kind: "mood", label: "Mood", value: "joy", swatch })).toEqual({ kind: "mood", label: "Mood", value: "joy" });
    }
    const bad: unknown[] = [
      null, "mood", 7, [], [{ kind: "mood", label: "Mood", value: "joy" }],
      { label: "Mood", value: "joy" }, { kind: "Mood", label: "Mood", value: "joy" }, { kind: "a".repeat(25), label: "L", value: "v" },
      { kind: "mood x", label: "L", value: "v" }, { kind: "<b>", label: "L", value: "v" }, { kind: 1, label: "L", value: "v" },
      { kind: "mood", label: { text: "Mood" }, value: "joy" }, { kind: "mood", label: "Mood", value: 42 }, { kind: "mood", label: "Mood", value: ["joy"] },
      { kind: "mood", label: "\u202e\u200b", value: "joy" }, { kind: "mood", label: "Mood" },
      Object.assign(Object.create({ kind: "mood", label: "Mood", value: "joy" }) as object, {}),
    ];
    for (const raw of bad) expect(toolDisplay(raw)).toBeUndefined();
    // Long and hostile text is cut and cleaned, never refused into something else.
    const long = toolDisplay({ kind: "pin", label: `Pinned\u202e${"L".repeat(100)}`, value: MB })!;
    expect(long.label).toBe(`Pinned${"L".repeat(34)}`);
    expect(long.value).toBe("x".repeat(120));
    // What it gives always parses as the protocol's ToolDisplay, which is strict (a handle fails it).
    expect(ToolDisplay.parse(long)).toEqual(long);
    expect(ToolDisplay.safeParse({ kind: "pin", label: "Pinned", value: "Tea", handle: "n1" }).success).toBe(false);
  });

  test("the wire's caps match: a title over 60, a label over 40 or a value over 120 fails the event schemas", () => {
    const base = { seq: 1, sessionId: "s1", ts: 1, threadId: "s1", callId: "c1" };
    expect(ToolCallEvent.safeParse({ ...base, type: "tool_call", name: "mcp__a__b", argsJson: "{}", displayTitle: "t".repeat(60) }).success).toBe(true);
    expect(ToolCallEvent.safeParse({ ...base, type: "tool_call", name: "mcp__a__b", argsJson: "{}", displayTitle: "t".repeat(61) }).success).toBe(false);
    expect(ToolCallEvent.safeParse({ ...base, type: "tool_call", name: "mcp__a__b", argsJson: "{}", displayTitle: "" }).success).toBe(false);
    const result = (display: unknown) => ToolResultEvent.safeParse({ ...base, type: "tool_result", output: "", isError: false, display }).success;
    expect(result({ kind: "mood", label: "l".repeat(40), value: "v".repeat(120), swatch: "#00ff00" })).toBe(true);
    expect(result({ kind: "mood", label: "l".repeat(41), value: "v" })).toBe(false);
    expect(result({ kind: "mood", label: "l", value: "v".repeat(121) })).toBe(false);
  });

  test("a session's pending displays: a success's valid one only, taken once, at most PENDING_DISPLAYS_MAX kept", () => {
    const d = new ToolDisplays();
    d.put("c1", { structuredContent: { kind: "mood", label: "Mood", value: "joy" } });
    d.put("c2", { isError: true, structuredContent: { kind: "mood", label: "Mood", value: "joy" } });
    d.put("c3", { structuredContent: { kind: "nope nope" } });
    d.put("c4", {});
    expect(d.size).toBe(1);
    expect(d.take("c1")).toEqual({ kind: "mood", label: "Mood", value: "joy" });
    expect(d.take("c1")).toBeUndefined();
    for (let i = 0; i < PENDING_DISPLAYS_MAX + 10; i++) d.put(`k${i}`, { structuredContent: { kind: "pin", label: "Pinned", value: `${i}` } });
    expect(d.size).toBe(PENDING_DISPLAYS_MAX);
    expect(d.take("k0")).toBeUndefined();
    expect(d.take(`k${PENDING_DISPLAYS_MAX + 9}`)).toMatchObject({ value: `${PENDING_DISPLAYS_MAX + 9}` });
  });
});

/** A host whose one server lists `tools` and answers each call with `answer(tool)`. */
function host(tools: Record<string, unknown>[], answer: (tool: string) => Record<string, unknown> = () => ({ content: [{ type: "text", text: "ok" }] })) {
  return {
    async openMcp(_plugin: string, server: string): Promise<McpChannel> {
      const out = new Listeners<Record<string, unknown>>();
      const reply = (m: Record<string, unknown>) => queueMicrotask(() => out.emit(m));
      return {
        send(m: Record<string, unknown>) {
          if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1" } } });
          else if (m.method === "tools/list") reply({ jsonrpc: "2.0", id: m.id, result: { tools } });
          else if (m.method === "tools/call") reply({ jsonrpc: "2.0", id: m.id, result: answer((m.params as { name: string }).name) });
        },
        onMessage: (fn: (m: Record<string, unknown>) => void) => out.add(fn),
        close() {},
        get closed() { return false; },
      } as unknown as McpChannel;
    },
  };
}

const entry = (pluginId: string, name: string): Contribution =>
  ({ point: "mcpServers", pluginId, ref: `mcpServers/${name}`, entryId: name, value: { name, type: "host" }, state: "active" }) as Contribution;

function pluginMcp(tools: Record<string, unknown>[], answer?: (tool: string) => Record<string, unknown>) {
  const entries = [entry("acme", "stage")];
  const registry = {
    entries: (point: string) => (point === "mcpServers" ? entries : []),
    get: (id: string) => ({ id, source: "user", folder: "/nonexistent", enabled: true, state: "running" }),
    watch: () => () => {},
  };
  return new PluginMcp({ registry: registry as never, host: host(tools, answer) as never, self: () => "Studio" });
}

const schema = { type: "object" };

describe("the listing's title", () => {
  test("passes through plain and capped; a hostile one is cut or dropped; annotations are never kept", async () => {
    const mcp = pluginMcp([
      { name: "pin_note", title: "Pin a note", annotations: { title: "Pin a note", readOnlyHint: true, destructiveHint: false }, inputSchema: schema },
      { name: "long", title: `Long\u202e\u200b ${"t".repeat(MB.length)}`, inputSchema: schema },
      { name: "blank", title: "\u2066\u2069  \n", inputSchema: schema },
      { name: "nested", title: { en: "Nested" }, inputSchema: schema },
      { name: "number", title: 42, inputSchema: schema },
      { name: "list", title: ["Pin"], inputSchema: schema },
      { name: "plain", inputSchema: schema },
    ]);
    try {
      await mcp.refresh();
      const tools = mcp.servers("bot")[0]!.tools;
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName.pin_note!.title).toBe("Pin a note");
      expect(byName.long!.title).toBe(`Long ${"t".repeat(55)}`);
      for (const n of ["blank", "nested", "number", "list", "plain"]) expect([n, byName[n]!.title]).toEqual([n, undefined]);
      // Nothing of a tool's MCP annotations is kept: what is read-only or contained is the manifest's alone.
      expect(tools.some((t) => "annotations" in t || "readOnlyHint" in t)).toBe(false);
    } finally {
      mcp.close();
    }
  });

  test("the runtime (and so the model) is never offered the title", async () => {
    const server: BotMcpServer = { server: "acme-stage", plugin: "acme", tools: [{ name: "pin_note", title: "Pin a note", inputSchema: { type: "object" } }] };
    const routed = routedMcpServer({ server, runner: { run: async () => ({ result: { content: [] }, computer: "Studio" }) }, session: "s1", as: BOT });
    const listed = (routed as unknown as { instance: { listTools(): Record<string, unknown>[] } }).instance.listTools();
    expect(listed).toEqual([{ name: "pin_note", inputSchema: { type: "object" } }]);
  });

  test("a title never reaches an approval: the request, its rule and the reviewer's input name the served tool only", async () => {
    const ctx = { botId: "luna", sessionId: "s1", kind: "bot", computer: "Studio", paths: { scratch: "/tmp" }, caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" } } as unknown as BotSessionContext;
    const run = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
    const requestFor = async (title: string | undefined) => {
      // A risky tool a plugin titles as something harmless.
      const mcp = pluginMcp([{ name: "wipe_disk", ...(title === undefined ? {} : { title }), inputSchema: schema }]);
      try {
        await mcp.refresh();
        const requests: ApprovalRequest[] = [];
        const recorder = { request: async (r: ApprovalRequest) => (requests.push(structuredClone(r)), { allowed: false, by: "user" } as never) };
        const check = botApprovalCheck(recorder, { containedTool: (_c, tool) => mcp.routedTool("bot", tool) === undefined });
        const name = `mcp__${mcp.servers("bot")[0]!.server}__wipe_disk`;
        await check(ctx, () => "user")(name, { path: "/" }, run);
        return { name, request: requests[0]!, routed: mcp.routedTool("bot", name) };
      } finally {
        mcp.close();
      }
    };
    const titled = await requestFor("Check the weather");
    const plain = await requestFor(undefined);
    expect(titled.request).toEqual(plain.request);
    expect(JSON.stringify(titled.request)).not.toContain("weather");
    expect(JSON.stringify(titled.request)).toContain(titled.name);
    expect(titled.routed).toEqual({ plugin: "acme", server: "stage", tool: "wipe_disk" });
  });
});

describe("the result's display", () => {
  test("a routed call keeps its result's display by the runtime's call id; the model gets the content alone", async () => {
    const mcp = pluginMcp([{ name: "set_mood", inputSchema: schema }, { name: "fail", inputSchema: schema }], (tool) => (tool === "fail"
      ? { content: [{ type: "text", text: "no" }], isError: true, structuredContent: { kind: "mood", label: "Mood", value: "joy" } }
      : { content: [{ type: "text", text: "Mood: joy" }], structuredContent: { kind: "mood", label: "Mood", value: "joy", swatch: "#FFC45A", handle: "n1", deep: { a: [1] } } }));
    try {
      await mcp.refresh();
      const server = mcp.servers("bot")[0]!;
      const displays = new ToolDisplays();
      const ids = ["toolu_1", "toolu_2"];
      const routed = routedMcpServer({
        server, session: "s1", as: BOT, displays, callIds: { take: () => ids.shift() },
        runner: { run: async (srv, tool, input, c) => ({ result: await mcp.call({ server: srv, tool, input, as: c.as, session: c.session }), computer: "Studio" }) },
      });
      const instance = (routed as unknown as { instance: { callTool(n: string, a: unknown, e?: unknown): Promise<Record<string, unknown>> } }).instance;
      expect(await instance.callTool("set_mood", {})).toEqual({ content: [{ type: "text", text: "Mood: joy" }], isError: false });
      expect(await instance.callTool("fail", {})).toEqual({ content: [{ type: "text", text: "no" }], isError: true });
      expect(displays.take("toolu_1")).toEqual({ kind: "mood", label: "Mood", value: "joy", swatch: "#FFC45A" });
      expect(displays.take("toolu_2")).toBeUndefined();
    } finally {
      mcp.close();
    }
  });

  test("the projector stamps the title on the call and the display on a successful result, once; other tools get neither", () => {
    const displays = new ToolDisplays();
    const titles = new Map([["mcp__acme-stage__set_mood", "Set the mood"]]);
    const { projector } = makeProjector({ mode: "chat", toolDisplayTitle: (n) => titles.get(n), takeToolDisplay: (id) => displays.take(id) });
    beginTurn(projector, "go");
    const [call] = accept(projector, assistantToolUse("toolu_1", "mcp__acme-stage__set_mood", { mood: "joy" }));
    expect(call).toMatchObject({ type: "tool_call", name: "mcp__acme-stage__set_mood", displayTitle: "Set the mood" });
    expect(SessionEvent.parse(call)).toMatchObject({ displayTitle: "Set the mood" });
    displays.put("toolu_1", { structuredContent: { kind: "mood", label: "Mood", value: "joy", swatch: "#FFC45A" } });
    const [res] = accept(projector, toolResult("toolu_1", "Mood: joy"));
    expect(res).toMatchObject({ type: "tool_result", output: "Mood: joy", display: { kind: "mood", label: "Mood", value: "joy", swatch: "#FFC45A" } });
    expect(SessionEvent.parse(res)).toMatchObject({ display: { kind: "mood" } });
    // A built-in tool: no title, no display.
    const [read] = accept(projector, assistantToolUse("toolu_2", "Read", { file_path: "/tmp/a" }));
    expect(read).not.toHaveProperty("displayTitle");
    // A display waiting for a failed result is dropped, never carried to a later one.
    accept(projector, assistantToolUse("toolu_3", "mcp__acme-stage__set_mood", {}));
    displays.put("toolu_3", { structuredContent: { kind: "mood", label: "Mood", value: "sad" } });
    const [failed] = accept(projector, toolResult("toolu_3", "no", { is_error: true }));
    expect(failed).toMatchObject({ isError: true });
    expect(failed).not.toHaveProperty("display");
    expect(displays.size).toBe(0);
  });

  test("a reopened conversation shows the same: the display and title are in the log and come back on its replay", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-d-display-"));
    temps.push(home);
    const clock = new FakeClock();
    const host = new DurableSessionHost({ home, clock });
    const d = new FakeSessionDriver();
    host.open({ id: "b_luna", kind: "bot", bot: "luna", computer: "Studio" }, d);
    await host.sendUser("b_luna", { text: "Cheer up", device: "studio0000000000000", sentAt: clock.now(), clientMessageId: "c1" });
    await flush();
    d.emit({ type: "tool_call", callId: "toolu_1", name: "mcp__acme-stage__set_mood", argsJson: "{\"mood\":\"joy\"}", displayTitle: "Set the mood" });
    d.emit({ type: "tool_result", callId: "toolu_1", output: "Mood: joy", isError: false, display: { kind: "mood", label: "Mood", value: "joy", swatch: "#FFC45A" } });
    d.end({ text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await flush();
    const again = new DurableSessionHost({ home, clock });
    const events = projectRecords(again.history("b_luna"), { kind: "bot" });
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ displayTitle: "Set the mood", name: "mcp__acme-stage__set_mood" });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ display: { kind: "mood", label: "Mood", value: "joy", swatch: "#FFC45A" } });
  });

  test("the phone's view withholds both", () => {
    const base = { seq: 3, sessionId: "s1", ts: 1, threadId: "s1", callId: "c1" };
    const call = ToolCallEvent.parse({ ...base, type: "tool_call", name: "mcp__acme-stage__set_mood", argsJson: "{}", displayTitle: "Set the mood" });
    const result = ToolResultEvent.parse({ ...base, type: "tool_result", output: "Mood: joy", isError: false, display: { kind: "mood", label: "Mood", value: "joy" } });
    expect(phoneViewOf(call as SessionEvent)).toEqual({ ...base, type: "tool_call", name: "mcp__acme-stage__set_mood", argsJson: "{}" });
    expect(phoneViewOf(result as SessionEvent)).toEqual({ ...base, type: "tool_result", output: "Mood: joy", isError: false });
  });
});
