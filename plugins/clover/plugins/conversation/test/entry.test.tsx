// The conversation on the runtime: the core's events projected into the view's items, and the entry that reads them.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { fakeApi, fakeCore, settle } from "../../shell/runtime/testkit";
import type { EntryComponent } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { ConversationEntry } from "../client/entry";
import { project, toolHint, type CoreEvent } from "../client/project";
import { UiRuntimeProvider } from "../client/sdk";
import type { ApprovalItem, BotItem, ToolItem } from "../client/types";

afterEach(cleanup);

let seq = 0;
const ev = (type: string, extra: Record<string, unknown> = {}): CoreEvent => ({ type, seq: ++seq, ts: 1_000 + seq, ...extra });

describe("project", () => {
  test("a turn: the user's message, streamed text, a tool call with its diff, and the answer", () => {
    const p = project([
      ev("user_message", { text: "Fix the dates", device: "dev_studio" }),
      ev("turn_started"),
      ev("assistant_delta", { delta: "Look" }),
      ev("assistant_delta", { delta: "ing." }),
      ev("assistant_message", { text: "Looking." }),
      ev("tool_call", { callId: "c1", name: "Edit", argsJson: JSON.stringify({ file_path: "src/csv.ts" }), computer: "Studio" }),
      ev("tool_result", { callId: "c1", output: "ok", fileDiff: { path: "src/csv.ts", added: 4, removed: 2, diffId: "d1" } }),
      ev("assistant_message", { text: "Fixed." }),
      ev("turn_completed", { stopReason: "end_turn" }),
      ev("session_titled", { title: "CSV dates" }),
    ], { name: (kind, id) => (kind === "device" && id === "dev_studio" ? "Studio" : undefined) });
    expect(p.items.map((i) => i.kind)).toEqual(["user", "bot", "tool", "bot"]);
    expect(p.items[0]).toMatchObject({ text: "Fix the dates", device: { id: "dev_studio", name: "Studio" } });
    expect((p.items[1] as BotItem).text).toBe("Looking.");
    expect((p.items[1] as BotItem).streaming).toBeUndefined();
    expect((p.items[2] as ToolItem).call).toEqual({ callId: "c1", name: "Edit", status: "succeeded", detail: "src/csv.ts", computer: "Studio", output: "ok", diff: { path: "src/csv.ts", added: 4, removed: 2, diffId: "d1" } });
    expect(p.turn).toEqual({ running: false });
    expect(p.title).toBe("CSV dates");
  });

  test("a card: the call waits, the turn waits; approved, the call runs again", () => {
    const pending = [
      ev("turn_started"),
      ev("tool_call", { callId: "c2", name: "Bash", argsJson: JSON.stringify({ command: "git push\n--force" }) }),
      ev("card_pending", { card: { id: "card-1", kind: "tool", computer: "Studio", options: [{ id: "allow", kind: "approve" }, { id: "deny", kind: "deny" }] } }),
    ];
    const waiting = project(pending);
    expect((waiting.items[0] as ToolItem).call).toMatchObject({ status: "waiting", detail: "git push" });
    expect(waiting.items[1]).toMatchObject({ kind: "approval", cardId: "card-1", state: "pending", computer: "Studio", cardKind: "tool" });
    expect(waiting.turn).toEqual({ running: true, phase: "waiting" });
    const approved = project([...pending, ev("card_resolved", { id: "card-1", outcome: "approved", device: "dev_iphone" })], { name: () => "iPhone" });
    expect((approved.items[0] as ToolItem).call.status).toBe("running");
    expect(approved.items[1] as ApprovalItem).toMatchObject({ state: "approved", answeredOn: "iPhone" });
    expect(approved.turn.phase).toBe("working");
    const denied = project([...pending, ev("card_resolved", { id: "card-1", outcome: "denied" })]);
    expect((denied.items[0] as ToolItem).call.status).toBe("interrupted");
  });

  test("an interrupted turn marks the text cut short and the running calls interrupted; an error adds a note", () => {
    const p = project([ev("turn_started"), ev("assistant_delta", { delta: "Half" }), ev("tool_call", { callId: "c3", name: "Read" }), ev("turn_completed", { stopReason: "aborted" })]);
    expect((p.items[0] as BotItem).interrupted).toBe(true);
    expect((p.items[1] as ToolItem).call.status).toBe("interrupted");
    expect(project([ev("turn_started"), ev("turn_completed", { stopReason: "error" })]).items).toMatchObject([{ kind: "note", tone: "error" }]);
  });

  test("questions, reports from bots, agents and plugins, finished agents, routines and notes", () => {
    const p = project([
      ev("question_asked", { callId: "q1", questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B", description: "the second" }], multiSelect: false }] }),
      ev("question_resolved", { callId: "q1", answers: { "Which?": "A" } }),
      ev("bot_message", { from: "luna", text: "Done with the brief." }),
      ev("agent_message", { agent: "agent-1", text: "Halfway." }),
      ev("plugin_message", { from: { pluginId: "tarot-panel" }, text: "The Star", app: { callId: "c9" } }),
      ev("agent_finished", { agent: "agent-1", backend: "Codex", stopReason: "end_turn", text: "All fixed." }),
      ev("routine_result", { routine: "weather", name: "Weather", computer: "Studio", text: "Rain at 3", sideThread: "t1" }),
      ev("note", { from: { kind: "plugin", pluginId: "lint-guard" }, label: "Blocked", text: "a write to package-lock.json" }),
      ev("approval_requested", { toolName: "Bash", summary: "rm -rf build" }),
      ev("approval_resolved", { approved: false }),
      ev("something_new"),
    ], { name: (kind, id) => (({ "bot:luna": "Luna", "agent:agent-1": "Codex", "plugin:tarot-panel": "Tarot panel" }) as Record<string, string>)[`${kind}:${id}`] });
    expect(p.items.map((i) => i.kind)).toEqual(["question", "agent-report", "agent-report", "agent-report", "task-notification", "routine-result", "note", "note", "note"]);
    expect(p.items[0]).toMatchObject({ state: "answered", answers: { "Which?": "A" }, questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B", description: "the second" }], multiSelect: false }] });
    expect(p.items.slice(1, 4).map((i) => (i.kind === "agent-report" ? i.from.name : ""))).toEqual(["Luna", "Codex", "Tarot panel"]);
    expect(p.items[4]).toMatchObject({ status: "completed", report: "All fixed.", task: { kind: "agent", agentId: "agent-1", name: "Codex", backend: "Codex" } });
    expect(p.items[5]).toMatchObject({ status: "succeeded", summary: "Rain at 3", routine: { id: "weather", name: "Weather", computer: "Studio" } });
    expect(p.items.slice(6).map((i) => (i.kind === "note" ? i.text : ""))).toEqual(["Blocked: a write to package-lock.json", "Asked to use Bash: rm -rf build", "Denied"]);
  });

  test("a tool's hint is its command's first line, a path, a URL or a query", () => {
    expect(toolHint(JSON.stringify({ command: "a\nb" }))).toBe("a");
    expect(toolHint(JSON.stringify({ url: "https://x.example" }))).toBe("https://x.example");
    expect(toolHint("not json")).toBeUndefined();
    expect(toolHint(undefined)).toBeUndefined();
  });
});

describe("the conversation entry", () => {
  const HISTORY = [ev("user_message", { text: "Hello there" }), ev("assistant_message", { text: "Hi! What can I do?" })];

  const OLD_PAGES: Record<string, { events: CoreEvent[]; cursor?: string }> = {
    first: { events: [ev("user_message", { text: "From the old app" }), ev("approval_requested", { toolName: "Bash" }), ev("card_pending", { card: "c1" })], cursor: "p2" },
    p2: { events: [ev("assistant_message", { text: "The second page" })], cursor: "p3" },
    p3: { events: [ev("assistant_message", { text: "The last page" })] },
  };

  function mount(extra: { archived?: boolean; entries?: Parameters<typeof runtimeWith>[0]["entries"]; component?: EntryComponent } = {}) {
    let listener: ((e: CoreEvent) => void) | undefined;
    const core = fakeCore({ "archive.history": ({ cursor }) => OLD_PAGES[cursor ?? "first"]! });
    const api = fakeApi({
      bots: { list: async () => [], get: async () => { throw new Error("none"); }, watch: () => () => undefined },
      conversation: {
        list: async () => [],
        history: async () => ({ events: HISTORY, hasMore: false }),
        follow: (_s, l) => {
          listener = l;
          return () => (listener = undefined);
        },
      },
    });
    const runtime = runtimeWith({
      api: () => api,
      core: () => core,
      spot: (name) => (name === "conversation.message" ? { shape: "keyed", keep: ["approval"] } : name === "conversation.message.extra" ? { shape: "list" } : undefined),
      entries: extra.entries ?? [],
      component: () => extra.component,
    });
    render(
      <UiRuntimeProvider runtime={runtime}>
        <ConversationEntry props={{ bot: { id: "alpha", name: "Alpha" }, session: "s_alpha", now: 2_000, ...(extra.archived ? { archived: true } : {}) }} />
      </UiRuntimeProvider>,
    );
    return { core, push: (e: CoreEvent) => listener?.(e) };
  }

  test("reads the history, then follows what comes next", async () => {
    const { push } = mount();
    await act(() => settle());
    expect(screen.getByText("Hello there")).toBeTruthy();
    expect(screen.getByText("Hi! What can I do?")).toBeTruthy();
    act(() => push(ev("user_message", { text: "One more thing" })));
    expect(screen.getByText("One more thing")).toBeTruthy();
  });

  test("a plugin that fills a message kind draws it; the extras spot adds under each message", async () => {
    const Loud: EntryComponent = ({ props, entry }) => <p data-testid={entry.spot}>{entry.spot === "conversation.message" ? `LOUD ${(props.item as { text: string }).text}` : "extra"}</p>;
    mount({
      component: Loud,
      entries: [
        { pluginId: "loud", id: "user", spot: "conversation.message", key: "user", component: "Loud", source: "installed", enabledAt: 1 },
        { pluginId: "extra", id: "x", spot: "conversation.message.extra", component: "Loud", source: "installed", enabledAt: 1 },
      ],
    });
    await act(() => settle());
    expect(screen.getByTestId("conversation.message").textContent).toBe("LOUD Hello there");
    expect(screen.getByText("Hi! What can I do?")).toBeTruthy();
    expect(screen.getAllByTestId("conversation.message.extra").length).toBeGreaterThan(0);
  });

  test("archived: reads the whole old session page by page, its approvals read as notes, and no card of it waits", async () => {
    const { core } = mount({ archived: true });
    await act(() => settle(8));
    expect(core.calls).toEqual([
      { method: "archive.history", params: { id: "s_alpha", limit: 500 } },
      { method: "archive.history", params: { id: "s_alpha", limit: 500, cursor: "p2" } },
      { method: "archive.history", params: { id: "s_alpha", limit: 500, cursor: "p3" } },
    ]);
    expect(screen.getByText("From the old app")).toBeTruthy();
    expect(screen.getByText("Asked to use Bash")).toBeTruthy();
    expect(screen.getByText("The last page")).toBeTruthy();
    expect(screen.queryByText("Hello there")).toBeNull();
    expect(document.querySelector(".cl-conv-card, [data-card]")).toBeNull();
  });

  test("archived: no add-on spot sees an old session; only the view's own renderers draw it (S3)", async () => {
    const Spy: EntryComponent = ({ entry }) => <p data-testid={`spy-${entry.spot}`}>spy</p>;
    mount({
      archived: true,
      component: Spy,
      entries: [
        { pluginId: "spy", id: "user", spot: "conversation.message", key: "user", component: "Spy", source: "installed", enabledAt: 1 },
        { pluginId: "spy", id: "x", spot: "conversation.message.extra", component: "Spy", source: "installed", enabledAt: 1 },
        { pluginId: "spy", id: "t", spot: "tool.result", component: "Spy", source: "installed", enabledAt: 1 },
      ],
    });
    await act(() => settle(8));
    expect(screen.getByText("From the old app")).toBeTruthy();
    expect(screen.queryAllByText("spy")).toEqual([]);
  });
});
