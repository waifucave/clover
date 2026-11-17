// The CardRouter conformance suite (spec revision 19, §3.5, ruling A). `runCardRouterConformance(make)` registers every
// case against the implementation `make` builds; `tests/card-router.test.ts` runs it against FakeCardRouter, and lane RT
// runs it against the engine's router. What it pins: conversation, strip, island, elsewhere; a report's expiry and drop;
// a moved card heard with where it was; and the press gate following the placement.
import { describe, expect, test } from "bun:test";
import { PRESENCE_TTL_MS, type PresenceReport } from "@waifucave/moss-protocol";
import { FakeClock } from "../fakes/clock";
import type { FakeCardRouter } from "../fakes/card-router";
import type { PlacementChange } from "../card-router";

export type CardRouterHarness = Pick<FakeCardRouter, keyof FakeCardRouter>;
export type CardRouterFactory = (...args: ConstructorParameters<typeof FakeCardRouter>) => CardRouterHarness;

const codeShows = (session: string | null, focused = true): PresenceReport => ({
  windows: [{ window: "main", focused, visible: true, showing: session === null ? null : { kind: "session", id: session } }],
});
const mossShows = (bot: string, focused = true): PresenceReport => ({ windows: [{ window: "moss", focused, visible: true, showing: { kind: "bot", id: bot } }] });

export function runCardRouterConformance(make: CardRouterFactory): void {
  function setup(hostLive = true) {
    const clock = new FakeClock();
    return { clock, router: make({ clock, hostLive }) };
  }

  describe("CardRouter", () => {
    test("no window reported (after an engine restart, too): the island draws it; with no host, it is elsewhere", () => {
      const { router } = setup();
      expect(router.pending({ id: "card_aaaaaa", session: "s_1" })).toEqual({ kind: "island" });
      router.hostLive(false);
      expect(router.placementOf("card_aaaaaa")).toEqual({ kind: "elsewhere" });
    });

    test("the focused window showing the card's session or bot draws it in the conversation; any other in its strip", () => {
      const { router } = setup();
      router.report({ connId: 1, program: "code" }, codeShows("s_1"));
      expect(router.pending({ id: "card_aaaaaa", session: "s_1" })).toEqual({ kind: "conversation", program: "code", window: "main" });
      expect(router.pending({ id: "card_bbbbbb", session: "s_2" })).toEqual({ kind: "strip", program: "code", window: "main" });
      expect(router.pending({ id: "card_cccccc", bot: "alpha" })).toEqual({ kind: "strip", program: "code", window: "main" });
      // A card with no session: the focused window's strip.
      expect(router.pending({ id: "card_dddddd", askedFrom: { program: "code", window: "main" } })).toEqual({ kind: "strip", program: "code", window: "main" });
      router.report({ connId: 2, program: "moss" }, mossShows("alpha"));
      router.report({ connId: 1, program: "code" }, codeShows("s_1", false));
      expect(router.placementOf("card_cccccc")).toEqual({ kind: "conversation", program: "moss", window: "moss" });
      expect(router.placementOf("card_aaaaaa")).toEqual({ kind: "strip", program: "moss", window: "moss" });
    });

    test("two reports both claiming focus: the newest wins, whichever connection reported first", () => {
      const { router } = setup();
      router.report({ connId: 1, program: "code" }, codeShows(null));
      router.report({ connId: 2, program: "moss" }, mossShows("alpha"));
      expect(router.pending({ id: "card_aaaaaa", session: "s_1" })).toEqual({ kind: "strip", program: "moss", window: "moss" });
      router.report({ connId: 1, program: "code" }, codeShows(null));
      expect(router.placementOf("card_aaaaaa")).toEqual({ kind: "strip", program: "code", window: "main" });
    });

    test("a card with no session asked from one window while another is focused: the focused window's strip (ruling 1)", () => {
      const { router } = setup();
      router.report({ connId: 1, program: "code" }, { windows: [{ window: "a", focused: false, visible: true, showing: null }, { window: "b", focused: true, visible: true, showing: { kind: "session", id: "s_1" } }] });
      expect(router.pending({ id: "card_aaaaaa", askedFrom: { program: "code", window: "a" } })).toEqual({ kind: "strip", program: "code", window: "b" });
      expect(router.pending({ id: "card_bbbbbb", askedFrom: { program: "moss", window: "moss" } })).toEqual({ kind: "strip", program: "code", window: "b" });
    });

    test("a window that is visible but not focused draws nothing: the island does", () => {
      const { router } = setup();
      router.report({ connId: 1, program: "code" }, codeShows("s_1", false));
      expect(router.pending({ id: "card_aaaaaa", session: "s_1" })).toEqual({ kind: "island" });
    });

    test("a report expires after its ttl or when its connection drops, and the cards move, heard with where they were", () => {
      const { clock, router } = setup();
      const moves: PlacementChange[] = [];
      router.watch((c) => moves.push(c));
      expect(router.report({ connId: 1, program: "code" }, codeShows("s_1"))).toEqual({ ttlMs: PRESENCE_TTL_MS });
      router.pending({ id: "card_aaaaaa", session: "s_1" });
      clock.advance(PRESENCE_TTL_MS - 1);
      expect(router.placementOf("card_aaaaaa")?.kind).toBe("conversation");
      // A fresh report holds it again.
      router.report({ connId: 1, program: "code" }, codeShows("s_1"));
      clock.advance(PRESENCE_TTL_MS - 1);
      expect(router.placementOf("card_aaaaaa")?.kind).toBe("conversation");
      clock.advance(1);
      expect(router.placementOf("card_aaaaaa")).toEqual({ kind: "island" });
      router.report({ connId: 1, program: "code" }, codeShows("s_1"));
      router.dropped(1);
      expect(router.placementOf("card_aaaaaa")).toEqual({ kind: "island" });
      expect(moves.map((m) => [m.place.kind, m.before?.kind])).toEqual([["conversation", undefined], ["island", "conversation"], ["conversation", "island"], ["island", "conversation"]]);
    });

    test("one place per card; an answered card leaves every place", () => {
      const { router } = setup();
      router.report({ connId: 1, program: "code" }, codeShows("s_1"));
      router.pending({ id: "card_aaaaaa", session: "s_1" });
      router.pending({ id: "card_bbbbbb", session: "s_2" });
      expect(router.list()).toEqual([
        { card: "card_aaaaaa", place: { kind: "conversation", program: "code", window: "main" } },
        { card: "card_bbbbbb", place: { kind: "strip", program: "code", window: "main" } },
      ]);
      router.resolved("card_aaaaaa");
      expect(router.placementOf("card_aaaaaa")).toBeUndefined();
      expect(router.list().map((c) => c.card)).toEqual(["card_bbbbbb"]);
    });

    test("the press gate follows the placement: the island only for a card placed there, a window only for its own", () => {
      const { router } = setup();
      router.pending({ id: "card_aaaaaa", session: "s_1" });
      expect(router.mayPress("card_aaaaaa", { kind: "island" })).toBe(true);
      expect(router.mayPress("card_aaaaaa", { kind: "window", program: "code", window: "main" })).toBe(false);
      router.report({ connId: 1, program: "code" }, codeShows("s_1"));
      expect(router.mayPress("card_aaaaaa", { kind: "island" })).toBe(false);
      expect(router.mayPress("card_aaaaaa", { kind: "window", program: "code", window: "main" })).toBe(true);
      // Never forwarded from one program to another.
      expect(router.mayPress("card_aaaaaa", { kind: "window", program: "moss", window: "main" })).toBe(false);
      expect(router.mayPress("card_unknown", { kind: "island" })).toBe(false);
    });
  });
}
