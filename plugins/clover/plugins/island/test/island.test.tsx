import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Island, type IslandTimers } from "../src/ui/Island";
import { IslandQueue } from "../src/model/queue";
import { MORPH } from "../src/model/morph";
import { mockSealedKit } from "../src/mock-kit";
import { SealedKitContext } from "../src/ui/sealed";
import { APPROVAL, APPROVAL_2, LINK, NOTCH, QUESTION, SEALED } from "../src/fixtures";
import type { IslandCard, QuestionCard } from "../src/model/cards";

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const frames = new Map<number, () => void>();
  const timers: IslandTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timeouts.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => void timeouts.delete(h as number),
    requestFrame: (fn) => {
      const id = ++seq;
      frames.set(id, fn);
      return id;
    },
    cancelFrame: (h) => void frames.delete(h as number),
  };
  return {
    timers,
    get frameCount() {
      return frames.size;
    },
    get timeoutCount() {
      return timeouts.size;
    },
    advance(ms: number) {
      act(() => {
        now += ms;
        for (const [id, t] of [...timeouts].sort((a, b) => a[1].at - b[1].at)) {
          if (t.at <= now) {
            timeouts.delete(id);
            t.fn();
          }
        }
        for (const [id, fn] of [...frames]) {
          frames.delete(id);
          fn();
        }
      });
    },
  };
}

const kit = mockSealedKit(SEALED);

function mount(cards: IslandCard[], extra: Partial<Parameters<typeof Island>[0]> = {}) {
  const clock = fakeTimers();
  const ui = (c: IslandCard[]) => (
    <SealedKitContext.Provider value={kit}>
      <Island shape={NOTCH} cards={c} timers={clock.timers} {...extra} />
    </SealedKitContext.Provider>
  );
  const view = render(ui(cards));
  return { clock, view, update: (c: IslandCard[]) => view.rerender(ui(c)) };
}

const onTop = (container: HTMLElement) => container.querySelector(".clv-card-shell [data-sealed-card], .clv-card-shell .clv-card-parts");
const onTopId = (container: HTMLElement) => container.querySelector(".clv-card-shell [data-sealed-card]")?.getAttribute("data-sealed-card") ?? null;

describe("Island", () => {
  test("idle: the strip alone, and nothing running", () => {
    const { clock, view } = mount([]);
    expect(view.container.querySelector(".clv-strip")).not.toBeNull();
    expect(onTop(view.container)).toBeNull();
    expect(clock.frameCount).toBe(0);
    expect(clock.timeoutCount).toBe(0);
  });

  test("a card is born from the housing and rests; frames run only while it moves", () => {
    const { clock, view } = mount([APPROVAL]);
    expect(onTopId(view.container)).toBe("approval-1");
    expect(view.container.querySelector(".clv-melt")).not.toBeNull();
    expect(clock.frameCount).toBe(1);
    for (let i = 0; i < 100; i++) clock.advance(16);
    expect(view.container.querySelector(".clv-melt")).toBeNull();
    expect(clock.frameCount).toBe(0);
  });

  test("a card that leaves goes back up into the housing, then frames stop; with Reduce Motion it just goes", () => {
    const { clock, view, update } = mount([APPROVAL]);
    clock.advance(2000);
    update([]);
    expect(view.container.querySelector(".clv-returning")).not.toBeNull();
    expect(clock.frameCount).toBe(1);
    for (let i = 0; i < 80; i++) clock.advance(16);
    expect(view.container.querySelector(".clv-returning")).toBeNull();
    expect(clock.frameCount).toBe(0);

    const calm = mount([APPROVAL], { reducedMotion: true });
    calm.clock.advance(2000);
    calm.update([]);
    expect(calm.view.container.querySelector(".clv-returning")).toBeNull();
    expect(calm.clock.frameCount).toBe(0);
  });

  test("a newcomer replaces the card on top, which goes to the strip's count", () => {
    const { clock, view, update } = mount([APPROVAL]);
    clock.advance(2000);
    update([APPROVAL, APPROVAL_2]);
    expect(onTopId(view.container)).toBe("approval-2");
    expect(view.container.querySelector('.clv-strip [data-part="waiting"]')?.textContent).toBe("2");
  });

  test("a hovered card holds; the newcomer waits below, and a click on it swaps them", () => {
    const { clock, view, update } = mount([APPROVAL]);
    clock.advance(2000);
    fireEvent.mouseEnter(view.container.querySelector(".clv-card-shell")!.parentElement!.parentElement!);
    update([APPROVAL, LINK]);
    expect(onTopId(view.container)).toBe("approval-1");
    const waiting = screen.getByRole("button", { name: /Waiting: Link · Alpha/ });
    fireEvent.click(waiting);
    expect(onTopId(view.container)).toBe("link-1");
  });

  test("a card compacts by itself after six seconds, with one wake-up armed", () => {
    const { clock, view } = mount([APPROVAL]);
    expect(clock.timeoutCount).toBe(1);
    clock.advance(IslandQueue.selfCompactAfter * 1000 - 10);
    expect(onTopId(view.container)).toBe("approval-1");
    clock.advance(20);
    expect(onTop(view.container)).toBeNull();
    expect(view.container.querySelector('.clv-strip [data-part="waiting"]')?.textContent).toBe("1");
    expect(clock.timeoutCount).toBe(0);
  });

  test("an answer anywhere takes the card away", () => {
    const { view, update } = mount([APPROVAL]);
    update([]);
    expect(onTop(view.container)).toBeNull();
    expect(view.container.querySelector(".clv-strip [data-part]")).toBeNull();
  });

  test("a click on the waiting wing opens the island on Needs you; Esc closes it", () => {
    const onOpenChange = mock();
    const { clock, view } = mount([APPROVAL, QUESTION], { onOpenChange });
    clock.advance(8000);
    clock.advance(8000);
    fireEvent.click(view.container.querySelector(".clv-strip")!);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    for (let i = 0; i < 40; i++) clock.advance(16);
    expect(view.container.querySelector(".clv-open")).not.toBeNull();
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(view.container.querySelectorAll(".clv-needs-row")).toHaveLength(2);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    clock.advance((MORPH.settle / MORPH.closeSpeed) * 1000 + 50);
    expect(view.container.querySelector(".clv-open")).toBeNull();
  });

  test("a choice only chooses; ✓ sends (as in the pill)", async () => {
    const onAnswerQuestion = mock((_card: QuestionCard, _answers: Record<string, string>) => true);
    const { clock } = mount([QUESTION], { onAnswerQuestion });
    clock.advance(2000);
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "release/1.111" }));
    });
    expect(onAnswerQuestion).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "release/1.111" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(onAnswerQuestion).toHaveBeenCalledTimes(1);
    expect(onAnswerQuestion.mock.calls[0]![1]).toEqual({ "Which branch should I open the pull request against?": "release/1.111" });
  });

  test("an answer that did not go through says so", async () => {
    const { clock } = mount([QUESTION], { onAnswerQuestion: () => false });
    clock.advance(2000);
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "main" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Not sent. Try again.");
  });

  test("a tab beside Needs you shows when chosen", () => {
    const { clock, view } = mount([APPROVAL], { tabs: [{ id: "devices", title: "Devices", render: () => <p>Studio · this computer</p> }] });
    clock.advance(8000);
    fireEvent.click(view.container.querySelector(".clv-strip")!);
    clock.advance(600);
    fireEvent.click(screen.getByRole("tab", { name: "Devices" }));
    expect(screen.getByText("Studio · this computer")).toBeTruthy();
  });
});
