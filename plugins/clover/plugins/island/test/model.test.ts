import { describe, expect, test } from "bun:test";
import { guestTabs, isOwnPlugin, isReservedPluginName, isReservedTab } from "../src/model/tabs";
import { nameSkeleton, readsAs, shownName } from "../src/model/names";
import {
  cardGeometry,
  islandRect,
  ISLAND,
  LIQUID,
  showsWings,
  stripAction,
  stripPartAt,
  stripRect,
  tabForPart,
  topInset,
  waitingRect,
  type ScreenShape,
} from "../src/model/geometry";
import { fluidFrame, fluidSeconds, FLUID } from "../src/model/fluid";
import { beginClosing, beginOpening, clampedShoulder, edgeShapePath, morphFrame, morphSeconds, MORPH } from "../src/model/morph";
import { IslandQueue } from "../src/model/queue";
import { NEEDS_YOU, select, selectedTab, showsDots, swipe, tabState } from "../src/model/tabs";
import { grownFromTop, hoverScale, isOver, unscaled } from "../src/model/hover";
import { criticalSpring, spring, springEasing } from "../src/model/curves";
import {
  chooseOption,
  draftComplete,
  emptyDraft,
  questionAnswers,
  questionHeader,
  questionPosition,
  sealedButtons,
  typeOther,
  waitingLine,
  type Question,
  type QuestionCard,
} from "../src/model/cards";

const notch: ScreenShape = { housing: { width: 185, height: 32 }, menuBarHeight: 32 };
const bare: ScreenShape = { housing: null, menuBarHeight: 24 };

describe("the strip", () => {
  test("is exactly the housing while nothing waits or works, and absent without one", () => {
    expect(stripRect(notch, false)).toEqual({ x: -92.5, y: 0, width: 185, height: 32 });
    expect(stripRect(bare, false)).toBeNull();
  });

  test("grows its wings, or hangs a tab without a housing, while something waits", () => {
    expect(stripRect(notch, true)).toEqual({ x: -138.5, y: 0, width: 277, height: 32 });
    expect(stripRect(bare, true)).toEqual({ x: -56, y: 0, width: 112, height: 24 });
    expect(stripRect({ housing: null, menuBarHeight: 12 }, true)?.height).toBe(22);
  });

  test("maps a click to its parts; an empty wing is the housing's", () => {
    const both = { waiting: 2, working: 1 };
    expect(stripPartAt({ x: -120, y: 10 }, notch, both)).toBe("waitingWing");
    expect(stripPartAt({ x: 0, y: 10 }, notch, both)).toBe("housing");
    expect(stripPartAt({ x: 120, y: 10 }, notch, both)).toBe("workingWing");
    expect(stripPartAt({ x: 120, y: 10 }, notch, { waiting: 2, working: 0 })).toBe("housing");
    expect(stripPartAt({ x: 200, y: 10 }, notch, both)).toBeNull();
    expect(stripPartAt({ x: -20, y: 5 }, bare, both)).toBe("waitingWing");
    expect(stripPartAt({ x: 20, y: 5 }, bare, both)).toBe("workingWing");
    expect(stripPartAt({ x: 20, y: 5 }, bare, { waiting: 1, working: 0 })).toBe("waitingWing");
  });

  test("a click opens, switches tab, or closes", () => {
    const tabs = { needsYou: "needs-you", working: "bots" };
    expect(tabForPart("waitingWing", tabs)).toBe("needs-you");
    expect(tabForPart("housing", tabs)).toBeNull();
    expect(stripAction("needs-you", false, null)).toEqual({ kind: "open", tab: "needs-you" });
    expect(stripAction("bots", true, "needs-you")).toEqual({ kind: "select", tab: "bots" });
    expect(stripAction("needs-you", true, "needs-you")).toEqual({ kind: "close" });
    expect(stripAction(null, true, "needs-you")).toEqual({ kind: "close" });
  });

  test("shows its wings only with something to say", () => {
    expect(showsWings({ waiting: 0, working: 0 })).toBe(false);
    expect(showsWings({ waiting: 0, working: 3 })).toBe(true);
  });
});

describe("the open island's rect", () => {
  test("is one size, hanging from the top", () => {
    expect(islandRect(notch)).toEqual({ x: -280, y: 0, width: 560, height: 168 });
  });

  test("clamps on a short screen, the same for every tab", () => {
    expect(islandRect(notch, 300).height).toBe(192 > 168 ? 168 : 192);
    expect(islandRect(notch, 250).height).toBe(168);
    expect(islandRect(bare, 100).height).toBe(168);
    expect(islandRect(notch, 200).height).toBe(168);
  });
});

describe("a card's geometry", () => {
  const g = cardGeometry(notch, { width: 400, height: 120 }, { rounded: true });

  test("rests just below the housing, centred, inside a shadow margin", () => {
    expect(g.card).toEqual({ x: 24, y: 42, width: 400, height: 120 });
    expect(g.panelSize).toEqual({ width: 448, height: 186 });
    expect(g.source).toEqual({ x: 131.5, y: 0, width: 185, height: 32 });
    expect(g.sourceIsHousing).toBe(true);
    expect(g.cornerRadius).toBe(ISLAND.cardCorner);
  });

  test("without a housing is born from a band at the top edge", () => {
    const b = cardGeometry(bare, { width: 400, height: 120 }, { rounded: false });
    expect(b.card.y).toBe(24 + LIQUID.gap);
    expect(b.source.height).toBe(0);
    expect(b.sourceIsHousing).toBe(false);
    expect(b.cornerRadius).toBeNull();
  });

  test("puts the waiting pill just below it", () => {
    expect(waitingRect(g)).toEqual({ x: 84, y: 170, width: 280, height: 32 });
  });

  test("topInset is the housing's height, else the menu bar's", () => {
    expect(topInset(notch)).toBe(32);
    expect(topInset({ housing: null, menuBarHeight: 10 })).toBe(22);
  });
});

describe("the liquid birth", () => {
  test("without a housing (Windows, Linux, a screen with no notch) the card is born from the screen's top edge", () => {
    const g = cardGeometry(bare, { width: 400, height: 120 }, { rounded: true });
    expect(g.sourceIsHousing).toBe(false);
    expect(g.source.y).toBe(0);
    expect(g.source.height).toBe(0);
    // Top centre: the source sits in the middle of the card's panel.
    expect(g.source.x + g.source.width / 2).toBeCloseTo(g.panelSize.width / 2, 6);
    const early = fluidFrame(g, 0.06);
    // The liquid hangs from the top edge: its band reaches up past y = 0 and falls from there.
    expect(Math.min(...early.blobs.map((b) => b.rect.y))).toBeLessThan(0);
    const rest = fluidFrame(g, FLUID.settle).card;
    for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(rest[key] - g.card[key])).toBeLessThan(2);
  });

  const g = cardGeometry(notch, { width: 400, height: 120 }, { rounded: true });

  test("starts inside the housing and ends as the card at rest", () => {
    const start = fluidFrame(g, 0);
    expect(start.crisp).toBe(0);
    expect(start.content).toBe(0);
    expect(start.blobs[0]!.rect.y).toBeLessThan(0);
    const end = fluidFrame(g, FLUID.settle);
    expect(end.crisp).toBe(1);
    expect(end.content).toBeCloseTo(1, 6);
    expect(end.card.width).toBeCloseTo(400, 0);
    expect(end.card.height).toBeCloseTo(120, 0);
  });

  test("the neck parts, and the melt thins, before the card turns crisp", () => {
    const parted = fluidFrame(g, FLUID.tailFade.to + 0.01);
    const necks = parted.blobs.filter((b) => b.shape.kind === "ellipse" && b.rect.width < 400);
    expect(necks.length).toBe(0);
    expect(fluidFrame(g, FLUID.meltEnd.to).blur).toBe(0);
  });

  test("never shows content before the shape has nearly settled, and fades it in monotonically", () => {
    let last = 0;
    for (let t = 0; t <= FLUID.settle; t += 0.02) {
      const f = fluidFrame(g, t);
      if (t < FLUID.contentIn.from) expect(f.content).toBe(0);
      expect(f.content).toBeGreaterThanOrEqual(last - 1e-9);
      last = f.content;
    }
  });

  test("a second card grows in place, from nothing", () => {
    const second = cardGeometry(notch, { width: 400, height: 44 }, { rounded: false, slot: 1 });
    expect(second.floating).toBe(true);
    const f = fluidFrame(second, 0);
    expect(f.blobs.every((b) => b.rect.width === 0 || b.rect.height === 0) || f.blobs.length === 0).toBe(true);
  });

  test("its clock runs forward, then back up faster", () => {
    expect(fluidSeconds(1000, null, null)).toBe(0);
    expect(fluidSeconds(1500, 1000, null)).toBeCloseTo(0.5, 6);
    expect(fluidSeconds(9000, 1000, null)).toBe(FLUID.settle);
    expect(fluidSeconds(2200, 1000, 2000)).toBeCloseTo(1.2 - 0.2 * FLUID.returnSpeed, 6);
    expect(fluidSeconds(9000, 1000, 2000)).toBe(0);
  });
});

describe("the open morph", () => {
  const source = stripRect(notch, true)!;
  const target = islandRect(notch);
  const m = { source, target, sourceCorner: ISLAND.stripCorner, targetCorner: ISLAND.islandCorner };

  test("rests exactly at the island, contents in", () => {
    const f = morphFrame(m, MORPH.settle);
    expect(f.rect).toEqual(target);
    expect(f.corner).toBe(ISLAND.islandCorner);
    expect(f.shoulder).toBe(ISLAND.islandShoulder);
    expect(f.content).toBe(1);
    expect(f.blur).toBe(0);
  });

  test("keeps its top flush with the screen's edge on every frame and never overshoots", () => {
    let lastW = 0;
    let lastH = 0;
    for (let i = 0; i <= 120; i++) {
      const f = morphFrame(m, (MORPH.settle * i) / 120);
      expect(f.rect.y).toBe(0);
      expect(f.rect.width).toBeLessThanOrEqual(target.width + 1e-9);
      expect(f.rect.height).toBeLessThanOrEqual(target.height + 1e-9);
      expect(f.rect.width).toBeGreaterThanOrEqual(lastW - 1e-9);
      expect(f.rect.height).toBeGreaterThanOrEqual(lastH - 1e-9);
      expect(f.rect.x + f.rect.width / 2).toBeCloseTo(0, 6);
      expect(f.shoulder).toBeLessThanOrEqual(f.rect.height / 2 + 1e-9);
      lastW = f.rect.width;
      lastH = f.rect.height;
    }
  });

  test("fades its contents in only once the shape has mostly grown", () => {
    expect(morphFrame(m, MORPH.contentIn.from - 0.01).content).toBe(0);
    expect(morphFrame(m, MORPH.contentIn.from - 0.01).blur).toBeGreaterThan(0);
  });

  test("clamps a shoulder to the side it flares from", () => {
    expect(clampedShoulder(14, 20, 10)).toBe(10);
    expect(clampedShoulder(14, 168, 32)).toBe(14);
    expect(clampedShoulder(14, 10, 12)).toBe(0);
  });

  test("draws one outline: the body and, when there are shoulders, two flares", () => {
    const path = edgeShapePath(560, 168, 32, 14);
    expect(path.match(/M /g)?.length).toBe(3);
    expect(edgeShapePath(185, 32, 10, 0).match(/M /g)?.length).toBe(1);
  });

  test("its clock opens, closes faster, and reopens from where it was", () => {
    let clock = beginOpening({ openedAt: null, closing: null }, 1000);
    expect(morphSeconds(clock, 1250)).toBeCloseTo(0.25, 6);
    expect(morphSeconds(clock, 5000)).toBe(MORPH.settle);
    const closing = beginClosing(clock, 1500);
    expect(closing.durationMs).toBeCloseTo((MORPH.settle / MORPH.closeSpeed) * 1000, 6);
    expect(morphSeconds(closing.clock, 1600)).toBeCloseTo(MORPH.settle - 0.1 * MORPH.closeSpeed, 6);
    clock = beginOpening(closing.clock, 1600);
    expect(morphSeconds(clock, 1600)).toBeCloseTo(MORPH.settle - 0.1 * MORPH.closeSpeed, 6);
    expect(morphSeconds(beginOpening({ openedAt: null, closing: null }, 0, true), 0)).toBe(MORPH.settle);
  });
});

describe("the queue (the Swift reference's IslandQueue rules)", () => {
  test("a newcomer replaces the current card, which compacts", () => {
    const q = new IslandQueue();
    q.arrive("a", true, 0);
    q.arrive("b", true, 1);
    expect(q.current?.id).toBe("b");
    expect(q.compacted.map((e) => e.id)).toEqual(["a"]);
  });

  test("a hovered or typed-into card holds; the newcomer waits below it", () => {
    for (const hold of ["hover", "type"] as const) {
      const q = new IslandQueue();
      q.arrive("a", true, 0);
      if (hold === "hover") q.hoverCurrent(true, 0);
      else q.typingCurrent(true, 0);
      q.arrive("b", true, 1);
      expect(q.current?.id).toBe("a");
      expect(q.waiting?.id).toBe("b");
      q.arrive("c", true, 2);
      expect(q.waiting?.id).toBe("c");
      expect(q.compacted.map((e) => e.id)).toEqual(["b"]);
    }
  });

  test("a card compacts by itself after 6 s unless held, and the waiting one expands", () => {
    const q = new IslandQueue();
    q.arrive("a", true, 0);
    expect(q.nextDeadline).toBe(IslandQueue.selfCompactAfter);
    q.tick(5.9);
    expect(q.current?.id).toBe("a");
    q.tick(6);
    expect(q.current).toBeNull();
    expect(q.compacted.map((e) => e.id)).toEqual(["a"]);

    const held = new IslandQueue();
    held.arrive("a", true, 0);
    held.hoverCurrent(true, 1);
    expect(held.nextDeadline).toBeNull();
    held.arrive("b", true, 2);
    held.tick(100);
    expect(held.current?.id).toBe("a");
  });

  test("leaving a card past its time gives it a grace period", () => {
    const q = new IslandQueue();
    q.arrive("a", true, 0);
    q.hoverCurrent(true, 1);
    q.hoverCurrent(false, 10);
    expect(q.nextDeadline).toBe(10 + IslandQueue.hoverLeaveGrace);
    q.tick(11);
    expect(q.current?.id).toBe("a");
    q.tick(11.5);
    expect(q.current).toBeNull();
  });

  test("a click on the waiting pill tucks the current card away", () => {
    const q = new IslandQueue();
    q.arrive("a", true, 0);
    q.hoverCurrent(true, 0);
    q.arrive("b", true, 1);
    q.clickWaiting(2);
    expect(q.current?.id).toBe("b");
    expect(q.waiting).toBeNull();
    expect(q.compacted.map((e) => e.id)).toEqual(["a"]);
    expect(q.currentHovered).toBe(false);
    expect(q.nextDeadline).toBe(2 + IslandQueue.selfCompactAfter);
  });

  test("an answer anywhere removes a card from every place; the waiting one expands", () => {
    const q = new IslandQueue();
    q.arrive("a", true, 0);
    q.hoverCurrent(true, 0);
    q.arrive("b", true, 1);
    q.resolve("a", 2);
    expect(q.current?.id).toBe("b");
    q.arrive("c", true, 3);
    q.resolve("b", 4);
    q.resolve("c", 4);
    expect(q.isEmpty).toBe(true);
  });

  test("a card coming back after being hidden goes straight to compacted", () => {
    const q = new IslandQueue();
    q.addCompacted("a", true, 0);
    expect(q.current).toBeNull();
    expect(q.compacted.map((e) => e.id)).toEqual(["a"]);
    q.arrive("a", true, 1);
    expect(q.current).toBeNull();
  });

  test("a card that counts down by itself is never compacted", () => {
    const q = new IslandQueue();
    q.arrive("v1", false, 0);
    q.arrive("a", true, 1);
    expect(q.current?.id).toBe("v1");
    expect(q.waiting?.id).toBe("a");
    q.arrive("v2", false, 2);
    expect(q.waiting?.id).toBe("v2");
    expect(q.compacted.map((e) => e.id)).toEqual(["a"]);
    q.arrive("v3", false, 3);
    expect(q.inLine.map((e) => e.id)).toEqual(["v3"]);
    q.clickWaiting(4);
    expect(q.current?.id).toBe("v2");
    expect(q.waiting?.id).toBe("v1");
    expect(q.tick(100), "no self-compaction").toBeUndefined();
    expect(q.current?.id).toBe("v2");
  });

  test("never compacts a counting card, whatever happens (randomised)", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 200; run++) {
      const q = new IslandQueue();
      let now = 0;
      const live = new Set<string>();
      for (let step = 0; step < 40; step++) {
        now += rand() * 4;
        const r = rand();
        if (r < 0.35) {
          const id = `${rand() < 0.3 ? "v" : "a"}${step}`;
          q.arrive(id, !id.startsWith("v"), now);
          live.add(id);
        } else if (r < 0.5) q.hoverCurrent(rand() < 0.5, now);
        else if (r < 0.6) q.typingCurrent(rand() < 0.5, now);
        else if (r < 0.7) q.clickWaiting(now);
        else if (r < 0.85) {
          const ids = [...live];
          const id = ids[Math.floor(rand() * ids.length)];
          if (id) {
            q.resolve(id, now);
            live.delete(id);
          }
        } else q.tick(now);
        expect(q.compacted.some((e) => e.id.startsWith("v"))).toBe(false);
        expect([...q.ids].sort()).toEqual([...live].sort());
      }
    }
  });
});

describe("tabs", () => {
  const s = tabState([NEEDS_YOU, { id: "usage", title: "Usage" }, { id: "devices", title: "Devices" }]);

  test("swipe without wrapping, and select by id", () => {
    expect(selectedTab(s)?.id).toBe("needs-you");
    expect(swipe(s, "right")).toBe(s);
    expect(selectedTab(swipe(s, "left"))?.id).toBe("usage");
    expect(selectedTab(select(s, "devices"))?.id).toBe("devices");
    expect(select(s, "nope")).toBe(s);
    expect(showsDots(s)).toBe(true);
    expect(showsDots(tabState([NEEDS_YOU]))).toBe(false);
    expect(tabState([NEEDS_YOU], 9).selected).toBe(0);
  });
});

describe("hover growth (the Swift reference's HoverGrowth)", () => {
  test("grows every panel by the compact pill's points", () => {
    expect(hoverScale(316)).toBeCloseTo(1.03, 9);
    expect(400 * hoverScale(400) - 400).toBeCloseTo(9.48, 9);
    expect(hoverScale(0)).toBe(1);
  });

  test("grows from the top edge and holds with hysteresis", () => {
    const rect = { x: 0, y: 10, width: 400, height: 100 };
    const grown = grownFromTop(rect);
    expect(grown.y).toBe(10);
    expect(grown.x).toBeCloseTo(-4.74, 6);
    expect(isOver({ x: -2, y: 50 }, rect, false)).toBe(false);
    expect(isOver({ x: -2, y: 50 }, rect, true)).toBe(true);
    expect(unscaled({ x: 200, y: 10 }, rect, true)).toEqual({ x: 200, y: 0 });
  });
});

describe("curves", () => {
  test("springs start at 0 and settle at 1; the critical one never overshoots", () => {
    expect(spring(0, 0.3, 0.7)).toBe(0);
    expect(spring(3, 0.3, 0.7)).toBeCloseTo(1, 4);
    for (let t = 0; t < 1; t += 0.01) expect(criticalSpring(t, 0.3)).toBeLessThanOrEqual(1);
  });

  test("the spring as a CSS linear() easing", () => {
    const { easing, durationMs } = springEasing(0.3, 0.7);
    expect(easing.startsWith("linear(0.0000, ")).toBe(true);
    expect(easing.endsWith(", 1.0000)")).toBe(true);
    expect(durationMs).toBeGreaterThan(300);
  });
});

describe("question cards", () => {
  const single: Question = { question: "Which branch?", options: [{ label: "main" }, { label: "dev" }], multiSelect: false };
  const multi: Question = { question: "Which files?", options: [{ label: "a.ts" }, { label: "b.ts" }, { label: "c.ts" }], multiSelect: true };
  const card: QuestionCard = { id: "q1", kind: "question", source: { id: "alpha", name: "Alpha" }, questions: [single, multi] };

  test("say who asks and where they are", () => {
    expect(questionHeader(card)).toBe("Alpha asks");
    expect(questionHeader({ ...card, source: undefined })).toBe("A question for you");
    expect(questionPosition(1, 2)).toBe("2 of 2");
    expect(questionPosition(0, 1)).toBeNull();
    expect(waitingLine(card)).toBe("Question · Alpha");
    expect(waitingLine({ id: "x", kind: "approval" })).toBe("Approval");
  });

  test("a single choice takes one option and drops typed words; a multiple one toggles", () => {
    let d = typeOther(emptyDraft(), single, 0, "staging");
    expect(d.others[0]).toBe("staging");
    d = chooseOption(d, single, 0, 1);
    expect(d.selections[0]).toEqual([1]);
    expect(d.others[0]).toBeUndefined();
    d = chooseOption(d, multi, 1, 2);
    d = chooseOption(d, multi, 1, 0);
    d = chooseOption(d, multi, 1, 2);
    expect(d.selections[1]).toEqual([0]);
    d = typeOther(d, multi, 1, "d.ts");
    expect(d.selections[1]).toEqual([0]);
  });

  test("answers by question text, once every question has one", () => {
    let d = chooseOption(emptyDraft(), single, 0, 0);
    expect(draftComplete(card.questions, d)).toBe(false);
    d = chooseOption(d, multi, 1, 0);
    d = typeOther(d, multi, 1, "d.ts");
    expect(draftComplete(card.questions, d)).toBe(true);
    expect(questionAnswers(card.questions, d)).toEqual({ "Which branch?": "main", "Which files?": "a.ts, d.ts" });
  });
});

describe("sealed buttons (lane B: one per option)", () => {
  test("an \"always\" answer on its own label, then ✕, then ✓; a link's approve is ↗", () => {
    const options = [
      { id: "deny", kind: "deny" as const },
      { id: "always", kind: "approve" as const, remember: "always" as const },
      { id: "once", kind: "approve" as const },
    ];
    expect(sealedButtons({ kind: "approval", options })).toEqual([
      { approve: true, option: "always", look: "label" },
      { approve: false, option: "deny", look: "cross" },
      { approve: true, option: "once", look: "check" },
    ]);
    expect(sealedButtons({ kind: "link", options: [{ id: "open", kind: "approve" }, { id: "no", kind: "deny" }] }).map((b) => b.look)).toEqual(["cross", "open"]);
  });

  test("no options listed: the first of each kind", () => {
    expect(sealedButtons({ kind: "approval" })).toEqual([
      { approve: false, look: "cross" },
      { approve: true, look: "check" },
    ]);
  });
});

describe("guest tabs (the review's spoofing fix)", () => {
  test("Needs you's id and title are reserved; another plugin's tab is named for its plugin, keyed by it, and never raises attention", () => {
    const tabs = guestTabs([
      { id: "NEEDS-YOU", title: "Mail" },
      { id: "a", title: "Ｎｅｅｄｓ　you" },
      { id: "devices", title: "Devices", pluginId: "clover", attention: "badge" as const },
      { id: "servers", title: "Servers", pluginId: "homelab", pluginName: "Homelab", attention: "expand" as const },
      { id: "servers", title: "Servers", pluginId: "other" },
      { id: "devices", title: "Devices", pluginId: "clover" },
    ]);
    expect(tabs.map((t) => [t.id, t.title, t.attention])).toEqual([
      ["devices", "Devices", "badge"],
      ["homelab#servers", "Servers · Homelab", "never"],
      ["other#servers", "Servers · other", "never"],
    ]);
    expect(isReservedTab({ id: "x", title: "needs you" })).toBe(true);
    expect(isReservedTab({ id: "x", title: "Needs you now" })).toBe(false);
  });

  test("a name that reads as Needs you is reserved however it is spelt (B-M1's review probe)", () => {
    const spoofs = [
      "Needs\u200B you", // a zero-width space
      "Needs\u200Byou",
      "N\u00ADeeds you", // a soft hyphen
      "Needs yo\u200Du", // a joiner
      "\u202ENeeds you", // a bidi override
      "Needs y\u043Eu", // Cyrillic о
      "N\u0435\u0435ds you", // Cyrillic е
      "\u039Deeds you", // Greek Ν
      "ɴᴇᴇᴅꜱ ʏᴏᴜ", // small capitals
      "𝐍𝐞𝐞𝐝𝐬 𝐲𝐨𝐮", // mathematical bold
      "Ｎｅｅｄｓ　ｙｏｕ", // full width
      "Nééds yoü", // accents
      "Needs\u3164you", // a Hangul filler draws as a space
      "Needs\u00A0\u00A0you",
      "NEEDS YOU",
      "Needs y0u", // a zero
      "Needs you\uFE0F", // a variation selector
    ];
    for (const title of spoofs) expect([title, isReservedTab({ id: "x", title })]).toEqual([title, true]);
    expect(isReservedTab({ id: "needs\u2011you", title: "Mail" })).toBe(false); // a hyphen is a different character
    expect(isReservedTab({ id: "NEEDS-Y\u043EU", title: "Mail" })).toBe(true);
    for (const title of ["Needs", "Needs you now", "Devices", "Usage", "Feeds you"]) expect([title, isReservedTab({ id: "x", title })]).toEqual([title, false]);
  });

  test("a plugin named as Needs you or as Clover gets no tab, and a shown name loses its bidi controls", () => {
    const tabs = guestTabs([
      { id: "servers", title: "Servers", pluginId: "spoof-a", pluginName: "Needs\u200B you" },
      { id: "servers", title: "Servers", pluginId: "spoof-b", pluginName: "Cl\u043Ever" },
      { id: "servers", title: "Servers", pluginId: "spoof-c", pluginName: "CLOVER" },
      { id: "servers", title: "Serv\u202Eers", pluginId: "homelab", pluginName: "Home\u2066lab\u2069" },
      { id: "own", title: "Own", pluginId: "clover", pluginName: "Clover" },
    ]);
    expect(tabs.map((t) => [t.id, t.title])).toEqual([
      ["homelab#servers", "Servers · Homelab"],
      ["own", "Own"],
    ]);
    expect(isReservedPluginName("Homelab")).toBe(false);
    expect(shownName("A\u202Eb\u00A0 c")).toBe("Ab c");
  });

  test("the clover tree's children (lane B ids them clover/<folder>) are the island's own; a look-alike id is not", () => {
    const tabs = guestTabs([
      { id: "usage", title: "Usage", pluginId: "clover/usage", pluginName: "Usage", attention: "badge" as const },
      { id: "devices", title: "Devices", pluginId: "clover/island", pluginName: "Island", attention: "badge" as const },
      { id: "x", title: "X", pluginId: "clover-extras", pluginName: "Extras", attention: "expand" as const },
      { id: "y", title: "Y", pluginId: "cloverx/usage", pluginName: "Y plugin" },
    ]);
    expect(tabs.map((t) => [t.id, t.title, t.attention])).toEqual([
      ["usage", "Usage", "badge"],
      ["devices", "Devices", "badge"],
      ["clover-extras#x", "X · Extras", "never"],
      ["cloverx/usage#y", "Y · Y plugin", "never"],
    ]);
    expect([isOwnPlugin("clover"), isOwnPlugin("clover/usage"), isOwnPlugin("clover-x"), isOwnPlugin(undefined)]).toEqual([true, true, false, false]);
  });

  test("another plugin named as a bot gets no tab: \"Servers · Alpha\" would read as Alpha's", () => {
    const entries = [
      { id: "servers", title: "Servers", pluginId: "evil", pluginName: "\u0410lpha" },
      { id: "servers", title: "Servers", pluginId: "evil2", pluginName: "luna" },
      { id: "servers", title: "Servers", pluginId: "homelab", pluginName: "Homelab" },
      { id: "own", title: "Alpha's room", pluginId: "clover/alpha-room", pluginName: "Alpha" },
    ];
    expect(guestTabs(entries, ["Alpha", "alpha", "Luna", "luna"]).map((t) => t.id)).toEqual(["homelab#servers", "own"]);
    expect(guestTabs(entries).map((t) => t.id)).toEqual(["evil#servers", "evil2#servers", "homelab#servers", "own"]);
  });

  test("the skeleton folds what reads alike, and keeps apart what doesn't", () => {
    expect(nameSkeleton("Needs you")).toBe(nameSkeleton("N\u0435\u0435ds y\u043Eu"));
    expect(readsAs("Luna", "\u13DEuna")).toBe(true); // Cherokee Ꮮ
    expect(readsAs("Luna", "Iuna")).toBe(true); // a capital I is drawn as an l
    expect(readsAs("Alpha", "\u0410lpha")).toBe(true); // Cyrillic А
    expect(readsAs("Alpha", "\u0391\u217Cpha")).toBe(true); // Greek Α and the Roman numeral fifty
    expect(readsAs("Home", "Hoｍe")).toBe(true);
    expect(readsAs("modern", "modem")).toBe(true); // rn reads as m
    expect(readsAs("Luna", "Lena")).toBe(false);
    expect(readsAs("Alpha", "Alpha 2")).toBe(false);
    expect(readsAs("Home", "Homes")).toBe(false);
    expect(nameSkeleton(" a \t b ")).toBe("ab");
  });
});
