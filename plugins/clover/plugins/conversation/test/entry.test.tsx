// The conversation on the runtime: the core's events projected into the view's items, and the entry that reads them.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { card, fakeApi, fakeCore, settle } from "../../shell/runtime/testkit";
import type { EntryComponent } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import type { CardMeta } from "../../shell/runtime/types";
import { mockSealed } from "../gallery/mock-runtime";
import { ConversationEntry } from "../client/entry";
import { project, toolHint, type CoreEvent } from "../client/project";
import { UiRuntimeProvider } from "../client/sdk";
import type { ApprovalItem, BotItem, ToolItem } from "../client/types";

afterEach(cleanup);

let seq = 0;
const ev = (type: string, extra: Record<string, unknown> = {}): CoreEvent => ({ type, seq: ++seq, ts: 1_000 + seq, ...extra });

describe("project", () => {
  test("a call the core cut off (a stop, a restart) reads as interrupted, not failed, and nothing runs after the turn's end", () => {
    const p = project([
      ev("user_message", { text: "Use the tool", device: "dev_studio" }),
      ev("turn_started"),
      ev("tool_call", { callId: "c1", name: "Echo", argsJson: "{}" }),
      ev("tool_result", { callId: "c1", output: "Interrupted: Clover stopped while this call ran.", isError: true, interrupted: true }),
      ev("turn_completed", { stopReason: "aborted" }),
    ]);
    const call = p.items.find((i): i is ToolItem => i.kind === "tool");
    expect(call?.call.status).toBe("interrupted");
    expect(p.turn.running).toBe(false);
    // A tool's own error still reads as failed.
    const failed = project([ev("turn_started"), ev("tool_call", { callId: "c2", name: "Bash" }), ev("tool_result", { callId: "c2", output: "exit 1", isError: true })]);
    expect(failed.items.find((i): i is ToolItem => i.kind === "tool")?.call.status).toBe("failed");
  });

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

  test("the failed turn's note offers Try again only while it is the last thing, and no turn is running", () => {
    const failed = [ev("user_message", { text: "hi" }), ev("turn_started"), ev("turn_completed", { stopReason: "error" })];
    expect(project(failed).items.at(-1)).toMatchObject({ kind: "note", tone: "error", retry: true });
    // A later message or turn, or a success, and an earlier failure shows no button.
    for (const later of [[ev("user_message", { text: "again" })], [ev("user_message", { text: "again" }), ev("turn_started")], [ev("turn_started"), ev("turn_completed", { stopReason: "end_turn" })]]) {
      const notes = project([...failed, ...later]).items.filter((i) => i.kind === "note");
      expect(notes).toMatchObject([{ tone: "error" }]);
      expect((notes[0] as { retry?: true }).retry).toBeUndefined();
    }
    expect((project([ev("turn_started"), ev("turn_completed", { stopReason: "aborted" })]).items.at(-1) as { retry?: true } | undefined)?.retry).toBeUndefined();
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

  function mount(extra: { archived?: boolean; entries?: Parameters<typeof runtimeWith>[0]["entries"]; component?: EntryComponent; history?: (p: { cursor?: string }) => { events: CoreEvent[]; cursor?: string }; bots?: unknown[]; tokens?: Record<string, number>; speak?: (p: unknown) => unknown; action?: (p: unknown) => unknown; cards?: { list: CardMeta[]; listeners: Set<() => void> } } = {}) {
    let listener: ((e: CoreEvent) => void) | undefined;
    const core = fakeCore({
      "archive.history": extra.history ?? (() => ({ events: [ev("user_message", { text: "From the old app" }), ev("approval_requested", { toolName: "Bash" })] })),
      ...(extra.speak ? { "voice.speak": extra.speak } : {}),
      ...(extra.action ? { "conversation.messageAction": extra.action } : {}),
    } as never);
    const api = fakeApi({
      bots: { list: async () => (extra.bots ?? []) as never, get: async () => { throw new Error("none"); }, watch: () => () => undefined },
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
      spot: (name) => (name === "conversation.message" ? { shape: "keyed", keep: ["approval"] } : name === "conversation.message.extra" || name === "conversation.message.action" ? { shape: "list" } : undefined),
      entries: extra.entries ?? [],
      component: () => extra.component,
      ...(extra.tokens ? { tokens: () => extra.tokens! } : {}),
      ...(extra.cards
        ? {
            approvals: { cards: () => extra.cards!.list, subscribe: (l: () => void) => { extra.cards!.listeners.add(l); return () => void extra.cards!.listeners.delete(l); } },
            sealed: mockSealed({}),
          }
        : {}),
    });
    render(
      <UiRuntimeProvider runtime={runtime}>
        <ConversationEntry props={{ bot: { id: "alpha", name: "Alpha" }, session: "s_alpha", now: 2_000, ...(extra.archived ? { archived: true } : {}) }} />
      </UiRuntimeProvider>,
    );
    return { core, push: (e: CoreEvent) => listener?.(e) };
  }

  test("speak: offered for a bot with a voice in its main conversation; it asks the app's door with the session and the reply's seq", async () => {
    const reply = HISTORY[1]!.seq as number;
    const voiced = { id: "alpha", name: "Alpha", model: "m", userLayer: [], state: "idle", mainSession: "s_alpha", voice: { provider: "p", voice: "v" } };
    const { core } = mount({ bots: [voiced], speak: () => ({ speaking: false, note: "The voice plugin isn't installed." }) });
    await act(() => settle());
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Read this reply aloud" })));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "voice.speak").map((c) => c.params)).toEqual([{ session: "s_alpha", seq: reply }]);
    expect(screen.getByText("The voice plugin isn't installed.")).toBeTruthy();
    cleanup();
    // No voice, or not its main conversation: no button.
    mount({ bots: [{ ...voiced, voice: undefined }], speak: () => ({ speaking: true }) });
    await act(() => settle());
    expect(screen.queryByRole("button", { name: "Read this reply aloud" })).toBeNull();
    cleanup();
    mount({ bots: [{ ...voiced, mainSession: "s_other" }], speak: () => ({ speaking: true }) });
    await act(() => settle());
    expect(screen.queryByRole("button", { name: "Read this reply aloud" })).toBeNull();
  });

  test("message actions: the spot's data entries, drawn without a frame; a press names the entry, the session and the seq on the app's door", async () => {
    const reply = HISTORY[1]!.seq as number;
    const entries = [{ pluginId: "alpha", id: "pin", spot: "conversation.message.action", fields: { title: "Pin to her stage", icon: "assets/pin.png", call: "pinReply" }, source: "installed" as const, enabledAt: 1 }];
    const { core } = mount({ entries, action: () => ({ note: "Pinned." }) });
    await act(() => settle());
    const pin = screen.getByRole("button", { name: "Pin to her stage" });
    expect(pin.querySelector("img")?.getAttribute("src")).toBe("/_t/alpha/assets/pin.png");
    await act(async () => void fireEvent.click(pin));
    await act(() => settle());
    expect(core.calls.filter((c) => c.method === "conversation.messageAction").map((c) => c.params)).toEqual([{ entry: "alpha#pin", session: "s_alpha", seq: reply }]);
    expect(screen.getByText("Pinned.")).toBeTruthy();
  });

  test("the theme's conversation.extra.inline sets a reply's add-ons in its actions row, unless a plugin draws the reply", async () => {
    const Extra: EntryComponent = ({ entry }) => <button type="button" data-testid={entry.spot}>Pin</button>;
    const extras = [{ pluginId: "alpha", id: "pin", spot: "conversation.message.extra", component: "Extra", source: "installed" as const, enabledAt: 1 }];
    mount({ component: Extra, entries: extras, tokens: { "conversation.extra.inline": 1 } });
    await act(() => settle());
    expect(document.querySelector(".cl-conv-bot__actions [data-testid='conversation.message.extra']")).toBeTruthy();
    cleanup();
    mount({ component: Extra, entries: extras });
    await act(() => settle());
    expect(document.querySelector(".cl-conv-bot__actions [data-testid='conversation.message.extra']")).toBeNull();
  });

  test("its bot's pending card for this session is drawn in place, from the card door (never the followed stream), and goes when answered", async () => {
    const cards = { list: [] as CardMeta[], listeners: new Set<() => void>() };
    const tell = () => act(() => { for (const l of cards.listeners) l(); });
    mount({ cards });
    await act(() => settle());
    expect(document.querySelector(".cl-conv-approval")).toBeNull();
    // A tool card for this session, and one for another session and one with none: only this session's draws.
    cards.list = [
      card("card_here", { kind: "tool", session: "s_alpha", bot: "alpha", issuedAt: 5_000 }),
      card("card_other", { kind: "tool", session: "s_other", bot: "alpha" }),
      card("card_ok", { kind: "plugin-ok" }),
    ];
    tell();
    const placed = [...document.querySelectorAll("[data-sealed-card]")].map((e) => (e as HTMLElement).dataset.sealedCard);
    expect(placed).toEqual(["card_here"]);
    const unit = document.querySelector<HTMLElement>('.cl-conv__unit[data-unit="approval"]')!;
    expect(unit.hasAttribute("data-pending")).toBe(true);
    expect(unit.querySelector(".cl-conv-approval [data-sealed-button='approve']")).toBeTruthy();
    expect(unit.querySelector(".cl-conv-approval [data-sealed-button='deny']")).toBeTruthy();
    // Answered (anywhere): it leaves the list, and its cell goes.
    cards.list = [];
    tell();
    expect(document.querySelector(".cl-conv-approval")).toBeNull();
  });

  test("reads the history, then follows what comes next", async () => {
    const { push } = mount();
    await act(() => settle());
    expect(screen.getByText("Hello there")).toBeTruthy();
    expect(screen.getByText("Hi! What can I do?")).toBeTruthy();
    await act(async () => {
      push(ev("user_message", { text: "One more thing" }));
      await Bun.sleep(40); // the frame the followed events wait for
    });
    expect(screen.getByText("One more thing")).toBeTruthy();
  });

  test("a streamed reply's words come in once a frame: one draw of the transcript per frame, however many words came", async () => {
    let draws = 0;
    const Counting: EntryComponent = ({ props }) => {
      draws++;
      return <p data-testid="bot">{(props.item as { text: string }).text}</p>;
    };
    const { push } = mount({ component: Counting, entries: [{ pluginId: "count", id: "bot", spot: "conversation.message", key: "bot", component: "Counting", source: "installed", enabledAt: 1 }] });
    await act(() => settle());
    await act(async () => {
      push(ev("turn_started"));
      await Bun.sleep(40);
    });
    const before = draws;
    // Words as they come, each in its own task: nothing is drawn until the frame, then the reply once with all of them.
    for (let i = 0; i < 50; i++) act(() => push(ev("assistant_delta", { delta: `w${i} ` })));
    expect(draws).toBe(before);
    expect(screen.queryAllByTestId("bot").some((el) => el.textContent?.includes("w0"))).toBe(false);
    await act(async () => {
      await Bun.sleep(40);
    });
    expect(screen.getAllByTestId("bot").some((el) => el.textContent?.includes("w49"))).toBe(true);
    expect(draws - before).toBeLessThanOrEqual(2);
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

  test("archived: reads the old session from the core, and its approvals read as notes", async () => {
    const { core } = mount({ archived: true });
    await act(() => settle());
    expect(core.calls).toEqual([{ method: "archive.history", params: { id: "s_alpha", limit: 500 } }]);
    expect(screen.getByText("From the old app")).toBeTruthy();
    expect(screen.getByText("Asked to use Bash")).toBeTruthy();
    expect(screen.queryByText("Hello there")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show later messages" })).toBeNull();
  });

  /** An old session of three pages, read forward by `archive.history`'s cursor. */
  const PAGES: Record<string, { events: CoreEvent[]; cursor?: string }> = {
    start: { events: [ev("user_message", { text: "Page one asks" }), ev("assistant_message", { text: "Page one answers" })], cursor: "p2" },
    p2: { events: [ev("user_message", { text: "Page two asks" }), ev("assistant_message", { text: "Page two answers" })], cursor: "p3" },
    p3: { events: [ev("user_message", { text: "Page three asks" }), ev("assistant_message", { text: "The end" })] },
  };
  const paged = ({ cursor }: { cursor?: string }) => PAGES[cursor ?? "start"]!;
  const cursors = (core: { calls: { method: string; params: unknown }[] }) => core.calls.map((c) => (c.params as { cursor?: string }).cursor ?? "start");

  test("archived: a short session's pages are read through to its end, by the cursor", async () => {
    const { core } = mount({ archived: true, history: paged });
    await act(() => settle());
    await act(() => settle());
    expect(cursors(core)).toEqual(["start", "p2", "p3"]);
    for (const text of ["Page one asks", "Page two answers", "The end"]) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show later messages" })).toBeNull();
  });

  test("archived: a long session opens at its start and reads the next page as the reader nears the end", async () => {
    // A tall transcript in a short view, growing by a page's height with each page read: nothing more is read until
    // the reader scrolls down.
    let pages = 0;
    const metrics = { scrollTop: 0, get scrollHeight() { return 5_000 * Math.max(1, pages); }, clientHeight: 500 };
    const saved = (["scrollTop", "scrollHeight", "clientHeight"] as const).map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k) ?? Object.getOwnPropertyDescriptor(Element.prototype, k)] as const);
    for (const k of ["scrollTop", "scrollHeight", "clientHeight"] as const) {
      Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => metrics[k], set: (v: number) => { if (k === "scrollTop") metrics.scrollTop = v; } });
    }
    try {
      const { core } = mount({ archived: true, history: (p) => ((pages += 1), paged(p)) });
      await act(() => settle());
      expect(cursors(core)).toEqual(["start"]);
      expect(screen.getByText("Page one asks")).toBeTruthy();
      expect(screen.queryByText("Page two asks")).toBeNull();
      // Scrolled near the end: the next page.
      metrics.scrollTop = 4_200;
      fireEvent.scroll(screen.getByRole("log"));
      await act(() => settle());
      expect(cursors(core)).toEqual(["start", "p2"]);
      expect(screen.getByText("Page two asks")).toBeTruthy();
      // From the keyboard: the button at the end reads the last one.
      metrics.scrollTop = 0;
      fireEvent.click(screen.getByRole("button", { name: "Show later messages" }));
      await act(() => settle());
      expect(cursors(core)).toEqual(["start", "p2", "p3"]);
      expect(screen.getByText("The end")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Show later messages" })).toBeNull();
    } finally {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(HTMLElement.prototype, k, d);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
      }
    }
  });
});
