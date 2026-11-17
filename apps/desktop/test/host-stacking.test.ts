import { expect, test } from "bun:test";
import { overlayStandsDown, surfacesReport } from "../src/main/host-stacking";
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
