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
  CONFIRM_CARD,
  DEVICE,
  DEVICES,
  ELICITATION_CARD,
  EVENTS,
  FORMAT,
  INTERRUPT,
  NOTES,
  NOW,
  OTHER_CARDS,
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
    expect(screen.queryByText(`from ${DEVICE.name}`)).toBeNull();
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
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/");
    fireEvent.click(within(md).getByText("Image: pic"));
    expect(onOpenLink).toHaveBeenLastCalledWith("https://example.com/p.png");
  });

  test("one link rule: only absolute http, https and mailto reach the host; footnotes stay inside", () => {
    const onOpenLink = mock((_url: string) => undefined);
    const { container } = renderView({
      items: [
        bot(
          at(0, 1, 0),
          "[rel](/settings) [proto](//evil.example/x) [file](file:///etc/passwd) [mail](mailto:hi@clover.dev) [web](https://clover.dev/a) Note[^1]\n\n[^1]: The footnote.",
        ),
      ],
      onOpenLink,
    });
    const md = container.querySelector(".cl-conv-md") as HTMLElement;
    for (const name of ["rel", "proto", "file"]) {
      const el = within(md).getByText(name);
      expect(el.tagName).toBe("SPAN");
      fireEvent.click(el);
    }
    expect(onOpenLink).not.toHaveBeenCalled();
    // A footnote link scrolls inside the view and never goes to the host.
    const footnote = md.querySelector('a[href^="#"]') as HTMLAnchorElement;
    expect(footnote).toBeTruthy();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    footnote.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(onOpenLink).not.toHaveBeenCalled();
    fireEvent.click(within(md).getByText("mail"));
    expect(onOpenLink).toHaveBeenLastCalledWith("mailto:hi@clover.dev");
    // A middle-click never navigates by itself; it goes to the host like a click.
    const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    within(md).getByText("web").dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    expect(onOpenLink).toHaveBeenLastCalledWith("https://clover.dev/a");
  });

  test("nothing in the conversation loads an image from the web", () => {
    const { container } = renderView({
      items: [
        tool(at(0, 1, 0), {
          name: "mcp__clover__WebSearch",
          detail: "clover",
          sites: [
            { url: "https://clover.dev/", icon: "https://clover.dev/favicon.ico" },
            { url: "https://example.com/", icon: "data:image/png;base64,iVBORw0KGgo=" },
            { url: "javascript:alert(1)" },
          ],
        }),
        user(at(0, 1, 1), "See these", {
          attachments: [
            { n: 1, kind: "image", name: "a.png", path: "a.png", previewUrl: "https://tracker.example/a.png" },
            { n: 2, kind: "image", name: "b.png", path: "b.png", previewUrl: "blob:clover/b" },
          ],
        }),
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /Searched the web/ }));
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "");
    expect(sources.filter((src) => /^(https?:)?\/\//i.test(src))).toEqual([]);
    expect(sources).toContain("data:image/png;base64,iVBORw0KGgo=");
    expect(sources).toContain("blob:clover/b");
    // An unsafe site draws as text, never as a link.
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
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
    expect(thinkingLabel(thinking(0, { durationMs: 8_000 }), false)).toBe("Thought it through · 8s");
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
    fireEvent.click(screen.getByRole("button", { name: /Thought it through · 1s/ }));
    expect(screen.getByText("The provider kept this reasoning hidden.")).toBeTruthy();
    const live = screen.getByRole("button", { name: /Live one/ }) as HTMLButtonElement;
    expect(live.disabled).toBe(true);
    expect(live.closest(".cl-conv-thinking")?.getAttribute("data-running")).toBe("true");
  });
});

describe("tool runs", () => {
  test("a run reads as one sentence with its computer, and opens to each call", () => {
    renderView({ items: TOOLS.slice(0, 6) });
    const summary = screen.getByRole("button", { name: /Ran 3 commands and read 2 files/ });
    expect(summary.textContent).toContain("on Studio");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("git status --short")).toBeTruthy();
    expect(screen.getByText(/84 pass/)).toBeTruthy();
    // 56 lines of build log draw as MAX_OUTPUT_LINES plus a count of the rest.
    expect(screen.getByText(`${56 - MAX_OUTPUT_LINES} more lines`)).toBeTruthy();
  });

  test("output previews bound lines and characters", () => {
    expect(outputPreview("a\nb").moreLines).toBe(0);
    expect(outputPreview(Array(45).fill("x").join("\n"))).toEqual({
      text: Array(MAX_OUTPUT_LINES).fill("x").join("\n"),
      moreLines: 45 - MAX_OUTPUT_LINES,
      cut: false,
    });
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
    expect(screen.getByText("Running a command")).toBeTruthy();
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
  test("a pending card places every sealed field it has and one sealed button per option, deny first", () => {
    const { container } = renderView({ items: APPROVAL_PENDING });
    const card = container.querySelector(`[data-sealed-card="${APPROVAL_PENDING_CARD}"]`) as HTMLElement;
    expect(card).toBeTruthy();
    // Every one of lane B's fields has a holder; the mock core draws the ones this card has.
    expect([...card.querySelectorAll("[data-slot]")].map((f) => (f as HTMLElement).dataset.slot).sort()).toEqual(
      ["source", "what", "host", "command", "paths", "computer", "risk", "reason", "detail", "expires"].sort(),
    );
    expect([...card.querySelectorAll("[data-sealed-field]")].map((f) => (f as HTMLElement).dataset.sealedField)).toEqual([
      "title", "command", "computer", "risk", "reason", "expires",
    ]);
    const buttons = [...card.querySelectorAll("[data-sealed-button]")] as HTMLElement[];
    expect(buttons.map((b) => b.dataset.option)).toEqual(["deny", "allow_once", "allow_always"]);
    expect(buttons.map((b) => b.dataset.sealedButton)).toEqual(["deny", "approve", "approve"]);
    // The view adds no deadline words of its own: the core's sealed field says when.
    expect(screen.queryByText(/Denied in/)).toBeNull();
    // The call it holds says it is waiting, not that it ran.
    expect(screen.getByText("Waiting to run a command")).toBeTruthy();
  });

  test("with no options known, it places the first deny and the first approve", () => {
    const { container } = renderView({ items: [approval(at(0, 1, 0), { cardId: "card-routine" })] });
    const buttons = [...container.querySelectorAll("[data-sealed-button]")] as HTMLElement[];
    expect(buttons.map((b) => [b.dataset.sealedButton, b.dataset.option ?? ""])).toEqual([["deny", ""], ["approve", ""]]);
  });

  test("a card from a turn the user did not start places the core's own deadline", () => {
    const { container } = renderView({ items: APPROVAL_STATES });
    const routine = container.querySelector('[data-sealed-card="card-routine"]') as HTMLElement;
    expect(within(routine).getByText("Denied at 4:32 PM unless you answer")).toBeTruthy();
  });

  test("a plugin's confirm names the plugin through sealed fields; a sign-in link seals its host", () => {
    const { container } = renderView({ items: OTHER_CARDS });
    const confirm = container.querySelector(`[data-sealed-card="${CONFIRM_CARD}"]`) as HTMLElement;
    expect(within(confirm).getByText(/tarot-panel/).closest("[data-slot]")?.getAttribute("data-slot")).toBe("source");
    const link = container.querySelector(`[data-sealed-card="${ELICITATION_CARD}"]`) as HTMLElement;
    expect(within(link).getByText("linear.app").closest("[data-slot]")?.getAttribute("data-slot")).toBe("host");
    expect([...link.querySelectorAll("[data-sealed-button]")].map((b) => (b as HTMLElement).dataset.option)).toEqual(["decline", "open_link"]);
  });

  test("resolved cards say how they ended and where, and why a card was withdrawn", () => {
    renderView({ items: APPROVAL_STATES });
    expect(screen.getByText("Approved on iPhone")).toBeTruthy();
    expect(screen.getByText("Denied on Studio")).toBeTruthy();
    expect(screen.getByText("Denied: no answer in time")).toBeTruthy();
    expect(screen.getByText("Withdrawn when the turn ended")).toBeTruthy();
    cleanup();
    renderView({ items: INTERRUPT });
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

  test("an answer that didn't go through gives the card back, with a note", async () => {
    let fail: (e: Error) => void = () => undefined;
    const onAnswerQuestion = mock((_id: string, _a: unknown) => new Promise<void>((_, reject) => (fail = reject)));
    renderView({ items: [QUESTION_SINGLE], onAnswerQuestion });
    fireEvent.click(screen.getByRole("radio", { name: /^SQLite/ }));
    const send = screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;
    fireEvent.click(send);
    expect(send.disabled).toBe(true);
    await act(async () => {
      fail(new Error("offline"));
      await Promise.resolve();
    });
    expect(screen.getByRole("alert").textContent).toBe("Your answer didn't go through. Try again.");
    expect(send.disabled).toBe(false);
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

  test("messages from other sessions and plugins name their sender, never the user", () => {
    const { container } = renderView({ items: EVENTS });
    const titles = [...container.querySelectorAll(".cl-conv-event__title")].map((t) => t.textContent);
    expect(titles).toEqual(expect.arrayContaining(["From Claude Code", "From Luna", "From Tarot panel"]));
    expect(screen.getByText(/joined the turn/)).toBeTruthy();
    // A plugin's message (conversation.post, an MCP Apps page's ui/message) says it is a plugin's and
    // is never a user bubble.
    const fromPlugin = container.querySelector('[data-kind="agent-report"][data-from="plugin"]') as HTMLElement;
    expect(fromPlugin.textContent).toContain("plugin tarot-panel");
    expect(fromPlugin.closest(".cl-conv-user")).toBeNull();
    for (const bubble of container.querySelectorAll(".cl-conv-user")) expect(bubble.textContent).not.toContain("pinned");
  });

  test("notes are plain text and name a plugin's or a hook's source", () => {
    const { container } = renderView({ items: NOTES });
    expect(screen.getByRole("separator", { name: "Alpha summarized the conversation up to here" })).toBeTruthy();
    const sources = [...container.querySelectorAll(".cl-conv-note__source")].map((n) => n.textContent);
    expect(sources).toEqual(["Tarot panel (plugin tarot-panel)", "Hook from lint-guard", "Story mode (plugin story-mode)"]);
    // A plugin's divider can copy the core's words, but never its look: it names who drew it.
    const plugin = container.querySelector('.cl-conv-divider[data-from="plugin"]') as HTMLElement;
    expect(plugin.getAttribute("aria-label")).toBe("Story mode (plugin story-mode): Alpha summarized the conversation up to here");
    // Names the plugin chose sit in <bdi>, so bidi controls in them can't reorder the label.
    expect([...plugin.querySelectorAll("bdi")].map((b) => b.textContent)).toEqual(["Story mode", "story-mode"]);
    expect(container.querySelector('.cl-conv-note[data-tone="error"]')).toBeTruthy();
    cleanup();
    const plain = renderView({ items: [{ kind: "note", id: "n-md", at: at(0, 1, 0), text: "**not bold**", from: { kind: "plugin", id: "p", name: "P" } }] });
    const text = plain.container.querySelector(".cl-conv-note__text") as HTMLElement;
    expect(text.textContent).toBe("P (plugin p): **not bold**");
    expect(text.querySelector("strong")).toBeNull();
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
