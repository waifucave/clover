import { describe, expect, test } from "bun:test";
import { mossFront, FrontWatcher, islandMayDraw, placeCard, placeFromEngine, placeLine, presenceOf, pressMayBeTaken, showingOf, type WatchedWindow } from "../src/main/card-place";
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
    expect(islandMayDraw(undefined, false)).toBe(true);
    expect(islandMayDraw(undefined, true)).toBe(false);
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

/** Fake windows and a fake clock: focus moves between MOSS's own windows and out to another app. */
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
  const front = () => { const s = mossFront(main, cardOpen ? [card] : []); return s.exists && s.visible && !s.minimized && s.focused; };
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

describe("the app's own card is MOSS's own window: answering it is not leaving the window", () => {
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
    expect(pressMayBeTaken({ from: "window", placed: undefined, front: w.front() })).toBe(true);
    // Back to the main window and onto the card again: still MOSS.
    w.card.focused = false; w.main.focused = true;
    w.watcher.event();
    w.advance(500);
    expect(w.moves).toEqual([true]);
    // Another app comes in front: nothing of MOSS has the focus; after the beat the card moves to the island.
    w.main.focused = false;
    w.watcher.event();
    expect(w.moves).toEqual([true]);
    w.advance(200);
    expect(w.moves).toEqual([true, false]);
    expect(placeCard({ front: w.front(), drawnInWindow: false })).toBe("island");
    // The island's frame is refused while MOSS is in front, and not otherwise.
    expect(pressMayBeTaken({ from: "island", placed: undefined, front: true })).toBe(false);
    expect(pressMayBeTaken({ from: "island", placed: undefined, front: false })).toBe(true);
  });

  test("reading only the main window (the first version) moved the card on the click that was meant to answer it", () => {
    const main = { isDestroyed: () => false, isFocused: () => false, isVisible: () => true, isMinimized: () => false };
    const card = { isDestroyed: () => false, isFocused: () => true, isVisible: () => true, isMinimized: () => false };
    expect(mossFront(main, []).focused).toBe(false);
    expect(mossFront(main, [card]).focused).toBe(true);
    expect(mossFront(undefined, [card]).exists).toBe(false);
  });
});

describe("lane RT: the engine's router places the card, and the press gate follows the placement", () => {
  const strip = { kind: "strip", program: "code", window: "main" } as const;
  const conversation = { kind: "conversation", program: "code", window: "main" } as const;
  const island = { kind: "island" } as const;

  test("the engine's place: the conversation; the strip (unless the conversation on screen draws it); the island", () => {
    expect(placeFromEngine(conversation, { front: true, drawnInWindow: false })).toBe("conversation");
    expect(placeFromEngine(strip, { front: true, drawnInWindow: false })).toBe("window");
    expect(placeFromEngine(strip, { front: true, drawnInWindow: true })).toBe("conversation");
    expect(placeFromEngine(island, { front: true, drawnInWindow: true })).toBe("island");
    expect(placeFromEngine({ kind: "elsewhere" }, { front: false, drawnInWindow: false })).toBe("island");
    // Before the engine has placed it: the old rule.
    expect(placeFromEngine(undefined, { front: false, drawnInWindow: true })).toBe("island");
  });

  test("the island draws only a card placed on it, whatever the window's focus", () => {
    expect(islandMayDraw(island, true)).toBe(true);
    expect(islandMayDraw(strip, false)).toBe(false);
    expect(islandMayDraw(conversation, false)).toBe(false);
  });

  test("the press gate follows the placement, never focus; the fallback card answers wherever the card is", () => {
    expect(pressMayBeTaken({ from: "island", placed: island, front: true })).toBe(true);
    expect(pressMayBeTaken({ from: "island", placed: strip, front: false })).toBe(false);
    expect(pressMayBeTaken({ from: "window", placed: strip, front: false })).toBe(true);
    expect(pressMayBeTaken({ from: "window", placed: island, front: true })).toBe(false);
    expect(pressMayBeTaken({ from: "window", placed: { kind: "strip", program: "moss", window: "moss" }, front: true })).toBe(false);
    expect(pressMayBeTaken({ from: "fallback", placed: island, front: true })).toBe(true);
  });

  test("presence: the one window, focused when in front, what its tab shows; Settings over it shows nothing", () => {
    expect(showingOf({ tab: { kind: "bot", id: "alpha" } })).toEqual({ kind: "bot", id: "alpha" });
    expect(showingOf({ tab: { kind: "agent", id: "s_1" } })).toEqual({ kind: "session", id: "s_1" });
    expect(showingOf({ tab: { kind: "bot", id: "alpha" }, dialog: "settings" })).toBeNull();
    expect(showingOf({ tab: { kind: "plugins" } })).toBeNull();
    expect(showingOf(undefined)).toBeNull();
    expect(presenceOf({ exists: true, visible: true, minimized: false, front: true }, { kind: "bot", id: "alpha" })).toEqual({ windows: [{ window: "main", focused: true, visible: true, showing: { kind: "bot", id: "alpha" } }] });
    expect(presenceOf({ exists: true, visible: true, minimized: true, front: false }, null)).toEqual({ windows: [{ window: "main", focused: false, visible: false, showing: null }] });
    expect(presenceOf({ exists: false, visible: false, minimized: false, front: false }, null)).toEqual({ windows: [] });
  });
});

import { PresenceReporter, type PresenceSent } from "../src/main/card-place";
import { EngineCardRouter } from "../../../packages/core/src/surfaces/card-router";
import { FakeClock } from "../../../packages/core/src/contracts/fakes/clock";
import type { CardPlacement, PresenceReport } from "@waifucave/moss-protocol";

describe("lane RT: a press right after a focus change is taken at once (one press, never 'press again')", () => {
  /** The engine's real router behind a connection that, like the core, hands the app every `card_placed` before it answers the
   *  report (here: the app's own placements map is updated inside `send`, before it resolves), a beat later than the call. */
  function world() {
    const router = new EngineCardRouter({ clock: new FakeClock(), hostLive: true });
    const placed = new Map<string, CardPlacement>();
    router.watch((c) => placed.set(c.card, c.place));
    let front = false;
    const sent: PresenceReport[] = [];
    const reporter = new PresenceReporter({
      read: () => ({ exists: true, visible: true, minimized: false, front }),
      showing: () => ({ kind: "bot", id: "alpha" }),
      send: async (report): Promise<PresenceSent> => {
        sent.push(report);
        await new Promise((r) => setTimeout(r, 20));
        router.report({ connId: 1, program: "code" }, report);
        return "sent";
      },
    });
    return { router, placed, reporter, sent, focus: () => { front = true; } };
  }

  test("the card is on the island; the window comes to the front and the watcher hasn't settled yet: one press in the conversation answers", async () => {
    const w = world();
    await w.reporter.report();
    w.router.pending({ id: "card_aaaaaa", bot: "alpha" });
    expect(w.placed.get("card_aaaaaa")).toEqual({ kind: "island" });
    // The person clicks the window: it comes to the front, and the press lands before the front watcher has said so.
    w.focus();
    await w.reporter.beforePress();
    expect(w.placed.get("card_aaaaaa")).toEqual({ kind: "conversation", program: "code", window: "main" });
    expect(pressMayBeTaken({ from: "window", placed: w.placed.get("card_aaaaaa"), front: true })).toBe(true);
  });

  test("the watcher settled first and its report is still on its way: the press waits for it, then is taken", async () => {
    const w = world();
    await w.reporter.report();
    w.router.pending({ id: "card_aaaaaa", bot: "alpha" });
    w.focus();
    w.reporter.settled(true);
    void w.reporter.report();
    // Before the report's answer the app still has the island's place; the press waits for the report on its way.
    expect(w.placed.get("card_aaaaaa")).toEqual({ kind: "island" });
    await w.reporter.beforePress();
    expect(pressMayBeTaken({ from: "window", placed: w.placed.get("card_aaaaaa"), front: true })).toBe(true);
    // One report for the focus change, not a second one for the press.
    expect(w.sent.filter((r) => r.windows[0]?.focused === true)).toHaveLength(1);
  });

  test("a click onto the window's own strip (neither window focused for an instant) never reports the window as left", async () => {
    const w = world();
    w.focus();
    w.reporter.settled(true);
    await w.reporter.report();
    // The instant reads unfocused, but the watcher hasn't settled out: the next report still says focused.
    await w.reporter.report();
    expect(w.sent.map((r) => r.windows[0]?.focused)).toEqual([true, true]);
  });
});
