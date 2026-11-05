import { describe, expect, test } from "bun:test";
import {
  PILL,
  accessoriesVisible,
  barLook,
  canvasSize,
  cardCeiling,
  cardSize,
  contentBlur,
  contentReveal,
  cornerRadius,
  fieldWidth,
  hoverScale,
  mainSize,
  morphBlur,
  previewCeiling,
  previewHeight,
} from "../src/model/metrics";
import { SPRING, retarget, restingSpring, settleSeconds, settled, springAt, springStep, stepSpring } from "../src/model/spring";
import { CHILD_PALETTES, GLOW_ALPHAS, GLOW_REACH, PALETTES, PLUME, PropulsionPlume, WorkingAnimation, childPalette, cssRgb, mulberry32, plumeColor, toolGlyph, type PlumeThrow } from "../src/model/plume";
import { assignPaletteSlots, childLayout, childStatus, entrance, stoppable } from "../src/model/children";
import { UPDATE_LABEL, plainReply, shortened, stripBold, turnPreview } from "../src/model/preview";
import { cardTrailing, chooseOption, draftComplete, emptyDraft, isSealed, questionAdvance, questionAnswers, typeOther, type Question } from "../src/model/cards";
import { APPROVAL, LINK, QUESTION, QUESTIONS } from "../src/fixtures";

describe("the pill's geometry (the Swift reference's DispatchPillMetrics)", () => {
  test("compact, typing and its ceiling", () => {
    expect(mainSize("compact", 200)).toEqual({ width: 316, height: 44 });
    expect(mainSize("expanded", 26)).toEqual({ width: 560, height: 44 });
    expect(mainSize("expanded", 66)).toEqual({ width: 560, height: 84 });
    expect(mainSize("expanded", 1000)).toEqual({ width: 560, height: PILL.maxExpandedHeight });
  });

  test("a pinned turn grows to its reply, up to 60 % of the screen", () => {
    // Two insets, the prompt line, the gap, one reply line.
    expect(previewHeight(20, 20, 600)).toBe(68);
    expect(previewHeight(2000, 20, 540)).toBe(540);
    expect(previewCeiling(900)).toBe(540);
    expect(previewCeiling(300)).toBe(PILL.maxExpandedHeight);
    expect(mainSize("expanded", 0, 300, 900)).toEqual({ width: 560, height: 300 });
  });

  test("a card: a compact pill widens to the card's width, a typing one keeps its own", () => {
    expect(cardSize("compact", 150)).toEqual({ width: 440, height: 150 });
    expect(cardSize("expanded", 150)).toEqual({ width: 560, height: 150 });
    expect(cardSize("compact", 0).height).toBe(PILL.cardEstimatedHeight);
    expect(cardSize("compact", 2000, 900).height).toBe(cardCeiling(900));
    expect(cardCeiling(900)).toBe(520);
  });

  test("capsule to rounded rect, holding at 22", () => {
    expect(cornerRadius(44)).toBe(22);
    expect(cornerRadius(30)).toBe(15);
    expect(cornerRadius(300)).toBe(22);
  });

  test("the morph blurs by the distance left, up to 8, nothing under a quarter pixel", () => {
    const target = { width: 560, height: 44 };
    expect(morphBlur(target, target)).toBe(0);
    expect(morphBlur({ width: 556, height: 44 }, target)).toBe(0.3333333333333333);
    expect(morphBlur({ width: 316, height: 44 }, target)).toBe(8);
    expect(morphBlur({ width: 558, height: 44 }, target)).toBe(0);
    expect(contentBlur(1)).toBe(0);
    expect(contentBlur(0)).toBe(8);
  });

  test("a swap's new content stays hidden for the first 62 % of the shape's travel", () => {
    const from = { width: 316, height: 44 };
    const to = { width: 440, height: 144 };
    expect(contentReveal(from, from, to)).toBe(0);
    expect(contentReveal(from, { width: 378, height: 94 }, to)).toBe(0);
    expect(contentReveal(from, to, to)).toBe(1);
    expect(contentReveal(to, to, to)).toBe(1);
  });

  test("the hover grows every shape by the compact pill's 9.48 px", () => {
    expect(hoverScale(316)).toBeCloseTo(1.03, 10);
    expect(560 * (hoverScale(560) - 1)).toBeCloseTo(9.48, 10);
    expect(hoverScale(0)).toBe(1);
  });

  test("↗ and ⋯ give way to a second line, or text that nears them", () => {
    const room = fieldWidth(PILL.expandedWidth) - 2 * PILL.accessoryButtonSize - 2 * PILL.rowSpacing;
    expect(accessoriesVisible("", 0)).toBe(true);
    expect(accessoriesVisible("a\nb", 10)).toBe(false);
    expect(accessoriesVisible("x", room - PILL.accessoryApproachMargin)).toBe(true);
    expect(accessoriesVisible("x", room - PILL.accessoryApproachMargin + 1)).toBe(false);
  });

  test("the bar's look (the Swift reference's dispatchPillBarLook)", () => {
    // Working: compact, running, no card. The circle: running beats send beats voice.
    expect(barLook(false, true, "", false, "Message Alpha", "Reading…")).toEqual({ working: true, circle: "stop", placeholder: null });
    expect(barLook(true, true, "", false, "Message Alpha", "Reading…")).toEqual({ working: false, circle: "stop", placeholder: "Reading…" });
    expect(barLook(true, true, "steer", false, "Message Alpha", "Reading…")).toEqual({ working: false, circle: "stop", placeholder: null });
    expect(barLook(false, true, "", true, "Message Alpha", "Reading…").working).toBe(false);
    expect(barLook(false, false, "", false, "Message Alpha", "Reading…")).toEqual({ working: false, circle: "voice", placeholder: "Message Alpha" });
    expect(barLook(true, false, "  ", false, "Message Alpha", "Reading…").circle).toBe("voice");
    expect(barLook(true, false, "hi", false, "Message Alpha", "Reading…").circle).toBe("send");
  });

  test("the window holds the pill, what floats above it and the shadow margin", () => {
    expect(canvasSize({ width: 316, height: 44 }, null)).toEqual({ width: 364, height: 92 });
    expect(canvasSize({ width: 316, height: 44 }, { width: 316, height: 44 })).toEqual({ width: 364, height: 144 });
  });
});

describe("the shape's spring (the Swift reference's morphStep)", () => {
  test("one step is semi-implicit Euler with stiffness 140 and damping 22", () => {
    const next = springStep({ value: 0, velocity: 0 }, 100, 1 / 60);
    const velocity = (140 * 100) / 60;
    expect(next.velocity).toBeCloseTo(velocity, 10);
    expect(next.value).toBeCloseTo(velocity / 60, 10);
  });

  test("a step's time is held between 1/240 and 1/20 s", () => {
    expect(springStep({ value: 0, velocity: 0 }, 100, 0)).toEqual(springStep({ value: 0, velocity: 0 }, 100, SPRING.minStep));
    expect(springStep({ value: 0, velocity: 0 }, 100, 2)).toEqual(springStep({ value: 0, velocity: 0 }, 100, SPRING.maxStep));
  });

  test("it settles on its target, exactly, and then stays", () => {
    const from = { width: 316, height: 44 };
    const to = { width: 440, height: 150 };
    const seconds = settleSeconds(from, to);
    expect(seconds).toBeGreaterThan(0.3);
    expect(seconds).toBeLessThan(1.5);
    const end = springAt(from, to, seconds);
    expect(end.size).toEqual(to);
    expect(settled(end)).toBe(true);
    expect(stepSpring(end, 1 / 60)).toEqual(end);
  });

  test("near critical: it never overshoots by half a pixel, and never shrinks below one", () => {
    let spring = retarget(restingSpring({ width: 316, height: 44 }), { width: 560, height: 44 });
    let widest = 0;
    for (let i = 0; i < 120; i++) {
      spring = stepSpring(spring, 1 / 60);
      widest = Math.max(widest, spring.size.width);
    }
    expect(widest).toBeLessThanOrEqual(560.5);
    expect(spring.size.width).toBe(560);
    const collapse = springAt({ width: 2, height: 2 }, { width: 1, height: 1 }, 0.5);
    expect(collapse.size.width).toBeGreaterThanOrEqual(1);
  });
});

describe("the plume (the Swift reference's PropulsionPlume and WorkingAnimationModel)", () => {
  test("each tool its glyph", () => {
    expect(toolGlyph("Bash")).toBe("terminal");
    expect(toolGlyph("Read")).toBe("doc");
    expect(toolGlyph("Edit")).toBe("pencil");
    expect(toolGlyph("Grep")).toBe("search");
    expect(toolGlyph("WebFetch")).toBe("globe");
    expect(toolGlyph("Agent")).toBe("people");
    expect(toolGlyph("TodoWrite")).toBe("checklist");
    expect(toolGlyph("mcp__github__webfetch")).toBe("globe");
    expect(toolGlyph("mcp__github__websearch")).toBe("search");
    expect(toolGlyph("mcp__github__issues")).toBe("box");
    expect(toolGlyph("Somethingnew")).toBe("sparkle");
  });

  test("a seed makes the same plume every time", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
    const one = new PropulsionPlume(11, true).circles(44, 22, 294, PropulsionPlume.tailX(44));
    const two = new PropulsionPlume(11, true).circles(44, 22, 294, PropulsionPlume.tailX(44));
    expect(one).toEqual(two);
  });

  test("a prewarmed plume runs from the nozzle to past the leading edge, the sparks drawn last", () => {
    const plume = new PropulsionPlume(PLUME.defaultSeed, true);
    const circles = plume.circles(44, 22, 294, PropulsionPlume.tailX(44));
    expect(circles.length).toBeGreaterThan(20);
    const xs = circles.map((c) => c.x);
    expect(Math.max(...xs)).toBeGreaterThan(280);
    expect(Math.min(...xs)).toBeLessThan(20);
    const firstSpark = circles.findIndex((c) => c.spark);
    expect(firstSpark).toBeGreaterThan(0);
    expect(circles.slice(firstSpark).every((c) => c.spark)).toBe(true);
    for (const c of circles) expect(c.diameter).toBeLessThanOrEqual(44 * PLUME.nozzleDiameterShare + 1e-9);
  });

  test("tools are thrown one by one; what was listed before the plume appeared is not", () => {
    const item = (id: string): PlumeThrow => ({ id, kind: { tool: "terminal" } });
    const animation = new WorkingAnimation(3);
    animation.tick(1 / 60, [item("before")]);
    expect(animation.plume.tokens).toHaveLength(0);
    animation.tick(1 / 60, [item("before"), item("a"), item("b")]);
    expect(animation.plume.tokens.map((t) => t.item.id)).toEqual(["a"]);
    // At least 0.22 s between two throws.
    animation.tick(0.1, [item("before"), item("a"), item("b")]);
    animation.tick(0.1, [item("before"), item("a"), item("b")]);
    expect(animation.plume.tokens).toHaveLength(1);
    animation.tick(0.1, [item("before"), item("a"), item("b")]);
    expect(animation.plume.tokens.map((t) => t.item.id)).toEqual(["a", "b"]);
  });

  test("the queue holds at most 24; a running round's throws come round again", () => {
    const animation = new WorkingAnimation(3);
    animation.tick(0, []);
    animation.tick(0, Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, kind: { tool: "doc" as const } })), [], false);
    expect(animation.queued).toHaveLength(WorkingAnimation.maxQueued);
    expect(animation.queued[0]!.id).toBe("t16");
    const looping = new WorkingAnimation(4);
    const round: PlumeThrow[] = [{ id: "r", kind: { site: "github.com" } }];
    looping.tick(0, []);
    for (let i = 0; i < 60; i++) looping.tick(1 / 30, [], round);
    expect(looping.plume.tokens.length).toBeGreaterThanOrEqual(2);
  });

  test("its colours: the tail cool, the nozzle white-hot; every agent a palette of its own", () => {
    expect(plumeColor(0)).toEqual(PALETTES.blue.tail);
    expect(plumeColor(1)).toEqual(PALETTES.blue.hot);
    expect(plumeColor(0.55)).toEqual(PALETTES.blue.body);
    expect(cssRgb([1, 0.5, 0], 0.5)).toBe("rgba(255, 128, 0, 0.5)");
    expect(new Set(CHILD_PALETTES).size).toBe(7);
    expect(CHILD_PALETTES).not.toContain(PALETTES.blue);
    expect(childPalette(7)).toBe(childPalette(0));
    expect(childPalette(-1)).toBe(childPalette(6));
  });

  test("the glow is a blurred disc: brightest in the middle, gone at its edge", () => {
    expect(GLOW_REACH).toBeGreaterThan(1);
    for (let i = 1; i < GLOW_ALPHAS.length; i++) expect(GLOW_ALPHAS[i]!).toBeLessThanOrEqual(GLOW_ALPHAS[i - 1]! + 1e-9);
    expect(GLOW_ALPHAS[0]!).toBeGreaterThan(0.5);
    expect(GLOW_ALPHAS[GLOW_ALPHAS.length - 1]!).toBeLessThan(0.05);
  });
});

describe("the agents' row", () => {
  test("wire statuses as the row draws them; only a running one can be stopped", () => {
    expect(childStatus("awaiting_approval")).toBe("needsYou");
    expect(childStatus("awaiting_input")).toBe("needsYou");
    expect(childStatus("error")).toBe("failed");
    expect(childStatus("completed")).toBe("done");
    expect(childStatus("whatever")).toBe("working");
    expect(stoppable("working")).toBe(true);
    expect(stoppable("needsYou")).toBe(true);
    expect(stoppable("done")).toBe(false);
    expect(stoppable("failed")).toBe(false);
  });

  test("one takes the row, more split it, then +n", () => {
    expect(childLayout(0, 316)).toEqual({ visible: 0, pillWidth: 0, overflow: 0 });
    expect(childLayout(1, 316)).toEqual({ visible: 1, pillWidth: 316, overflow: 0 });
    expect(childLayout(2, 316)).toEqual({ visible: 2, pillWidth: 155, overflow: 0 });
    const many = childLayout(7, 316);
    expect(many.overflow).toBeGreaterThan(0);
    expect(many.visible + many.overflow).toBe(7);
    expect(many.pillWidth).toBeGreaterThanOrEqual(PILL.minChildPillWidth);
    expect(many.visible * many.pillWidth + many.visible * PILL.childPillGap + PILL.pillHeight).toBeCloseTo(316, 6);
    expect(childLayout(7, 560).visible).toBeGreaterThan(many.visible);
  });

  test("colours never repeat on a row, and never change once given", () => {
    let state = assignPaletteSlots(["a", "b", "c"], {}, 0, 7);
    expect(new Set(Object.values(state.assigned)).size).toBe(3);
    const before = { ...state.assigned };
    state = assignPaletteSlots(["a", "c", "d"], { a: before.a!, c: before.c! }, state.cursor, 7);
    expect(state.assigned.a).toBe(before.a);
    expect(state.assigned.c).toBe(before.c);
    expect([state.assigned.a, state.assigned.c]).not.toContain(state.assigned.d);
  });

  test("a new pill rises out of the main one", () => {
    expect(entrance(0)).toEqual({ scale: 0.55, offsetY: 18, opacity: 0, blur: 6 });
    expect(entrance(1)).toEqual({ scale: 1, offsetY: 0, opacity: 1, blur: 0 });
    expect(entrance(4)).toEqual(entrance(1));
  });
});

describe("a pinned turn (the Swift reference's dispatchPillTurnPreview and dispatchPillReplyText)", () => {
  test("the prompt on one line, where the turn sits, an update's own label", () => {
    const turns = [
      { prompt: "First\n   line", reply: "ok" },
      { prompt: "", reply: "The build passed." },
      { prompt: "Stop that", reply: "", aborted: true },
      { prompt: "Still going", reply: "" },
    ];
    expect(turnPreview(turns, 0)).toEqual({ prompt: "First line", reply: "ok", position: "1/4" });
    expect(turnPreview(turns, 1)!.prompt).toBe(UPDATE_LABEL);
    expect(turnPreview(turns, 2)!.reply).toBe("stopped");
    expect(turnPreview(turns, 3)!.reply).toBe("no reply yet");
    expect(turnPreview(turns, 9)).toBeNull();
    expect(shortened("x".repeat(100), 90)).toHaveLength(90);
    expect(shortened("x".repeat(100), 90).endsWith("…")).toBe(true);
  });

  test("the reply in plain words: headings, quotes, bullets and bold go; code and diffs stay verbatim", () => {
    const reply = ["## Done", "", "> quoted", "- **one** thing", "* two", "", "", "```ts", "const **x** = 1;   ", "```", "", "+ added line", "@@ hunk", "", "Keep `**this**` and **that**"].join("\n");
    expect(plainReply(reply)).toBe(["Done", "", "quoted", "• one thing", "• two", "", "const **x** = 1;", "", "+ added line", "@@ hunk", "", "Keep `**this**` and that"].join("\n"));
    expect(stripBold("a **b** `**c**` d")).toBe("a b `**c**` d");
    // An unclosed backtick opens no code: what follows it is words.
    expect(stripBold("unclosed `**x**")).toBe("unclosed `x");
  });
});

describe("cards", () => {
  test("an approval and a link are sealed, a question is not", () => {
    expect(isSealed(APPROVAL)).toBe(true);
    expect(isSealed(LINK)).toBe(true);
    expect(isSealed(QUESTION)).toBe(false);
  });

  test("the header's trailing words", () => {
    expect(cardTrailing(0, 1, 0)).toBeNull();
    expect(cardTrailing(1, 3, 0)).toBe("2 of 3");
    expect(cardTrailing(0, 1, 2)).toBe("+2 waiting");
    expect(cardTrailing(0, 2, 1)).toBe("1 of 2 · +1 waiting");
  });

  test("choosing: one takes a single-choice question (and drops typed words), many toggle", () => {
    const single = QUESTION.questions[0]!;
    let draft = typeOther(emptyDraft(), single, 0, "rebase first");
    draft = chooseOption(draft, single, 0, 1);
    expect(draft.selections[0]).toEqual([1]);
    expect(draft.others[0]).toBeUndefined();
    draft = typeOther(draft, single, 0, "the release branch");
    expect(draft.selections[0]).toBeUndefined();
    const multi: Question = QUESTIONS.questions[0]!;
    let m = chooseOption(emptyDraft(), multi, 0, 2);
    m = chooseOption(m, multi, 0, 0);
    expect(m.selections[0]).toEqual([0, 2]);
    m = chooseOption(m, multi, 0, 2);
    expect(m.selections[0]).toEqual([0]);
    m = typeOther(m, multi, 0, "BSD");
    expect(m.selections[0]).toEqual([0]);
  });

  test("✓ is Next until the last question, then Send once every question has an answer", () => {
    const qs = QUESTIONS.questions;
    let draft = emptyDraft();
    expect(questionAdvance(qs, draft, false)).toEqual({ action: "next", enabled: false });
    draft = chooseOption(draft, qs[0]!, 0, 1);
    expect(questionAdvance(qs, draft, false)).toEqual({ action: "next", enabled: true });
    expect(questionAdvance(qs, draft, true)).toEqual({ action: "next", enabled: false });
    draft = { ...draft, visible: 1 };
    expect(questionAdvance(qs, draft, false)).toEqual({ action: "send", enabled: false });
    draft = chooseOption(draft, qs[1]!, 1, 0);
    expect(questionAdvance(qs, draft, false)).toEqual({ action: "send", enabled: true });
    expect(draftComplete(qs, draft)).toBe(true);
    expect(questionAnswers(qs, typeOther(draft, qs[0]!, 0, "BSD"))).toEqual({
      "Which platforms should the release notes cover?": "Windows, BSD",
      "Should I post them when they're ready?": "Post them",
    });
  });
});
