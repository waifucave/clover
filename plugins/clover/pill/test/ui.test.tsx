import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { Bar } from "../src/ui/Bar";
import { CardBody, QuestionCardBody } from "../src/ui/Card";
import { Children } from "../src/ui/Children";
import { Preview } from "../src/ui/Preview";
import { drawPlume, Plume, plumeStill, type PlumeCanvas } from "../src/ui/Plume";
import { GLYPHS, Glyph } from "../src/ui/glyphs";
import { mockSealedKit, SealedKitContext } from "../src/ui/sealed";
import { emptyDraft } from "../src/model/cards";
import { PALETTES, PropulsionPlume } from "../src/model/plume";
import { turnPreview } from "../src/model/preview";
import { AGENTS, ALPHA, APPROVAL, EXCHANGES, LINK, MANY_AGENTS, QUESTION, QUESTIONS, SEALED, TARGETS, THROWS } from "../src/fixtures";

const kit = mockSealedKit(SEALED);
const withKit = (ui: ReactElement, k = kit) => <SealedKitContext.Provider value={k}>{ui}</SealedKitContext.Provider>;

function bar(extra: Partial<Parameters<typeof Bar>[0]> = {}) {
  return <Bar presentation="compact" target={ALPHA} draft="" working={false} circle="voice" placeholder="Message Alpha" {...extra} />;
}

describe("the bar", () => {
  test("says who it messages, with the voice circle until there is text", () => {
    render(bar());
    expect(screen.getByLabelText("Message Alpha")).toHaveProperty("placeholder", "Message Alpha");
    expect(screen.getByRole("button", { name: "Voice" })).toBeTruthy();
    // Only one target: nothing to pick.
    expect((screen.getByRole("button", { name: "Alpha" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("types, sends on Enter (not on Shift+Enter), and Escape leaves", () => {
    const onDraft = mock((_: string) => {});
    const onSend = mock(() => {});
    const onEscape = mock(() => {});
    render(bar({ presentation: "expanded", draft: "hello", circle: "send", onDraft, onSend, onEscape }));
    const field = screen.getByLabelText("Message Alpha");
    fireEvent.change(field, { target: { value: "hello there" } });
    expect(onDraft).toHaveBeenCalledWith("hello there");
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  test("an empty draft never sends", () => {
    const onSend = mock(() => {});
    render(bar({ presentation: "expanded", draft: "   ", onSend }));
    fireEvent.keyDown(screen.getByLabelText("Message Alpha"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("while working the circle stops, the field hides, and a click opens the typing pill", () => {
    const onStop = mock(() => {});
    const onOpen = mock(() => {});
    const { container } = render(bar({ working: true, circle: "stop", placeholder: null, onStop, onOpen }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".clp-field")!.getAttribute("data-hidden")).toBe("true");
    expect((screen.getByLabelText("Message Alpha") as HTMLTextAreaElement).tabIndex).toBe(-1);
    fireEvent.click(container.querySelector(".clp-bar")!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("a stop that is on its way says so and waits", () => {
    render(bar({ working: true, circle: "stop", stopping: true }));
    const circle = screen.getByRole("button", { name: "Stopping…" }) as HTMLButtonElement;
    expect(circle.disabled).toBe(true);
  });

  test("the portrait opens the targets; picking one reports it", () => {
    const onMenu = mock((_: unknown) => {});
    const onTarget = mock((_: string) => {});
    const { rerender } = render(bar({ targets: TARGETS, onMenu }));
    fireEvent.click(screen.getByRole("button", { name: "Choose who to message" }));
    expect(onMenu).toHaveBeenCalledWith("targets");
    rerender(bar({ targets: TARGETS, menu: "targets", onMenu, onTarget }));
    const items = screen.getAllByRole("menuitemradio");
    // Each a portrait (Alpha's image, the others' initials, hidden from screen readers) and a name.
    expect(items.map((i) => i.textContent)).toEqual(["Alpha", "LLuna", "MMori"]);
    expect(items[0]!.querySelector("img")!.getAttribute("src")).toBe(ALPHA.portrait!);
    expect(items[1]!.querySelector(".clp-portrait")!.getAttribute("aria-hidden")).toBe("true");
    expect(items[0]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(items[1]!);
    expect(onTarget).toHaveBeenCalledWith("luna");
    expect(onMenu).toHaveBeenLastCalledWith(null);
  });

  test("⋯ holds open-in-app and clear; ↗ asks for full screen", () => {
    const onOpenInApp = mock(() => {});
    const onClearDraft = mock(() => {});
    const onFullScreen = mock(() => {});
    render(bar({ presentation: "expanded", draft: "x", accessories: true, menu: "more", onOpenInApp, onClearDraft, onFullScreen }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Open Alpha in Clover/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Clear draft/ }));
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(onOpenInApp).toHaveBeenCalledTimes(1);
    expect(onClearDraft).toHaveBeenCalledTimes(1);
    expect(onFullScreen).toHaveBeenCalledTimes(1);
  });

  test("↗ and ⋯ give way to a second line", () => {
    const { container, rerender } = render(bar({ presentation: "expanded", draft: "one line", accessories: true }));
    expect(container.querySelector(".clp-accessories")!.getAttribute("data-shown")).toBe("true");
    rerender(bar({ presentation: "expanded", draft: "one\ntwo", accessories: true }));
    expect(container.querySelector(".clp-accessories")!.getAttribute("data-shown")).toBe("false");
  });

  test("covered by a card it is hidden, mounted, and out of the way", () => {
    const { container } = render(bar({ covered: true }));
    const el = container.querySelector(".clp-bar") as HTMLElement;
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.style.opacity).toBe("0");
    expect(screen.getByLabelText("Message Alpha", { selector: "textarea" })).toBeTruthy();
  });

  test("reports its text's height as it grows", () => {
    const heights: number[] = [];
    const { rerender } = render(bar({ presentation: "expanded", draft: "a", onContentHeight: (h) => heights.push(h) }));
    rerender(bar({ presentation: "expanded", draft: "a\nb", onContentHeight: (h) => heights.push(h) }));
    expect(heights.length).toBeGreaterThanOrEqual(2);
    for (const h of heights) expect(h).toBeGreaterThan(0);
  });
});

describe("cards", () => {
  test("an approval's words come only through sealed parts; its buttons answer through the kit", () => {
    const answers: [string, boolean][] = [];
    const answering = mockSealedKit(SEALED, (id, approved) => answers.push([id, approved]));
    const { container } = render(withKit(<CardBody card={APPROVAL} draft={emptyDraft()} waiting={1} />, answering));
    for (const words of Object.values(SEALED["ask-1"]!)) {
      const holder = [...container.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent === words);
      expect(holder?.closest("[data-sealed]"), words).toBeTruthy();
    }
    expect(screen.getByText("Studio · +1 waiting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(answers).toEqual([
      ["ask-1", true],
      ["ask-1", false],
    ]);
  });

  test("a link request's ✓ opens the link", () => {
    render(withKit(<CardBody card={LINK} draft={emptyDraft()} />));
    expect(screen.getByRole("button", { name: "Open the link" })).toBeTruthy();
    expect(screen.getByText("github.com")).toBeTruthy();
  });

  test("a question: choosing never sends; ✓ waits for an answer", () => {
    const onChoose = mock((_q: number, _o: number) => {});
    const onAdvance = mock(() => {});
    const { rerender } = render(<QuestionCardBody card={QUESTION} draft={emptyDraft()} onChoose={onChoose} onAdvance={onAdvance} />);
    expect(screen.getByText("Alpha asks")).toBeTruthy();
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /release\/1.111/ }));
    expect(onChoose).toHaveBeenCalledWith(0, 1);
    expect(onAdvance).not.toHaveBeenCalled();
    rerender(<QuestionCardBody card={QUESTION} draft={{ visible: 0, selections: { 0: [1] }, others: {} }} onChoose={onChoose} onAdvance={onAdvance} />);
    expect(screen.getByRole("radio", { name: /release\/1.111/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  test("several questions: Next, Back, multiple choice, typed words and Return", () => {
    const onBack = mock(() => {});
    const onAdvance = mock(() => {});
    const onType = mock((_q: number, _t: string) => {});
    const { rerender } = render(<QuestionCardBody card={QUESTIONS} draft={{ visible: 0, selections: { 0: [0] }, others: {} }} waiting={1} onAdvance={onAdvance} onType={onType} onBack={onBack} />);
    expect(screen.getByText("1 of 2 · +1 waiting")).toBeTruthy();
    expect(screen.getByText("Choose any")).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Something else"), { target: { value: "BSD" } });
    expect(onType).toHaveBeenCalledWith(0, "BSD");
    fireEvent.keyDown(screen.getByLabelText("Something else"), { key: "Enter" });
    expect(onAdvance).toHaveBeenCalledTimes(1);
    rerender(<QuestionCardBody card={QUESTIONS} draft={{ visible: 1, selections: { 0: [0] }, others: {} }} onAdvance={onAdvance} onBack={onBack} />);
    expect(screen.getByText("2 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("an answer on its way, and one that failed", () => {
    const { rerender } = render(<QuestionCardBody card={QUESTION} draft={{ visible: 0, selections: { 0: [0] }, others: {} }} inFlight />);
    expect(screen.getByText("Sending…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<QuestionCardBody card={QUESTION} draft={{ visible: 0, selections: { 0: [0] }, others: {} }} error="That answer didn't go through. Try again." />);
    expect(screen.getByRole("alert").textContent).toBe("That answer didn't go through. Try again.");
  });
});

describe("the agents' row", () => {
  test("one pill each: a working one has a plume and a stop, a finished one neither", () => {
    const onStop = mock((_: string) => {});
    const onOpen = mock((_: string) => {});
    const { container } = render(<Children items={AGENTS} width={316} onStop={onStop} onOpen={onOpen} animates={false} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Stop Changelog check" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop Release notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Screenshot pass" }));
    expect(onStop).toHaveBeenCalledWith("agent-1");
    expect(onOpen).toHaveBeenCalledWith("agent-2");
    expect(container.querySelector('[data-status="needsYou"] .clp-child-glyph')).toBeTruthy();
  });

  test("past the minimum width, +n stands for the rest", () => {
    render(<Children items={MANY_AGENTS} width={316} animates={false} />);
    expect(screen.getByLabelText(/more agents/).textContent).toMatch(/^\+\d$/);
  });

  test("nothing at all without agents", () => {
    const { container } = render(<Children items={[]} width={316} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("a pinned turn", () => {
  test("its prompt, its reply in plain words, where it sits; a click leaves it", () => {
    const onLeave = mock(() => {});
    render(<Preview preview={turnPreview(EXCHANGES, 1)!} onLeave={onLeave} />);
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(screen.getByText(/I merged the two bug-fix sections/).textContent).toContain("• The tray icon shows on Windows again");
    fireEvent.click(screen.getByRole("article"));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

/** A canvas context that writes down what it is asked to draw. */
function recorder() {
  const calls: string[] = [];
  const ctx = {
    calls,
    fillStyle: "" as unknown,
    strokeStyle: "" as unknown,
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    translate: () => {},
    scale: () => {},
    setTransform: () => {},
    clearRect: () => calls.push("clear"),
    beginPath: () => {},
    arc: (_x: number, _y: number, r: number) => calls.push(`arc ${r.toFixed(1)}`),
    fill: () => calls.push(`fill ${typeof ctx.fillStyle === "string" ? ctx.fillStyle : "gradient"} ${ctx.globalAlpha}`),
    stroke: () => calls.push("stroke"),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  };
  return ctx;
}

describe("the plume on a canvas", () => {
  test("glows first, then every puff, sparks over them, then the thrown tools in white", () => {
    const ctx = recorder();
    const animation = plumeStill(1.75, THROWS);
    drawPlume(ctx as unknown as PlumeCanvas, animation.plume, { width: 316, height: 44, emitterInset: 22 }, PALETTES.blue);
    const fills = ctx.calls.filter((c) => c.startsWith("fill"));
    const lastGlow = fills.map((c) => c.includes("gradient")).lastIndexOf(true);
    const firstDisc = fills.findIndex((c) => !c.includes("gradient"));
    expect(ctx.calls[0]).toBe("clear");
    expect(lastGlow).toBeLessThan(firstDisc);
    expect(fills.some((c) => c.endsWith(" 0.95"))).toBe(true);
    // Thrown tools are white discs, after every puff.
    const tiles = fills.filter((c) => c.startsWith("fill #FFFFFF"));
    expect(tiles.length).toBeGreaterThan(0);
    expect(fills.lastIndexOf(fills.find((c) => c.endsWith(" 0.95"))!)).toBeLessThan(fills.indexOf(tiles[0]!));
  });

  test("a still is the same every time; a running plume draws nothing without a canvas to draw on", () => {
    const a = plumeStill(1.2, THROWS).plume.circles(44, 22, 294, PropulsionPlume.tailX(44));
    const b = plumeStill(1.2, THROWS).plume.circles(44, 22, 294, PropulsionPlume.tailX(44));
    expect(a).toEqual(b);
    const { container } = render(<Plume width={316} height={44} animates={false} />);
    const canvas = container.querySelector("canvas")!;
    expect(canvas.style.width).toBe("316px");
  });
});

describe("glyphs", () => {
  test("every glyph is drawable path data in a 16 box", () => {
    for (const [name, shapes] of Object.entries(GLYPHS)) {
      expect(shapes.length, name).toBeGreaterThan(0);
      for (const shape of shapes) expect(shape.d, name).toMatch(/^M/);
    }
    const { container } = render(<Glyph name="hand" />);
    expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 16 16");
  });
});
