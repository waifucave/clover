import { expect, test } from "bun:test";
import { drawerExempt, overlayStandsDown, surfacesReport } from "../src/main/host-stacking";
import { SealedFrames } from "../src/main/sealed";

test("R12: while any card is pending every third-party on-screen part stands down, floating or not; the tree's never does", () => {
  expect(overlayStandsDown({ pluginId: "acceptance-hold" }, true)).toBe(true);
  expect(overlayStandsDown({ pluginId: "acceptance-tab" }, true)).toBe(true);
  expect(overlayStandsDown({ pluginId: "acceptance-hold" }, false)).toBe(false);
  expect(overlayStandsDown({ pluginId: "moss" }, true)).toBe(false);
});

test("the surfaces report lists the visible ones only, bounded", () => {
  const wins = Array.from({ length: 70 }, (_, i) => ({ id: `s${i}`, visible: i !== 0, bounds: { x: i, y: 0, width: 10, height: 5 } }));
  const r = surfacesReport(wins);
  expect(r.length).toBe(64);
  expect(r[0]).toEqual({ id: "s1", x: 1, y: 0, width: 10, height: 5 });
});

// The reviewer's point 1: the stand-down holds for a card pending ANYWHERE on this computer. The host's store takes every
// `card_requested` the engine sends it (the engine sends each card to every app connection, wherever the router places it:
// packages/core/src/host/tests/door.test.ts), with no placement in it; the host restacks as the card arrives, before its
// buttons can show in any program, and its parts come back on `card_resolved`, however the card was answered.
test("R12 across programs: a card placed in MOSS Code's window or MOSS's hides the host's third-party parts until it is answered there", () => {
  for (const placed of ["code", "moss"]) {
    const store = new SealedFrames(() => 1_000);
    const overlay = { pluginId: "acme-overlay" };
    expect(overlayStandsDown(overlay, store.anyPending())).toBe(false);
    store.fromCore({ id: `card_${placed}`, kind: "tool", hash: "h", options: [{ id: "approve", kind: "approve" }, { id: "deny", kind: "deny" }], fields: {}, issuedAt: 1, expiresAt: null });
    expect(overlayStandsDown(overlay, store.anyPending())).toBe(true);
    store.resolvedOutcome(`card_${placed}`, "approved");
    expect(overlayStandsDown(overlay, store.anyPending())).toBe(false);
    store.fromCore({ id: `card_${placed}_2`, kind: "tool", hash: "h", options: [{ id: "approve", kind: "approve" }], fields: {}, issuedAt: 1, expiresAt: null });
    store.resolvedOutcome(`card_${placed}_2`, "withdrawn");
    expect(store.anyPending()).toBe(false);
  }
});

// The controller's ruling (raised by lane RT, row 65), with the reviewer's B1: only the island's drawer (approvals.all and
// window.cards), holding a frame of a card the router placed on this program's island that it may draw, is not stood down.
const card = (id: string) => ({ id, kind: "tool", hash: "h", options: [{ id: "approve", kind: "approve" }, { id: "deny", kind: "deny" }], fields: {}, issuedAt: 1, expiresAt: null });
function world() {
  const store = new SealedFrames(() => 1_000);
  const placed = new Map<string, string>();
  const down = (s: { pluginId: string; cards: boolean; windowId: number }) => overlayStandsDown(s, store.anyPending(), drawerExempt(s, store.pendingHeldIn(s.windowId), (id) => placed.get(id) === "island", (id) => placed.get(id) === "island"));
  return { store, placed, down };
}
const copyIsland = { pluginId: "acme-island", cards: true, windowId: 7 };
const otherPart = { pluginId: "acme-overlay", cards: false, windowId: 8 };

test("R12: the copy island, the island's drawer, stays while it holds a frame of the card placed on the island; other parts stand down", () => {
  const w = world();
  w.store.fromCore(card("card_ok"));
  w.placed.set("card_ok", "island");
  expect([w.down(copyIsland), w.down(otherPart)]).toEqual([true, true]);
  w.store.mint("card_ok", "button:approve", undefined, copyIsland.windowId);
  expect([w.down(copyIsland), w.down(otherPart)]).toEqual([false, true]);
  w.store.resolvedOutcome("card_ok", "approved");
  expect([w.down(copyIsland), w.down(otherPart)]).toEqual([false, false]);
  expect(overlayStandsDown({ pluginId: "moss" }, true, false)).toBe(false);
});

test("B1: a part with plain approvals that mints frames of its own bot's card is no drawer: hidden while the island holds another card", () => {
  const w = world();
  const botPart = { pluginId: "acme-bot", cards: false, windowId: 9 };
  w.store.fromCore(card("card_island"));
  w.placed.set("card_island", "island");
  w.store.fromCore({ ...card("card_bot"), bot: "acme-bot" });
  w.placed.set("card_bot", "strip");
  w.store.mint("card_bot", "button:approve", undefined, botPart.windowId);
  w.store.mint("card_bot", "button:deny", undefined, botPart.windowId);
  expect(w.down(botPart)).toBe(true);
  // Even its own card placed on the island does not make it the drawer: it declares no window.cards (or lacks approvals.all).
  w.placed.set("card_bot", "island");
  expect(w.down(botPart)).toBe(true);
});

test("B1: two cards in two places: only the island-placed card's drawer is exempt, and a drawer holding only a card placed elsewhere is not", () => {
  const w = world();
  w.store.fromCore(card("card_a"));
  w.store.fromCore(card("card_b"));
  w.placed.set("card_a", "island");
  w.placed.set("card_b", "conversation");
  const otherDrawer = { pluginId: "acme-island-two", cards: true, windowId: 11 };
  w.store.mint("card_b", "button:approve", undefined, otherDrawer.windowId);
  expect(w.down(otherDrawer)).toBe(true);
  w.store.mint("card_a", "button:approve", undefined, copyIsland.windowId);
  expect([w.down(copyIsland), w.down(otherDrawer)]).toEqual([false, true]);
  // card_a moves to the window: the copy island holds no island-placed card any more and stands down too.
  w.placed.set("card_a", "strip");
  expect(w.down(copyIsland)).toBe(true);
});

test("S: a card resolved while the connection was down is dropped after the reconnect's list, and the parts come back", () => {
  const w = world();
  w.store.fromCore(card("card_gone"));
  w.placed.set("card_gone", "island");
  expect(w.down(otherPart)).toBe(true);
  // The socket dropped; the card was answered elsewhere meanwhile (its card_resolved reached no one). On the reconnect:
  const before = w.store.pendingIds();
  // A card raised during the connect (heard before the list's answer was handled) is not in `before`: never dropped.
  w.store.fromCore(card("card_new"));
  expect(w.store.dropUnlisted(before, [])).toEqual(["card_gone"]);
  expect(w.store.isPending("card_new")).toBe(true);
  w.store.resolvedOutcome("card_new", "approved");
  expect(w.down(otherPart)).toBe(false);
  // A list that names the card keeps it.
  w.store.fromCore(card("card_kept"));
  expect(w.store.dropUnlisted(["card_kept"], ["card_kept"])).toEqual([]);
  expect(w.down(otherPart)).toBe(true);
});

test("S: the stand-down is decided again at the earliest expiry (no event comes when a card expires)", () => {
  let now = 1_000;
  const store = new SealedFrames(() => now);
  store.fromCore({ ...card("card_a"), expiresAt: 5_000 });
  store.fromCore({ ...card("card_b"), expiresAt: 3_000 });
  store.fromCore(card("card_c"));
  expect(store.nextExpiry()).toBe(3_000);
  store.resolvedOutcome("card_c", "approved");
  now = 3_000;
  expect(store.nextExpiry()).toBe(5_000);
  now = 5_000;
  expect(store.nextExpiry()).toBeUndefined();
  expect(overlayStandsDown(otherPart, store.anyPending())).toBe(false);
});
