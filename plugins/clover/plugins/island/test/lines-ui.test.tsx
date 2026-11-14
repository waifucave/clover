import { describe, expect, test } from "bun:test";
import { act, render } from "@testing-library/react";
import { Island, type IslandTimers } from "../src/ui/Island";
import type { LineSource } from "../src/ui/Lines";
import { LINE_POLL_MS, type LineEntry } from "../src/model/lines";
import { mockSealedKit } from "../src/mock-kit";
import { SealedKitContext } from "../src/ui/sealed";
import { APPROVAL, NOTCH, SEALED } from "../src/fixtures";

const kit = mockSealedKit(SEALED);
const timers: IslandTimers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  requestFrame: (fn) => globalThis.setTimeout(fn, 16),
  cancelFrame: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

function source(state: { entries: LineEntry[]; answers: Record<string, unknown> }) {
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const src: LineSource = {
    entries: async () => [...state.entries],
    call: async (entry) => { calls.push(`${entry.pluginId}/${entry.entryId}`); return state.answers[`${entry.pluginId}/${entry.entryId}`]; },
    watch: (l) => { listeners.add(l); return () => void listeners.delete(l); },
  };
  return { src, calls, changed: () => listeners.forEach((l) => l()), watchers: () => listeners.size };
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

describe("the plugins' lines on the open island's Needs you tab", () => {
  test("drawn in the island's own rows: the sender's plugin and bot, its words, an icon and a progress bar; an update shows; a removal clears", async () => {
    const state = { entries: [{ pluginId: "alpha", entryId: "job" }], answers: { "alpha/job": { text: "Rendering frame 4 of 9", icon: "sync", progress: 0.44, bot: "alpha" } } as Record<string, unknown> };
    const s = source(state);
    const view = render(
      <SealedKitContext.Provider value={kit}>
        <Island shape={NOTCH} cards={[]} alwaysOpen lines={s.src} botName={(id) => (id === "alpha" ? "Alpha" : undefined)} timers={timers} />
      </SealedKitContext.Provider>,
    );
    await settle();
    const row = view.container.querySelector(".clv-line")!;
    expect(row).not.toBeNull();
    expect(row.querySelector(".clv-line-from")?.textContent).toBe("alpha · Alpha");
    expect(row.querySelector(".clv-line-text")?.textContent).toBe("Rendering frame 4 of 9");
    expect(row.querySelector("svg[data-glyph=sync]")).not.toBeNull();
    const bar = row.querySelector("[role=progressbar]")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("44");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("44%");
    // The empty state gives way to the line; nothing else of the sender is drawn (no markup, no style of its own).
    expect(view.container.textContent).not.toContain("Nothing needs you");
    expect(row.getAttribute("style")).toBeNull();
    // An update shows when the entries change (the point's watch) or at the next ask.
    state.answers["alpha/job"] = { text: "Rendering frame 5 of 9", progress: 0.55 };
    act(() => s.changed());
    await settle();
    expect(view.container.querySelector(".clv-line-text")?.textContent).toBe("Rendering frame 5 of 9");
    expect(view.container.querySelector("svg[data-glyph=sync]")).toBeNull();
    // The sender removes its line: nothing is drawn; its plugin turned off: its entry is gone.
    state.answers["alpha/job"] = null;
    act(() => s.changed());
    await settle();
    expect(view.container.querySelector(".clv-line")).toBeNull();
    expect(view.container.textContent).toContain("Nothing needs you");
    state.answers["alpha/job"] = { text: "back" };
    act(() => s.changed());
    await settle();
    expect(view.container.querySelector(".clv-line-text")?.textContent).toBe("back");
    state.entries = [];
    act(() => s.changed());
    await settle();
    expect(view.container.querySelector(".clv-line")).toBeNull();
    view.unmount();
    expect(s.watchers()).toBe(0);
  });
  test("a card still shows exactly as before, below the cards, which sit where they always did; a sender cannot make the closed island ask for anything", async () => {
    const s = source({ entries: [{ pluginId: "p", entryId: "x" }], answers: { "p/x": { text: "hello" } } });
    const open = render(
      <SealedKitContext.Provider value={kit}>
        <Island shape={NOTCH} cards={[APPROVAL]} alwaysOpen lines={s.src} timers={timers} />
      </SealedKitContext.Provider>,
    );
    await settle();
    const lines = open.container.querySelector(".clv-lines")!;
    const needs = open.container.querySelector(".clv-needs")!;
    // The lines come after the cards, and nothing comes before them: a card never moves for a line.
    expect(needs.compareDocumentPosition(lines) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(needs.previousElementSibling).toBeNull();
    expect(open.container.querySelectorAll(".clv-needs-row")).toHaveLength(1);
    open.unmount();
    // Closed island (a strip only): the entries are never asked for, so no plugin's handler runs.
    const closed = source({ entries: [{ pluginId: "p", entryId: "x" }], answers: { "p/x": { text: "hello" } } });
    const view = render(
      <SealedKitContext.Provider value={kit}>
        <Island shape={NOTCH} cards={[APPROVAL]} lines={closed.src} timers={timers} />
      </SealedKitContext.Provider>,
    );
    await settle();
    expect(closed.calls).toEqual([]);
    expect(closed.watchers()).toBe(0);
    expect(view.container.querySelector(".clv-line")).toBeNull();
    expect(LINE_POLL_MS).toBeGreaterThan(0);
  });
});

describe("the first line on the closed strip (the owner's ruling: only when Clover is not in front)", () => {
  const closed = (cards: typeof APPROVAL[], s: ReturnType<typeof source>, mainFront?: boolean) => (
    <SealedKitContext.Provider value={kit}>
      <Island shape={NOTCH} cards={cards} lines={s.src} mainFront={mainFront} timers={timers} />
    </SealedKitContext.Provider>
  );
  const one = () => source({ entries: [{ pluginId: "acme-render", entryId: "job" }], answers: { "acme-render/job": { text: "Rendering 4 of 9", icon: "sync", progress: 0.4 } } });
  test("shows under the strip while Clover is not in front, goes while it is, comes back; a waiting card takes the strip", async () => {
    const s = one();
    const view = render(closed([], s, false));
    await settle();
    const pill = view.container.querySelector(".clv-stripline")!;
    expect(pill).not.toBeNull();
    expect(pill.querySelector(".clv-line-from")?.textContent).toBe("acme-render");
    expect(pill.querySelector(".clv-line-text")?.textContent).toBe("Rendering 4 of 9");
    expect(pill.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("40");
    expect(pill.getAttribute("tabindex")).toBe("-1");
    // The window comes to the front: gone at once, and the plugin is not asked.
    view.rerender(closed([], s, true));
    await settle();
    expect(view.container.querySelector(".clv-stripline")).toBeNull();
    const asked = s.calls.length;
    await settle();
    expect(s.calls.length).toBe(asked);
    expect(s.watchers()).toBe(0);
    // And back.
    view.rerender(closed([], s, false));
    await settle();
    expect(view.container.querySelector(".clv-stripline")).not.toBeNull();
    // A card waiting takes the strip: no line, no asking.
    view.rerender(closed([APPROVAL], s, false));
    await settle();
    expect(view.container.querySelector(".clv-stripline")).toBeNull();
    expect(s.watchers()).toBe(0);
    view.unmount();
  });
  test("a click opens the island on Needs you; nothing is asked when no plugin fills the point, and no timer asks again", async () => {
    const s = one();
    const view = render(closed([], s));
    await settle();
    act(() => { (view.container.querySelector(".clv-stripline") as HTMLElement).click(); });
    await settle();
    expect(view.container.querySelector(".clv-open")).not.toBeNull();
    expect(view.container.querySelector(".clv-stripline")).toBeNull();
    view.unmount();
    const none = source({ entries: [], answers: {} });
    let entryCalls = 0;
    const src = { ...none.src, entries: async () => { entryCalls++; return []; } };
    const idle = render(
      <SealedKitContext.Provider value={kit}><Island shape={NOTCH} cards={[]} lines={src} timers={timers} /></SealedKitContext.Provider>,
    );
    await settle();
    expect(entryCalls).toBe(1);
    expect(none.calls).toEqual([]);
    expect(idle.container.querySelector(".clv-stripline")).toBeNull();
    // A plugin turned on (the registry changes): asked again at once.
    none.changed();
    await settle();
    expect(entryCalls).toBe(2);
    idle.unmount();
  });
  test("a bot starting work wakes a quiet sender", async () => {
    const work = new Set<() => void>();
    const answers: Record<string, unknown> = {};
    let calls = 0;
    const src: LineSource = {
      entries: async () => [{ pluginId: "alpha", entryId: "activity" }],
      call: async () => { calls++; return answers["a"]; },
      watchWork: (l) => { work.add(l); return () => void work.delete(l); },
    };
    const view = render(<SealedKitContext.Provider value={kit}><Island shape={NOTCH} cards={[]} lines={src} timers={timers} /></SealedKitContext.Provider>);
    await settle();
    expect(view.container.querySelector(".clv-stripline")).toBeNull();
    answers["a"] = { text: "Thinking", icon: "clock", bot: "alpha" };
    act(() => work.forEach((l) => l()));
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(view.container.querySelector(".clv-stripline .clv-line-text")?.textContent).toBe("Thinking");
    expect(calls).toBe(2);
    view.unmount();
    expect(work.size).toBe(0);
  });
});
