// Spec §5.5: a sealed approval frame counts as hidden under a filter, an opacity below 1, or a transform
// other than a move or an enlargement, on itself or anything around it; and a button must show whole at
// 24 × 24 or more. These hold every place the island puts sealed parts, at rest.

import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { cardGeometry } from "../src/model/geometry";
import { NEEDS_YOU, tabState } from "../src/model/tabs";
import { LiquidCard } from "../src/ui/Liquid";
import { NeedsYou, OpenIsland } from "../src/ui/OpenIsland";
import { SealedCardContent } from "../src/ui/CardContent";
import { ISLAND_CARD_TOKENS, MIN_SEALED_BUTTON, mockSealedKit, SealedKitContext } from "../src/ui/sealed";
import { APPROVAL, LINK, NOTCH, QUESTION, SEALED } from "../src/fixtures";

const kit = mockSealedKit(SEALED);
const withKit = (ui: ReactElement) => <SealedKitContext.Provider value={kit}>{ui}</SealedKitContext.Provider>;

function hidingEffects(el: Element): string[] {
  const problems: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = (node as HTMLElement).style;
    if (!style) continue;
    if (style.filter && style.filter !== "none") problems.push(`filter on ${node.className}`);
    if (style.opacity !== "" && Number(style.opacity) < 1) problems.push(`opacity ${style.opacity} on ${node.className}`);
    const transform = style.transform;
    if (transform && transform !== "none") {
      const scale = /^scale\(([\d.]+)\)$/.exec(transform);
      if (!scale || Number(scale[1]) < 1) problems.push(`transform ${transform} on ${node.className}`);
    }
    for (const property of ["mask-image", "-webkit-mask-image", "clip-path"]) {
      const value = style.getPropertyValue(property);
      if (value && value !== "none") problems.push(`${property} on ${node.className}`);
    }
  }
  return problems;
}

function assertVisible(container: HTMLElement): void {
  const parts = container.querySelectorAll("[data-sealed]");
  expect(parts.length).toBeGreaterThan(0);
  for (const part of parts) expect(hidingEffects(part)).toEqual([]);
  for (const button of container.querySelectorAll('[data-sealed="approve"], [data-sealed="deny"]')) {
    const style = (button as HTMLElement).style;
    expect(parseFloat(style.width)).toBeGreaterThanOrEqual(MIN_SEALED_BUTTON);
    expect(parseFloat(style.height)).toBeGreaterThanOrEqual(MIN_SEALED_BUTTON);
  }
}

describe("sealed parts stay visible at rest", () => {
  const g = cardGeometry(NOTCH, { width: 400, height: 120 }, { rounded: true });

  test("on a card on top, resting and hovered", () => {
    for (const hovered of [false, true]) {
      const { container, unmount } = render(
        withKit(
          <LiquidCard geometry={g} hovered={hovered}>
            <SealedCardContent card={APPROVAL} />
          </LiquidCard>,
        ),
      );
      assertVisible(container);
      unmount();
    }
  });

  test("but not while the card is still being born (its clicks do not count yet)", () => {
    const { container } = render(
      withKit(
        <LiquidCard geometry={g} seconds={0.7}>
          <SealedCardContent card={LINK} />
        </LiquidCard>,
      ),
    );
    const part = container.querySelector("[data-sealed]")!;
    expect(hidingEffects(part).length).toBeGreaterThan(0);
  });

  test("in the open island's Needs you", () => {
    const { container } = render(
      withKit(
        <OpenIsland shape={NOTCH} tabs={tabState([NEEDS_YOU])} count={3}>
          <NeedsYou cards={[APPROVAL, LINK, QUESTION]} />
        </OpenIsland>,
      ),
    );
    assertVisible(container);
  });

  test("the island hands its frames card tokens only", () => {
    for (const name of Object.keys(ISLAND_CARD_TOKENS)) expect(name.startsWith("card.")).toBe(true);
  });
});
