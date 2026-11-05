import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DispatchPill, type DispatchPillProps } from "../src/ui/DispatchPill";
import type { FrameTimers } from "../src/ui/Plume";
import { mockSealedKit, SealedKitContext } from "../src/ui/sealed";
import { PILL } from "../src/model/metrics";
import type { PillCard, QuestionCard } from "../src/model/cards";
import { AGENTS, ALPHA, APPROVAL, EXCHANGES, QUESTION, SEALED, TARGETS } from "../src/fixtures";

/** A frame clock the test moves by hand. */
function fakeFrames() {
  let now = 1000;
  let seq = 0;
  const frames = new Map<number, (time: number) => void>();
  const timers: FrameTimers = {
    now: () => now,
    requestFrame: (fn) => {
      const id = ++seq;
      frames.set(id, fn);
      return id;
    },
    cancelFrame: (id) => void frames.delete(id),
  };
  return {
    timers,
    get pending() {
      return frames.size;
    },
    /** Runs frames 16 ms apart for `ms`. */
    run(ms: number) {
      const end = now + ms;
      while (now < end) {
        act(() => {
          now = Math.min(end, now + 16);
          for (const [id, fn] of [...frames]) {
            frames.delete(id);
            fn(now);
          }
        });
      }
    },
  };
}

const kit = mockSealedKit(SEALED);

function mount(extra: Partial<DispatchPillProps> = {}) {
  const clock = fakeFrames();
  const ui = (props: Partial<DispatchPillProps>) => (
    <SealedKitContext.Provider value={kit}>
      <DispatchPill target={ALPHA} targets={TARGETS} timers={clock.timers} {...extra} {...props} />
    </SealedKitContext.Provider>
  );
  const view = render(ui({}));
  const shell = () => view.container.querySelector(".clp-shell") as HTMLElement;
  const size = () => ({ width: parseFloat(shell().style.width), height: parseFloat(shell().style.height) });
  return { ...view, clock, shell, size, update: (props: Partial<DispatchPillProps>) => view.rerender(ui(props)) };
}

describe("the Dispatch pill", () => {
  test("rests compact, and frames stop once nothing moves", () => {
    const pill = mount();
    expect(pill.size()).toEqual({ width: PILL.compactWidth, height: PILL.pillHeight });
    expect(pill.shell().style.borderRadius).toBe("22px");
    expect(pill.clock.pending).toBe(0);
  });

  test("the first keystroke opens the typing pill; the spring carries the shape there and settles", () => {
    const pill = mount();
    fireEvent.change(screen.getByLabelText("Message Alpha"), { target: { value: "C" } });
    expect(pill.clock.pending).toBe(1);
    pill.clock.run(100);
    const mid = pill.size();
    expect(mid.width).toBeGreaterThan(PILL.compactWidth);
    expect(mid.width).toBeLessThan(PILL.expandedWidth);
    pill.clock.run(1500);
    expect(pill.size()).toEqual({ width: PILL.expandedWidth, height: PILL.pillHeight });
    expect(pill.clock.pending).toBe(0);
  });

  test("Enter sends, clears the field and compresses the pill", () => {
    const onSend = mock((_: string) => {});
    const pill = mount({ onSend });
    const field = screen.getByLabelText("Message Alpha");
    fireEvent.change(field, { target: { value: "Tidy the notes" } });
    pill.clock.run(1500);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("Tidy the notes");
    expect((field as HTMLTextAreaElement).value).toBe("");
    pill.clock.run(1500);
    expect(pill.size().width).toBe(PILL.compactWidth);
  });

  test("Escape folds the typing pill back, keeping the draft", () => {
    const pill = mount();
    const field = screen.getByLabelText("Message Alpha");
    fireEvent.change(field, { target: { value: "half a thought" } });
    pill.clock.run(1500);
    fireEvent.keyDown(field, { key: "Escape" });
    pill.clock.run(1500);
    expect(pill.size().width).toBe(PILL.compactWidth);
    expect((field as HTMLTextAreaElement).value).toBe("half a thought");
  });

  test("while its bot works: the plume, the stop circle, and a click opens the typing pill over the turn", () => {
    const onStop = mock(() => {});
    const pill = mount({ running: true, onStop, thrown: [{ id: "t1", kind: { tool: "terminal" } }] });
    const underlay = pill.container.querySelector(".clp-underlay") as HTMLElement;
    expect(underlay.getAttribute("data-shown")).toBe("true");
    expect(underlay.querySelector("canvas")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    // The plume runs on frames of its own while it is shown.
    expect(pill.clock.pending).toBeGreaterThan(0);
    fireEvent.click(pill.container.querySelector(".clp-bar")!);
    pill.clock.run(600);
    expect(underlay.getAttribute("data-shown")).toBe("false");
    expect(pill.size().width).toBeGreaterThan(PILL.compactWidth);
    expect(screen.getByLabelText("Message Alpha").getAttribute("placeholder")).toBe("Alpha is working");
    // Hidden under the typing pill the plume stops drawing; once the shape settles, nothing runs.
    pill.clock.run(1500);
    expect(pill.clock.pending).toBe(0);
  });

  test("an ask morphs the pill into its card: the bar fades first, then the shape springs", () => {
    const pill = mount();
    pill.update({ cards: [APPROVAL] });
    // Fading: still the bar, still compact.
    pill.clock.run(48);
    expect(pill.size()).toEqual({ width: PILL.compactWidth, height: PILL.pillHeight });
    expect(pill.container.querySelector("[data-sealed-card]")).toBeNull();
    pill.clock.run(1600);
    expect(pill.size().width).toBe(PILL.cardWidth);
    expect(pill.container.querySelector('[data-sealed-card="ask-1"]')).toBeTruthy();
    expect((pill.container.querySelector(".clp-bar") as HTMLElement).getAttribute("aria-hidden")).toBe("true");
    // At rest nothing over the card fades or blurs it.
    const content = pill.container.querySelector(".clp-content") as HTMLElement;
    expect(content.style.filter).toBe("");
    expect(content.style.opacity).toBe("");
    // Answered: the card goes and the pill comes back.
    pill.update({ cards: [] });
    pill.clock.run(1600);
    expect(pill.size()).toEqual({ width: PILL.compactWidth, height: PILL.pillHeight });
    expect(pill.container.querySelector("[data-sealed-card]")).toBeNull();
  });

  test("a question answered from the pill: choose, then ✓; a failure keeps the card with a line", async () => {
    let result = false;
    const onAnswerQuestion = mock(async (_card: QuestionCard, _answers: Record<string, string>) => result);
    const pill = mount({ cards: [QUESTION], onAnswerQuestion });
    pill.clock.run(1600);
    fireEvent.click(screen.getByRole("radio", { name: /main/ }));
    expect(onAnswerQuestion).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(onAnswerQuestion).toHaveBeenCalledWith(QUESTION, { "Which branch should I open the pull request against?": "main" });
    expect(screen.getByRole("alert").textContent).toBe("That answer didn't go through. Try again.");
    result = true;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("the card on top shows; the others wait behind it", () => {
    const second: PillCard = { ...APPROVAL, id: "ask-9" };
    const pill = mount({ cards: [APPROVAL, second] });
    pill.clock.run(1600);
    expect(screen.getByText("Studio · +1 waiting")).toBeTruthy();
  });

  test("a pinned turn shows alone; a click goes back, and typing leaves it", () => {
    const onPinned = mock((_: number | null) => {});
    const pill = mount({ exchanges: EXCHANGES, pinned: 1, onPinned });
    pill.clock.run(1600);
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(pill.size().width).toBe(PILL.expandedWidth);
    fireEvent.click(screen.getByRole("article"));
    expect(onPinned).toHaveBeenLastCalledWith(null);
    onPinned.mockClear();
    fireEvent.change(screen.getByLabelText("Message Alpha"), { target: { value: "x" } });
    expect(onPinned).toHaveBeenCalledWith(null);
  });

  test("agents ride above it, each rising in; the window grows to hold them", () => {
    const canvases: { width: number; height: number }[] = [];
    const onStopAgent = mock((_: string) => {});
    const pill = mount({ running: true, onStopAgent, onCanvas: (c) => canvases.push(c) });
    expect(canvases.at(-1)).toEqual({ width: 364, height: 92 });
    pill.update({ running: true, agents: AGENTS.slice(0, 1) });
    const rising = pill.container.querySelector(".clp-child") as HTMLElement;
    expect(Number(rising.style.opacity)).toBeLessThan(1);
    pill.clock.run(600);
    expect((pill.container.querySelector(".clp-child") as HTMLElement).style.opacity).toBe("");
    expect(canvases.at(-1)).toEqual({ width: 364, height: 144 });
    fireEvent.click(screen.getByRole("button", { name: "Stop Release notes" }));
    expect(onStopAgent).toHaveBeenCalledWith("agent-1");
  });

  test("with reduced motion every change lands at once, with no frames", () => {
    const pill = mount({ reducedMotion: true });
    fireEvent.change(screen.getByLabelText("Message Alpha"), { target: { value: "x" } });
    expect(pill.size().width).toBe(PILL.expandedWidth);
    pill.update({ reducedMotion: true, cards: [APPROVAL] });
    expect(pill.size().width).toBe(PILL.expandedWidth);
    expect(pill.container.querySelector('[data-sealed-card="ask-1"]')).toBeTruthy();
    expect(pill.clock.pending).toBe(0);
  });

  test("the targets: the portrait lists every bot, and a pick is reported", () => {
    const onTarget = mock((_: string) => {});
    mount({ onTarget });
    fireEvent.click(screen.getByRole("button", { name: "Choose who to message" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Mori/ }));
    expect(onTarget).toHaveBeenCalledWith("mori");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
