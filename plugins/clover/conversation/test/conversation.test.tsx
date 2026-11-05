import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { ConversationView, workingText, type ConversationViewProps } from "../client/ConversationView";
import { thinkingLabel } from "../client/messages/ThinkingRow";
import { MAX_OUTPUT_LINES, outputPreview } from "../client/messages/ToolRun";
import { UiRuntimeProvider } from "../client/sdk";
import { buildTimeline } from "../client/timeline";
import type { ConversationItem } from "../client/types";
import {
  APPROVAL_PENDING,
  APPROVAL_PENDING_CARD,
  APPROVAL_STATES,
  ATTACHMENTS,
  BOT,
  DEVICE,
  DEVICES,
  EVENTS,
  FORMAT,
  NOTES,
  NOW,
  QUESTION_FREE,
  QUESTION_MULTI,
  QUESTION_SINGLE,
  SEALED_CARDS,
  TOOLS,
  TOOLS_OPEN,
  approval,
  at,
  bot,
  thinking,
  tool,
  user,
} from "../gallery/fixtures";
import { mockRuntime } from "../gallery/mock-runtime";

afterEach(cleanup);

function renderView(props: Partial<ConversationViewProps> & { items: readonly ConversationItem[] }, runtime = mockRuntime({ cards: SEALED_CARDS })) {
  const view = (p: typeof props) => (
    <UiRuntimeProvider runtime={runtime}>
      <ConversationView bot={BOT} now={NOW} device={DEVICE} format={FORMAT} {...p} />
    </UiRuntimeProvider>
  );
  const result = render(view(props));
  return { ...result, rerenderWith: (p: typeof props) => result.rerender(view(p)) };
}

const units = (container: HTMLElement) => [...container.querySelectorAll(".cl-conv__unit")].map((u) => (u as HTMLElement).dataset.unit);

describe("the view", () => {
  test("an empty conversation says so", () => {
    renderView({ items: [] });
    expect(screen.getByText("This is the start of your conversation with Alpha.")).toBeTruthy();
    expect(screen.getByRole("log", { name: "Conversation with Alpha" })).toBeTruthy();
  });

  test("every message kind draws, in order, with day dividers", () => {
    const items: ConversationItem[] = [
      user(at(-1, 9, 0), "hi"),
      bot(at(-1, 9, 0), "hello"),
      ...EVENTS.slice(0, 1),
      ...NOTES.slice(2, 3),
      ...APPROVAL_STATES.slice(0, 1),
      QUESTION_SINGLE,
      tool(at(0, 17, 0), { name: "Bash" }),
      thinking(at(0, 17, 1), { title: "Planning" }),
      EVENTS.find((e) => e.kind === "agent-report")!,
      EVENTS.find((e) => e.kind === "task-notification")!,
    ];
    const { container } = renderView({ items });
    expect(units(container)).toEqual([
      "user", "bot", "routine-result", "note", "approval", "question", "tools", "thinking", "agent-report", "task-notification",
    ]);
    expect([...container.querySelectorAll(".cl-conv-day")].map((d) => d.textContent)).toEqual(["Yesterday", "Today"]);
  });

  test("the turn's status line reads the phase, and steps aside for a live answer or thinking row", () => {
    const idle = buildTimeline([user(at(0, 1, 0), "x")], NOW, FORMAT);
    expect(workingText(undefined, "Alpha", idle.at(-1))).toBeUndefined();
    expect(workingText({ running: true }, "Alpha", idle.at(-1))).toBe("Alpha is thinking");
    expect(workingText({ running: true, phase: "working" }, "Alpha", idle.at(-1))).toBe("Alpha is working");
    expect(workingText({ running: true, phase: "waiting" }, "Alpha", idle.at(-1))).toBe("Alpha is waiting for you");
    expect(workingText({ running: true, phase: "compacting" }, "Alpha", idle.at(-1))).toBe("Compacting the conversation");
    expect(workingText({ running: true, phase: "retrying", retry: { attempt: 3, maxRetries: 10 } }, "Alpha", idle.at(-1))).toBe(
      "Provider busy, retrying (3 of 10)",
    );
    const streaming = buildTimeline([bot(at(0, 1, 0), "par", { streaming: true })], NOW, FORMAT);
    expect(workingText({ running: true }, "Alpha", streaming.at(-1))).toBeUndefined();
    const live = buildTimeline([thinking(at(0, 1, 0), { live: true })], NOW, FORMAT);
    expect(workingText({ running: true }, "Alpha", live.at(-1))).toBeUndefined();
    expect(workingText({ running: true, phase: "compacting" }, "Alpha", live.at(-1))).toBe("Compacting the conversation");

    renderView({ items: [user(at(0, 1, 0), "x")], turn: { running: true, phase: "working" } });
    expect(screen.getByRole("status").textContent).toContain("Alpha is working");
  });

  test("Show earlier calls the host", () => {
    const onLoadEarlier = mock(() => undefined);
    renderView({ items: [user(at(0, 1, 0), "x")], hasEarlier: true, onLoadEarlier });
    fireEvent.click(screen.getByRole("button", { name: "Show earlier messages" }));
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  test("a reader who scrolled up keeps their place and gets Jump to latest; a follower is kept at the bottom", () => {
    const items = [user(at(0, 1, 0), "one")];
    const { container, rerenderWith } = renderView({ items });
    const viewport = container.querySelector(".cl-conv__viewport") as HTMLElement;
    let scrollTop = 0;
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(viewport, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = Math.min(v, 1600); } });

    // Following: new output scrolls to the bottom.
    rerenderWith({ items: [...items, bot(at(0, 1, 1), "two")] });
    expect(scrollTop).toBe(1600);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();

    // The reader scrolls up: new output leaves them there and offers the pill.
    scrollTop = 200;
    fireEvent.scroll(viewport);
    rerenderWith({ items: [...items, bot(at(0, 1, 1), "two"), bot(at(0, 1, 2), "three")] });
    expect(scrollTop).toBe(200);
    const jump = screen.getByRole("button", { name: "Jump to latest" });
    // The pill sits below the scrolling area, never over the conversation.
    expect(jump.closest(".cl-conv__footer")).toBeTruthy();
    expect(jump.closest(".cl-conv__viewport")).toBeNull();

    fireEvent.click(jump);
    expect(scrollTop).toBe(1600);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  test("starting at the top shows the pill when there is more below", () => {
    const { container } = render(<div />);
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 3000 });
    try {
      renderView({ items: [user(at(0, 1, 0), "one")], initialFollow: false });
      expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollHeight", original);
      else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
    expect(container).toBeTruthy();
  });
});

describe("user and bot messages", () => {
  test("attachments draw as thumbnails and chips; the meta says another device or a late arrival", () => {
    const { container } = renderView({ items: [...ATTACHMENTS, ...DEVICES] });
    expect(container.querySelectorAll(".cl-conv-user__thumb").length).toBe(2);
    const chips = [...container.querySelectorAll(".cl-conv-user__bubble .cl-conv-user__chip")].map((c) => c.textContent);
    expect(chips).toEqual(["island-a.png", "island-b.png", "notes.md"]);
    expect(screen.getByText("from iPhone")).toBeTruthy();
    expect(screen.getByText("from clover.waifucave.com")).toBeTruthy();
    expect(screen.getByText("arrived late")).toBeTruthy();
    // A message from this device does not repeat where it came from.
    expect(screen.queryByText(`from ${DEVICE}`)).toBeNull();
  });

  test("Markdown shows raw HTML as text, drops unsafe links and hands links to the host", () => {
    const onOpenLink = mock((_url: string) => undefined);
    const { container } = renderView({
      items: [bot(at(0, 1, 0), "<img src=x onerror=alert(1)> **bold** [safe](https://example.com) [bad](javascript:alert(1)) ![pic](https://example.com/p.png)")],
      onOpenLink,
    });
    const md = container.querySelector(".cl-conv-md") as HTMLElement;
    expect(md.querySelector("img")).toBeNull();
    expect(md.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(md.querySelector("strong")?.textContent).toBe("bold");
    const bad = within(md).getByText("bad") as HTMLAnchorElement;
    expect(bad.getAttribute("href") ?? "").not.toContain("javascript");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    within(md).getByText("safe").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com");
    fireEvent.click(within(md).getByText("Image: pic"));
    expect(onOpenLink).toHaveBeenLastCalledWith("https://example.com/p.png");
  });

  test("a code block copies its text as written", () => {
    const onCopy = mock((_text: string) => undefined);
    renderView({ items: [bot(at(0, 1, 0), "```ts\nconst a = 1;\n```")], onCopy });
    expect(screen.getByText("ts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(onCopy).toHaveBeenCalledWith("const a = 1;");
  });

  test("only the final answer carries a copy button; a streaming one is busy and has none", () => {
    const { container, rerenderWith } = renderView({
      items: [user(at(0, 1, 0), "go"), bot(at(0, 1, 0), "a step"), tool(at(0, 1, 0), { name: "Bash" }), bot(at(0, 1, 1), "the answer")],
    });
    expect(screen.getAllByRole("button", { name: "Copy message" }).length).toBe(1);
    rerenderWith({ items: [user(at(0, 1, 0), "go"), bot(at(0, 1, 1), "the ans", { streaming: true })], turn: { running: true } });
    const article = container.querySelector(".cl-conv-bot") as HTMLElement;
    expect(article.dataset.streaming).toBe("true");
    expect(article.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
  });

  test("an interrupted answer says so", () => {
    renderView({ items: [bot(at(0, 1, 0), "half an ans", { interrupted: true })] });
    expect(screen.getByText("Interrupted")).toBeTruthy();
  });
});

describe("thinking", () => {
  test("labels: the title, else Thinking while live, else Thought (for a while)", () => {
    expect(thinkingLabel(thinking(0, { title: "Planning", live: true }), true)).toBe("Planning");
    expect(thinkingLabel(thinking(0, { title: "Planning", durationMs: 12_000 }), false)).toBe("Planning · 12s");
    expect(thinkingLabel(thinking(0, { live: true }), true)).toBe("Thinking");
    // A live block whose turn ended reads as done, never as thinking forever.
    expect(thinkingLabel(thinking(0, { live: true }), false)).toBe("Thought");
    expect(thinkingLabel(thinking(0, { durationMs: 8_000 }), false)).toBe("Thought for 8s");
  });

  test("a done row opens to its text; a hidden block says the provider kept it; a live row does not open", () => {
    renderView({
      items: [
        thinking(at(0, 1, 0), { title: "Mapping", text: "The old sync keeps a cursor." }),
        thinking(at(0, 1, 1), { reasoning: "hidden", durationMs: 1000 }),
        thinking(at(0, 1, 2), { title: "Live one", live: true }),
      ],
      turn: { running: true },
    });
    const mapping = screen.getByRole("button", { name: /Mapping/ });
    expect(mapping.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(mapping);
    expect(screen.getByText("The old sync keeps a cursor.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Thought for 1s/ }));
    expect(screen.getByText("The provider kept this reasoning hidden.")).toBeTruthy();
    const live = screen.getByRole("button", { name: /Live one/ }) as HTMLButtonElement;
    expect(live.disabled).toBe(true);
    expect(live.closest(".cl-conv-thinking")?.getAttribute("data-running")).toBe("true");
  });
});

describe("tool runs", () => {
  test("a run reads as one sentence with its computer, and opens to each call", () => {
    renderView({ items: TOOLS.slice(0, 6) });
    const summary = screen.getByRole("button", { name: /Ran 3 commands, read 2 files/ });
    expect(summary.textContent).toContain("on Studio");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("git status --short")).toBeTruthy();
    expect(screen.getByText(/84 pass/)).toBeTruthy();
    // 56 lines of build log draw as 40 plus a count.
    expect(screen.getByText(`${56 - MAX_OUTPUT_LINES} more lines`)).toBeTruthy();
  });

  test("output previews bound lines and characters", () => {
    expect(outputPreview("a\nb").moreLines).toBe(0);
    expect(outputPreview(Array(45).fill("x").join("\n"))).toEqual({ text: Array(40).fill("x").join("\n"), moreLines: 5, cut: false });
    expect(outputPreview("y".repeat(5000)).cut).toBe(true);
  });

  test("diff chips open the diff; file paths open the file; sites go to the host", () => {
    const onOpenDiff = mock((_id: string) => undefined);
    const onOpenFile = mock((_p: string) => undefined);
    const onOpenLink = mock((_u: string) => undefined);
    renderView({ items: TOOLS, initialExpanded: TOOLS_OPEN, onOpenDiff, onOpenFile, onOpenLink });
    fireEvent.click(screen.getByRole("button", { name: "Open the diff for plugins/clover/shell/clover.json" }));
    expect(onOpenDiff).toHaveBeenCalledWith("d1");
    fireEvent.click(screen.getByRole("button", { name: "home/Studio/projects/clover/docs/clover-spec.md" }));
    expect(onOpenFile).toHaveBeenCalledWith("home/Studio/projects/clover/docs/clover-spec.md");
    fireEvent.click(screen.getByText("github.com"));
    expect(onOpenLink).toHaveBeenCalledWith("https://github.com/electron/electron/issues/41300");
  });

  test("a failed run shows its first error line folded; running and reviewing calls say so", () => {
    const { container } = renderView({ items: TOOLS, turn: { running: true, phase: "working" } });
    expect(screen.getByText("client/Composer.tsx(41,7): error TS2322: Type 'string' is not assignable to type 'number'.")).toBeTruthy();
    const statuses = [...container.querySelectorAll(".cl-conv-tools")].map((t) => (t as HTMLElement).dataset.status);
    expect(statuses).toContain("failed");
    expect(statuses).toContain("interrupted");
    expect(statuses.at(-1)).toBe("running");
    expect(screen.getByText("Safety check")).toBeTruthy();
  });

  test("an MCP Apps page is placed for its call, and a plugin can draw a tool's result", () => {
    const appCall = TOOLS.find((i) => i.kind === "tool" && i.call.app)!;
    const blender = TOOLS.find((i) => i.kind === "tool" && i.call.name === "mcp__blender__Render")!;
    const { container } = renderView({
      items: TOOLS,
      initialExpanded: TOOLS_OPEN,
      renderToolResult: (c) => (c.name === "mcp__blender__Render" ? <span>custom render view</span> : undefined),
    });
    expect(container.querySelector(`[data-app-view="${appCall.kind === "tool" ? appCall.call.callId : ""}"]`)).toBeTruthy();
    expect(screen.getByText("custom render view")).toBeTruthy();
    // The custom view replaces that call's default output.
    expect(screen.queryByText("home/Laptop/renders/island-preview.png")).toBeNull();
    expect(blender).toBeTruthy();
  });
});

describe("approvals", () => {
  test("a pending card places the core's sealed frames: fields, then deny and approve", () => {
    const { container } = renderView({ items: APPROVAL_PENDING });
    const card = container.querySelector(`[data-sealed-card="${APPROVAL_PENDING_CARD}"]`) as HTMLElement;
    expect(card).toBeTruthy();
    expect([...card.querySelectorAll("[data-sealed-field]")].map((f) => (f as HTMLElement).dataset.sealedField)).toEqual([
      "title", "command", "computer", "risk", "reason",
    ]);
    expect([...card.querySelectorAll("[data-sealed-button]")].map((b) => (b as HTMLElement).dataset.sealedButton)).toEqual(["deny", "approve"]);
    // A card from a turn the user started waits: no deadline.
    expect(screen.queryByText(/unless you answer/)).toBeNull();
  });

  test("a card from a turn the user did not start says when it is denied", () => {
    renderView({ items: APPROVAL_STATES });
    // Issued at 16:22 and denied 10 minutes later; it is 16:30.
    expect(screen.getByText("Denied in 2 minutes unless you answer")).toBeTruthy();
  });

  test("resolved cards say how they ended and where", () => {
    renderView({ items: APPROVAL_STATES });
    expect(screen.getByText("Approved on iPhone")).toBeTruthy();
    expect(screen.getByText("Denied on Studio")).toBeTruthy();
    expect(screen.getByText("Denied: no answer in time")).toBeTruthy();
    expect(screen.getByText("Withdrawn when you interrupted")).toBeTruthy();
  });

  test("with no UI runtime under it, a card places nothing it cannot back with sealed frames", () => {
    render(<ConversationView bot={BOT} now={NOW} format={FORMAT} items={[approval(at(0, 1, 0), { cardId: "x" })]} />);
    expect(screen.getByText("This approval card can only show in Clover's own window.")).toBeTruthy();
    expect(document.querySelector("[data-sealed-button]")).toBeNull();
  });
});

describe("questions", () => {
  test("one choice: pick, send, and the answer is keyed by the question", () => {
    const onAnswerQuestion = mock((_id: string, _a: unknown) => undefined);
    renderView({ items: [QUESTION_SINGLE], onAnswerQuestion });
    const send = screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /^SQLite/ }));
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onAnswerQuestion).toHaveBeenCalledWith(QUESTION_SINGLE.callId, { answers: { "Which database should the hub use?": "SQLite" } });
    // Sent once: the card does not send twice.
    expect(send.disabled).toBe(true);
  });

  test("typed text wins over a single choice; several choices join with the typed text", () => {
    const onAnswerQuestion = mock((_id: string, _a: unknown) => undefined);
    renderView({ items: [QUESTION_MULTI], onAnswerQuestion });
    expect(screen.getByText("Computers")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Studio"));
    fireEvent.click(screen.getByLabelText(/Cloud computer/));
    const [first, second] = screen.getAllByRole("textbox") as HTMLInputElement[];
    fireEvent.change(first!, { target: { value: "the old NAS" } });
    fireEvent.click(screen.getByLabelText("2:00"));
    fireEvent.change(second!, { target: { value: "3:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onAnswerQuestion).toHaveBeenCalledWith(QUESTION_MULTI.callId, {
      answers: { "Which computers should run the nightly backup?": "Studio, Cloud computer, the old NAS", "When should it run?": "3:30" },
    });
  });

  test("a free-text question sends on Enter, and says when the bot goes on without it", () => {
    const onAnswerQuestion = mock((_id: string, _a: unknown) => undefined);
    renderView({ items: [QUESTION_FREE], onAnswerQuestion });
    expect(screen.getByText("Alpha goes on without an answer in 8 minutes")).toBeTruthy();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Juniper" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAnswerQuestion).toHaveBeenCalledWith(QUESTION_FREE.callId, { answers: { "What should I call the new bot?": "Juniper" } });
  });

  test("answered and expired questions draw closed", () => {
    renderView({
      items: [
        { ...QUESTION_SINGLE, id: "q-a", state: "answered", answers: { "Which database should the hub use?": "Postgres" }, answeredOn: "iPhone" },
        { ...QUESTION_FREE, id: "q-e", state: "expired" },
      ],
    });
    expect(screen.getByText("You answered on iPhone")).toBeTruthy();
    expect(screen.getByText("Postgres")).toBeTruthy();
    expect(screen.getByText("No answer in time; Alpha went on without it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send answer" })).toBeNull();
  });
});

describe("events and notes", () => {
  test("routine results open their side thread; agents open their tab and transcript", () => {
    const onOpenThread = mock((_id: string) => undefined);
    const onOpenAgent = mock((_id: string) => undefined);
    const onOpenFile = mock((_p: string) => undefined);
    renderView({ items: EVENTS, onOpenThread, onOpenAgent, onOpenFile });
    expect(screen.getByText("Morning brief")).toBeTruthy();
    expect(screen.getByRole("button", { name: "From Claude Code" })).toBeTruthy();
    expect(screen.getByText("Every weekday at 9:00")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Open run" })[0]!);
    expect(onOpenThread).toHaveBeenCalledWith("side-1");
    expect(screen.getByText("Claude Code finished")).toBeTruthy();
    expect(screen.getByText("Codex stopped making progress")).toBeTruthy();
    expect(screen.getByText("Background command finished")).toBeTruthy();
    expect(screen.getByText("Background command failed")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Open tab" })[0]!);
    expect(onOpenAgent).toHaveBeenCalledWith("agent-island");
    fireEvent.click(screen.getAllByRole("button", { name: "Open transcript" })[0]!);
    expect(onOpenFile).toHaveBeenCalledWith("bots/alpha/agents/agent-island.jsonl");
  });

  test("a long report starts folded", () => {
    renderView({ items: EVENTS });
    const more = screen.getByRole("button", { name: "Show more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });

  test("messages from other sessions name their sender, never the user", () => {
    renderView({ items: EVENTS });
    expect(screen.getByText("From Claude Code")).toBeTruthy();
    expect(screen.getByText("From Luna")).toBeTruthy();
    expect(screen.getByText(/joined the turn/)).toBeTruthy();
  });

  test("notes are plain text and name a plugin's or a hook's source", () => {
    const { container } = renderView({ items: NOTES });
    expect(screen.getByRole("separator", { name: "Alpha summarized the conversation up to here" })).toBeTruthy();
    expect(screen.getByText("Tarot panel (plugin):")).toBeTruthy();
    expect(screen.getByText("Hook from lint-guard:")).toBeTruthy();
    expect(container.querySelector('.cl-conv-note[data-tone="error"]')).toBeTruthy();
    renderView({ items: [{ kind: "note", id: "n-md", at: at(0, 1, 0), text: "**not bold**", from: { kind: "plugin", id: "p", name: "P" } }] });
    expect(screen.getByText("**not bold**")).toBeTruthy();
  });
});

describe("spots", () => {
  test("a renderer replaces one message kind, and extras draw under every message", () => {
    function Speech({ item }: { item: { text: string } }): ReactNode {
      return <div>speech: {item.text}</div>;
    }
    renderView({
      items: [user(at(0, 1, 0), "hi"), bot(at(0, 1, 0), "hello")],
      renderers: { bot: Speech },
      renderMessageExtra: (item) => <span>extra for {item.kind}</span>,
    });
    expect(screen.getByText("speech: hello")).toBeTruthy();
    expect(screen.getByText("extra for user")).toBeTruthy();
    expect(screen.getByText("extra for bot")).toBeTruthy();
  });

  test("expanding a run survives new items arriving", () => {
    const items = TOOLS.slice(0, 3);
    const { rerenderWith } = renderView({ items });
    fireEvent.click(screen.getByRole("button", { name: /Ran 2 commands/ }));
    act(() => rerenderWith({ items: [...items, bot(at(0, 15, 0), "more")] }));
    expect(screen.getByRole("button", { name: /Ran 2 commands/ }).getAttribute("aria-expanded")).toBe("true");
  });
});
