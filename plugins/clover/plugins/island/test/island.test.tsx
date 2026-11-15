import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Island, OPEN_IDLE_MS, type IslandTimers } from "../src/ui/Island";
import { IslandQueue } from "../src/model/queue";
import { MORPH } from "../src/model/morph";
import { mockSealedKit } from "../src/mock-kit";
import { SealedKitContext } from "../src/ui/sealed";
import { APPROVAL, APPROVAL_2, LINK, NOTCH, QUESTION, SEALED } from "../src/fixtures";
import { readSeconds, type IslandCard, type QuestionCard } from "../src/model/cards";

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

  test("a hovered card's grown look is not its room: the height the island reports holds while the pointer rests on it (the 247/251 flip)", () => {
    // Layout stand-in: the card's content is 200 high and 368 wide; under a transform its rect is scaled, its layout size is not.
    const real = Element.prototype.getBoundingClientRect;
    const scaleOf = (el: Element) => {
      const m = /scale\(([\d.]+)\)/.exec((el.closest(".clv-card-shell") as HTMLElement | null)?.style.transform ?? "");
      return m ? Number(m[1]) : 1;
    };
    const isContent = (el: Element) => el.parentElement?.classList.contains("clv-card-content") === true;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return isContent(this) ? ({ x: 0, y: 0, top: 0, left: 0, right: 368 * scaleOf(this), bottom: 200 * scaleOf(this), width: 368 * scaleOf(this), height: 200 * scaleOf(this), toJSON: () => ({}) } as DOMRect) : real.call(this);
    };
    const offsets = [Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"), Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")] as const;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) { return isContent(this) ? 200 : 0; } });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get(this: HTMLElement) { return isContent(this) ? 368 : 0; } });
    try {
      const seen: string[] = [];
      const onRegions = (regions: readonly { height: number }[]) => void seen.push(regions.map((r) => Math.round(r.height)).join(","));
      const { clock, view } = mount([APPROVAL], { onRegions });
      clock.advance(2000);
      const resting = seen[seen.length - 1];
      for (let i = 0; i < 3; i++) {
        fireEvent.mouseEnter(view.container.querySelector(".clv-card-shell")!.parentElement!.parentElement!);
        clock.advance(300);
        fireEvent.mouseLeave(view.container.querySelector(".clv-card-shell")!.parentElement!.parentElement!);
        clock.advance(300);
      }
      expect(view.container.querySelector(".clv-card-shell")).not.toBeNull();
      expect(new Set(seen.slice(seen.indexOf(resting!))).size).toBe(1);
    } finally {
      Element.prototype.getBoundingClientRect = real;
      if (offsets[0]) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsets[0]);
      if (offsets[1]) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsets[1]);
    }
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

  test("a card compacts by itself after its reading time, with one wake-up armed, and a touch starts the wait again", () => {
    const { clock, view } = mount([APPROVAL]);
    const wait = readSeconds(APPROVAL) * 1000;
    expect(clock.timeoutCount).toBe(1);
    clock.advance(wait - 4000);
    fireEvent.mouseMove(onTop(view.container)!);
    clock.advance(wait - 10 - 250);
    expect(onTopId(view.container)).toBe("approval-1");
    clock.advance(4000 + 300);
    expect(onTop(view.container)).toBeNull();
    expect(view.container.querySelector('.clv-strip [data-part="waiting"]')?.textContent).toBe("1");
    expect(clock.timeoutCount).toBe(0);
  });

  test("a folded card (and a question) comes back at once when told the pill stepped aside", () => {
    const clock = fakeTimers();
    const ui = (signal: number) => (
      <SealedKitContext.Provider value={kit}>
        <Island shape={NOTCH} cards={[APPROVAL, QUESTION]} timers={clock.timers} bringBackSignal={signal} />
      </SealedKitContext.Provider>
    );
    const view = render(ui(0));
    clock.advance(60_000);
    clock.advance(60_000);
    expect(onTop(view.container)).toBeNull();
    view.rerender(ui(1));
    act(() => clock.advance(16));
    expect(onTop(view.container) ?? view.container.querySelector(".clv-card-shell")).not.toBeNull();
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

  test("the open island with nothing pending is put away once the pointer has left it, and stays while the pointer is on it", () => {
    const onOpenChange = mock();
    const { clock, view } = mount([], { onOpenChange });
    fireEvent.click(view.container.querySelector(".clv-strip")!);
    for (let i = 0; i < 40; i++) clock.advance(16);
    expect(view.container.querySelector(".clv-open")).not.toBeNull();
    expect(screen.getByText("Nothing needs you")).toBeTruthy();
    // On it: it stays however long.
    clock.advance(OPEN_IDLE_MS * 4);
    expect(view.container.querySelector(".clv-open")).not.toBeNull();
    // The pointer leaves, and comes back before the grace is out: still open.
    const open = view.container.querySelector(".clv-open")!;
    fireEvent.mouseLeave(open);
    clock.advance(OPEN_IDLE_MS - 100);
    fireEvent.mouseEnter(open);
    clock.advance(OPEN_IDLE_MS * 2);
    expect(view.container.querySelector(".clv-open")).not.toBeNull();
    // Gone for good: it closes by itself.
    fireEvent.mouseLeave(open);
    clock.advance(OPEN_IDLE_MS + 10);
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

  test("another plugin's tab can't pass for Needs you or for the island's own: it carries its plugin's name", () => {
    const { clock, view } = mount([APPROVAL], {
      tabs: [
        { id: "needs-you", title: "Inbox", pluginId: "evil", render: () => <p>fake</p> },
        { id: "x", title: " needs  YOU ", pluginId: "evil", render: () => <p>fake</p> },
        { id: "servers", title: "Servers", pluginId: "homelab", pluginName: "Homelab", attention: "expand", render: () => <p>3 servers up</p> },
      ],
    });
    clock.advance(8000);
    fireEvent.click(view.container.querySelector(".clv-strip")!);
    clock.advance(600);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label") ?? t.textContent)).toEqual(["Needs you", "Servers · Homelab"]);
    fireEvent.click(screen.getByRole("tab", { name: "Servers · Homelab" }));
    expect(screen.getByText("3 servers up")).toBeTruthy();
    expect(screen.queryByText("fake")).toBeNull();
  });

  test("a tab beside Needs you shows when chosen", () => {
    const { clock, view } = mount([APPROVAL], { tabs: [{ id: "devices", title: "Devices", pluginId: "clover", render: () => <p>Studio · this computer</p> }] });
    clock.advance(8000);
    fireEvent.click(view.container.querySelector(".clv-strip")!);
    clock.advance(600);
    fireEvent.click(screen.getByRole("tab", { name: "Devices" }));
    expect(screen.getByText("Studio · this computer")).toBeTruthy();
  });
});
