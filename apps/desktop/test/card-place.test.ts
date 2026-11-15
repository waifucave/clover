import { describe, expect, test } from "bun:test";
import { cloverFront, FrontWatcher, islandMayDraw, placeCard, placeLine, pressMayBeTaken, type WatchedWindow } from "../src/main/card-place";
import { SealedFrames } from "../src/main/sealed";

/** The app's bookkeeping for where a pending card is drawn, as index.ts keeps it, over a fake front state: the three
 *  placements and each move, one place at a time. */
function app() {
  let front = false;
  const draws = new Set<string>();
  const places = new Map<string, ReturnType<typeof placeCard>>();
  const log: string[] = [];
  const place = (id: string) => {
    const now = placeCard({ front, drawnInWindow: draws.has(id) });
    const before = places.get(id);
    if (before === now) return;
    places.set(id, now);
    log.push(placeLine(id, now, before));
  };
  return {
    log, places,
    set(next: boolean, pending: string[]) { front = next; for (const id of pending) place(id); },
    arrive: (id: string) => place(id),
    asked: (id: string) => { draws.add(id); place(id); },
  };
}

describe("where a pending card is drawn", () => {
  test("the window in front: the conversation that draws it, else the window's own card; not in front: the island", () => {
    expect(placeCard({ front: true, drawnInWindow: true })).toBe("conversation");
    expect(placeCard({ front: true, drawnInWindow: false })).toBe("window");
    expect(placeCard({ front: false, drawnInWindow: true })).toBe("island");
    expect(placeCard({ front: false, drawnInWindow: false })).toBe("island");
  });

  test("the island may draw only while the window is not in front", () => {
    expect(islandMayDraw(false)).toBe(true);
    expect(islandMayDraw(true)).toBe(false);
  });

  test("three placements, one line each: where it went and why", () => {
    const a = app();
    a.set(true, []);
    a.asked("c-conv");
    a.arrive("c-plugin");
    a.set(false, []);
    a.arrive("c-island");
    expect(a.places.get("c-conv")).toBe("conversation");
    expect(a.places.get("c-plugin")).toBe("window");
    expect(a.places.get("c-island")).toBe("island");
    expect(a.log).toEqual([
      "card: c-conv shown in the conversation (window foreground)",
      "card: c-plugin shown in the window's own card (window foreground, no conversation draws it)",
      "card: c-island shown on the island (window not foreground)",
    ]);
  });

  test("the move: the window comes forward and the island lets go, the window goes back and the island takes it; never both, never neither", () => {
    const a = app();
    a.arrive("c1");
    a.arrive("c2");
    a.asked("c2"); // its conversation draws it in place (not in front: still the island's)
    expect([a.places.get("c1"), a.places.get("c2")]).toEqual(["island", "island"]);
    a.set(true, ["c1", "c2"]);
    expect([a.places.get("c1"), a.places.get("c2")]).toEqual(["window", "conversation"]);
    a.set(false, ["c1", "c2"]);
    expect([a.places.get("c1"), a.places.get("c2")]).toEqual(["island", "island"]);
    expect(a.log.slice(-4)).toEqual([
      "card: c1 moved to the window's own card (window foreground) from the island",
      "card: c2 moved to the conversation (window foreground) from the island",
      "card: c1 moved to the island (window not foreground) from the window's own card",
      "card: c2 moved to the island (window not foreground) from the conversation",
    ]);
    // A conversation that comes to draw a card the window's own card was showing takes it over.
    a.set(true, ["c1"]);
    a.asked("c1");
    expect(a.places.get("c1")).toBe("conversation");
  });

  test("the store lists the cards still waiting, oldest first", () => {
    const s = new SealedFrames(() => 1000);
    const card = (id: string, expiresAt: number | null = null) => ({ id, hash: "h", kind: "tool", options: [], issuedAt: 1, expiresAt });
    s.fromCore(card("a"));
    s.fromCore(card("b"));
    s.fromCore(card("old", 500));
    s.resolvedOutcome("a", { kind: "cancelled" } as never);
    expect(s.pendingIds()).toEqual(["b"]);
  });
});

/** Fake windows and a fake clock: focus moves between Clover's own windows and out to another app. */
function windows() {
  const win = (focused: boolean) => {
    const w = { focused, destroyed: false, isDestroyed: (): boolean => w.destroyed, isFocused: (): boolean => w.focused, isVisible: () => true, isMinimized: () => false };
    return w satisfies WatchedWindow;
  };
  const main = win(true);
  const card = win(false);
  let cardOpen = false;
  const timers: { at: number; fn: () => void }[] = [];
  let clock = 0;
  const moves: boolean[] = [];
  const front = () => { const s = cloverFront(main, cardOpen ? [card] : []); return s.exists && s.visible && !s.minimized && s.focused; };
  const watcher = new FrontWatcher({
    read: front,
    changed: (f) => moves.push(f),
    settleMs: 120,
    setTimer: ((fn: () => void, ms: number) => { const t = { at: clock + ms, fn }; timers.push(t); return t; }) as never,
    clearTimer: ((t: { at: number }) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); }) as never,
  });
  return {
    main, card, moves, front, watcher,
    openCard() { cardOpen = true; },
    advance(ms: number) { clock += ms; for (const t of [...timers]) if (t.at <= clock) { timers.splice(timers.indexOf(t), 1); t.fn(); } },
  };
}

describe("the app's own card is Clover's own window: answering it is not leaving the window", () => {
  test("main in front, an unowned card shown as the app's own card: the card takes focus and main blurs, the card stays and its press is taken; focus to another app, it moves to the island", () => {
    const w = windows();
    w.watcher.event();
    expect(w.moves).toEqual([true]);
    // The card is the window's own card (nothing in the main window draws it) and is shown, unfocused.
    expect(placeCard({ front: w.front(), drawnInWindow: false })).toBe("window");
    w.openCard();
    w.watcher.event();
    // The user's first click: the card window takes focus, the main window blurs (the blur is seen first, with nothing focused for an instant).
    w.main.focused = false;
    w.watcher.event();
    w.advance(30);
    w.card.focused = true;
    w.watcher.event();
    w.advance(500);
    expect(w.moves).toEqual([true]);
    expect(placeCard({ front: w.front(), drawnInWindow: false })).toBe("window");
    expect(pressMayBeTaken({ fromIsland: false, front: w.front() })).toBe(true);
    // Back to the main window and onto the card again: still Clover.
    w.card.focused = false; w.main.focused = true;
    w.watcher.event();
    w.advance(500);
    expect(w.moves).toEqual([true]);
    // Another app comes in front: nothing of Clover has the focus; after the beat the card moves to the island.
    w.main.focused = false;
    w.watcher.event();
    expect(w.moves).toEqual([true]);
    w.advance(200);
    expect(w.moves).toEqual([true, false]);
    expect(placeCard({ front: w.front(), drawnInWindow: false })).toBe("island");
    // The island's frame is refused while Clover is in front, and not otherwise.
    expect(pressMayBeTaken({ fromIsland: true, front: true })).toBe(false);
    expect(pressMayBeTaken({ fromIsland: true, front: false })).toBe(true);
  });

  test("reading only the main window (the first version) moved the card on the click that was meant to answer it", () => {
    const main = { isDestroyed: () => false, isFocused: () => false, isVisible: () => true, isMinimized: () => false };
    const card = { isDestroyed: () => false, isFocused: () => true, isVisible: () => true, isMinimized: () => false };
    expect(cloverFront(main, []).focused).toBe(false);
    expect(cloverFront(main, [card]).focused).toBe(true);
    expect(cloverFront(undefined, [card]).exists).toBe(false);
  });
});
