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
    const state = { entries: [{ pluginId: "acme-render", entryId: "job" }], answers: { "acme-render/job": { text: "Rendering frame 4 of 9", icon: "sync", progress: 0.44, bot: "alpha" } } as Record<string, unknown> };
    const s = source(state);
    const view = render(
      <SealedKitContext.Provider value={kit}>
        <Island shape={NOTCH} cards={[]} alwaysOpen lines={s.src} botName={(id) => (id === "alpha" ? "Alpha" : undefined)} timers={timers} />
      </SealedKitContext.Provider>,
    );
    await settle();
    const row = view.container.querySelector(".clv-line")!;
    expect(row).not.toBeNull();
    expect(row.querySelector(".clv-line-from")?.textContent).toBe("acme-render · Alpha");
    expect(row.querySelector(".clv-line-text")?.textContent).toBe("Rendering frame 4 of 9");
    expect(row.querySelector("svg[data-glyph=sync]")).not.toBeNull();
    const bar = row.querySelector("[role=progressbar]")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("44");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("44%");
    // The empty state gives way to the line; nothing else of the sender is drawn (no markup, no style of its own).
    expect(view.container.textContent).not.toContain("Nothing needs you");
    expect(row.getAttribute("style")).toBeNull();
    // An update shows when the entries change (the point's watch) or at the next ask.
    state.answers["acme-render/job"] = { text: "Rendering frame 5 of 9", progress: 0.55 };
    act(() => s.changed());
    await settle();
    expect(view.container.querySelector(".clv-line-text")?.textContent).toBe("Rendering frame 5 of 9");
    expect(view.container.querySelector("svg[data-glyph=sync]")).toBeNull();
    // The sender removes its line: nothing is drawn; its plugin turned off: its entry is gone.
    state.answers["acme-render/job"] = null;
    act(() => s.changed());
    await settle();
    expect(view.container.querySelector(".clv-line")).toBeNull();
    expect(view.container.textContent).toContain("Nothing needs you");
    state.answers["acme-render/job"] = { text: "back" };
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
  test("a card still shows exactly as before, below the lines; a sender cannot make the closed island ask for anything", async () => {
    const s = source({ entries: [{ pluginId: "p", entryId: "x" }], answers: { "p/x": { text: "hello" } } });
    const open = render(
      <SealedKitContext.Provider value={kit}>
        <Island shape={NOTCH} cards={[APPROVAL]} alwaysOpen lines={s.src} timers={timers} />
      </SealedKitContext.Provider>,
    );
    await settle();
    const lines = open.container.querySelector(".clv-lines")!;
    const needs = open.container.querySelector(".clv-needs")!;
    expect(lines.compareDocumentPosition(needs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
