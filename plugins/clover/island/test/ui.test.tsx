import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { cardGeometry, ISLAND } from "../src/model/geometry";
import { FLUID } from "../src/model/fluid";
import { emptyDraft } from "../src/model/cards";
import { NEEDS_YOU, tabState } from "../src/model/tabs";
import { Strip, stripLabel } from "../src/ui/Strip";
import { LiquidCard } from "../src/ui/Liquid";
import { NeedsYou, OpenIsland } from "../src/ui/OpenIsland";
import { QuestionCardContent, SealedCardContent } from "../src/ui/CardContent";
import { WaitingPill } from "../src/ui/WaitingPill";
import { mockSealedKit, SealedKitContext } from "../src/ui/sealed";
import { LiftRow, StatusWord } from "../src/ui/rows";
import { APPROVAL, APPROVAL_2, LINK, NOTCH, NO_NOTCH, QUESTION, QUESTIONS_2, SEALED } from "../src/fixtures";

const withKit = (ui: ReactElement, onAnswer?: (id: string, approved: boolean) => void) => (
  <SealedKitContext.Provider value={mockSealedKit(SEALED, onAnswer)}>{ui}</SealedKitContext.Provider>
);

describe("Strip", () => {
  test("idle with a housing: the housing alone, no wings drawn", () => {
    const { container } = render(<Strip shape={NOTCH} counts={{ waiting: 0, working: 0 }} />);
    const strip = container.querySelector(".clv-strip") as HTMLElement;
    expect(strip.style.width).toBe("185px");
    expect(strip.querySelector("[data-part]")).toBeNull();
  });

  test("idle without a housing: nothing at all", () => {
    const { container } = render(<Strip shape={NO_NOTCH} counts={{ waiting: 0, working: 0 }} />);
    expect(container.querySelector(".clv-strip")).toBeNull();
  });

  test("waiting and working: both wings with their counts, and a label that says so", () => {
    render(<Strip shape={NOTCH} counts={{ waiting: 2, working: 1 }} />);
    const strip = screen.getByRole("button");
    expect(strip.style.width).toBe(`${185 + 2 * ISLAND.stripWing}px`);
    expect(strip.querySelector('[data-part="waiting"]')?.textContent).toBe("2");
    expect(strip.querySelector('[data-part="working"]')?.textContent).toBe("1");
    expect(strip.getAttribute("aria-label")).toBe("Clover island. 2 things need you. 1 bot working.");
    expect(stripLabel({ waiting: 1, working: 0 })).toBe("Clover island. 1 thing needs you.");
    expect(stripLabel({ waiting: 0, working: 0 })).toBe("Clover island. Nothing needs you.");
  });

  test("a click reports the part it landed on", () => {
    const onPart = mock();
    render(<Strip shape={NOTCH} counts={{ waiting: 1, working: 0 }} onPart={onPart} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onPart).toHaveBeenCalledTimes(1);
  });
});

describe("LiquidCard", () => {
  const g = cardGeometry(NOTCH, { width: 400, height: 120 }, { rounded: true });

  test("at rest: the shell at its resting rect, no melt", () => {
    const { container } = render(<LiquidCard geometry={g}>x</LiquidCard>);
    const shell = container.querySelector(".clv-card-shell") as HTMLElement;
    expect(shell.style.width).toBe("400px");
    expect(shell.style.top).toBe("42px");
    expect(shell.style.borderRadius).toBe("24px");
    expect(container.querySelector(".clv-melt")).toBeNull();
  });

  test("mid-birth: the melt shows and the content is blurred and faded", () => {
    const { container } = render(<LiquidCard geometry={g} seconds={0.3}>x</LiquidCard>);
    expect(container.querySelector(".clv-melt")).not.toBeNull();
    const content = container.querySelector(".clv-card-content") as HTMLElement;
    expect(content.style.opacity).toBe("0");
    expect(content.style.filter).toContain("blur(");
  });

  test("hovered: grows from its top edge by the compact pill's points", () => {
    const { container } = render(
      <LiquidCard geometry={g} hovered>
        x
      </LiquidCard>,
    );
    const shell = container.querySelector(".clv-card-shell") as HTMLElement;
    expect(shell.style.transform).toBe(`scale(${1 + 9.48 / 400})`);
  });

  test("reduce motion: no birth — it appears where it rests", () => {
    const { container } = render(
      <LiquidCard geometry={g} seconds={0.2} reducedMotion>
        x
      </LiquidCard>,
    );
    expect(container.querySelector(".clv-melt")).toBeNull();
    expect((container.querySelector(".clv-card-shell") as HTMLElement).style.top).toBe("42px");
    expect(FLUID.settle).toBeGreaterThan(0.2);
  });
});

describe("card contents", () => {
  test("an approval places its sealed parts: who asks, what is asked, ✕ and ✓", () => {
    const onAnswer = mock();
    const { container } = render(withKit(<SealedCardContent card={APPROVAL} />, onAnswer));
    expect(container.querySelector('[data-field="source"]')?.textContent).toBe("Alpha · Bash");
    expect(container.querySelector('[data-field="ask"]')?.textContent).toContain("deletes the build folder");
    expect(container.textContent).toContain("Studio");
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onAnswer).toHaveBeenCalledWith("approval-1", true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onAnswer).toHaveBeenCalledWith("approval-1", false);
  });

  test("an approval never draws words of its own: without a kit the parts are empty", () => {
    const { container } = render(<SealedCardContent card={APPROVAL} />);
    expect(container.querySelector('[data-field="ask"]')?.textContent).toBe("");
    expect(container.querySelector('[data-sealed="approve"]')).not.toBeNull();
  });

  test("a link request says its host beside a lock, and opens with ↗", () => {
    const { container } = render(withKit(<SealedCardContent card={LINK} />));
    expect(container.querySelector('[data-field="host"]')?.textContent).toBe("linear.app");
    expect(container.querySelector('[data-sealed="approve"]')?.getAttribute("data-look")).toBe("open");
  });

  test("a question shows its options; ✓ waits for an answer", () => {
    const onChoose = mock();
    render(<QuestionCardContent card={QUESTION} draft={emptyDraft()} onChoose={onChoose} />);
    expect(screen.getByText("Alpha asks")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "main" }));
    expect(onChoose).toHaveBeenCalledWith(0, 0);
  });

  test("a card of several questions counts them and offers › until the last", () => {
    render(<QuestionCardContent card={QUESTIONS_2} draft={{ visible: 0, selections: { 0: [1] }, others: {} }} />);
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect((screen.getByRole("button", { name: "Next question" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("WaitingPill", () => {
  test("says what kind of card and whose, and expands on a click", () => {
    const onClick = mock();
    render(<WaitingPill card={APPROVAL_2} rect={{ x: 0, y: 0, width: 280, height: 32 }} onClick={onClick} />);
    const pill = screen.getByRole("button");
    expect(pill.textContent).toBe("Approval · Luna");
    expect(pill.getAttribute("aria-label")).toBe("Waiting: Approval · Luna. Show it.");
    fireEvent.click(pill);
    expect(onClick).toHaveBeenCalled();
  });
});

describe("OpenIsland", () => {
  const tabs = tabState([NEEDS_YOU, { id: "usage", title: "Usage" }, { id: "devices", title: "Devices" }]);

  test("titles the tab, counts Needs you, and shows where you are among the tabs", () => {
    const onSelect = mock();
    render(
      <OpenIsland shape={NOTCH} tabs={tabs} count={3} onSelectTab={onSelect}>
        body
      </OpenIsland>,
    );
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    const dots = screen.getAllByRole("tab");
    expect(dots).toHaveLength(3);
    expect(dots[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(dots[2]!);
    expect(onSelect).toHaveBeenCalledWith("devices");
  });

  test("a click on the top band, never on a dot, goes to the strip's parts", () => {
    const onTopBand = mock();
    const { container } = render(
      <OpenIsland shape={NOTCH} tabs={tabs} onTopBand={onTopBand}>
        body
      </OpenIsland>,
    );
    fireEvent.click(screen.getAllByRole("tab")[1]!);
    expect(onTopBand).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".clv-open-header")!);
    expect(onTopBand).toHaveBeenCalledTimes(1);
  });

  test("at rest it is the island's size, with its shoulders", () => {
    const { container } = render(<OpenIsland shape={NOTCH} tabs={tabs} />);
    const island = container.querySelector(".clv-open") as HTMLElement;
    expect(island.style.width).toBe("560px");
    expect(island.style.height).toBe("168px");
    expect(container.querySelectorAll(".clv-open-shoulder")).toHaveLength(2);
  });

  test("mid-morph: narrower, contents faded and blurred", () => {
    const from = { x: -138.5, y: 0, width: 277, height: 32 };
    const { container } = render(<OpenIsland shape={NOTCH} tabs={tabs} seconds={0.1} from={from} />);
    const island = container.querySelector(".clv-open") as HTMLElement;
    expect(parseFloat(island.style.width)).toBeLessThan(560);
    const content = container.querySelector(".clv-open-content") as HTMLElement;
    expect(content.style.opacity).toBe("0");
  });

  test("without a housing the header is its own row under the top band", () => {
    const { container } = render(<OpenIsland shape={NO_NOTCH} tabs={tabs} />);
    expect((container.querySelector(".clv-open-header") as HTMLElement).style.height).toBe("46px");
  });
});

describe("NeedsYou", () => {
  test("lists every card, newest first", () => {
    const { container } = render(withKit(<NeedsYou cards={[APPROVAL, LINK, QUESTION]} />));
    const rows = container.querySelectorAll(".clv-needs-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Alpha asks");
    expect(rows[2]!.querySelector('[data-field="command"]')?.textContent).toBe("rm -rf dist && bun run build");
  });

  test("says when nothing needs you", () => {
    render(<NeedsYou cards={[]} />);
    expect(screen.getByText("Nothing needs you")).toBeTruthy();
  });
});

describe("rows", () => {
  test("a row's title lifts under the pointer and its details show", () => {
    const { container, rerender } = render(<LiftRow title="Studio" side="this computer" trailing={<StatusWord mark={{ kind: "dot", color: "#4CC38A" }} word="Connected" />} />);
    expect(container.querySelector(".clv-row")?.getAttribute("data-hovered")).toBe("false");
    rerender(<LiftRow title="Studio" hovered below={<span>Paired 3 days ago</span>} />);
    expect(container.querySelector(".clv-row")?.getAttribute("data-hovered")).toBe("true");
    expect(container.textContent).toContain("Paired 3 days ago");
  });
});

describe("a tab's scrolling list", () => {
  test("fades an edge only where more of the list lies beyond it", async () => {
    const { scrollEdges } = await import("../src/ui/OpenIsland");
    expect(scrollEdges(0, 120, 120)).toEqual({ top: false, bottom: false });
    expect(scrollEdges(0, 120, 300)).toEqual({ top: false, bottom: true });
    expect(scrollEdges(90, 120, 300)).toEqual({ top: true, bottom: true });
    expect(scrollEdges(180, 120, 300)).toEqual({ top: true, bottom: false });
    expect(scrollEdges(179.7, 120, 300)).toEqual({ top: true, bottom: false });
  });
});
