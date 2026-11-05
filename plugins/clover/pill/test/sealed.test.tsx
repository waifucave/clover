// Spec §5.5: a sealed approval frame counts as hidden under a filter, an opacity below 1, or a transform other
// than a move or an enlargement, on itself or anything around it; and a button must show whole at 24 × 24 or
// more. These hold wherever the pill puts sealed parts, at rest, hovered or not.

import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { CardBody } from "../src/ui/Card";
import { Shell } from "../src/ui/Shell";
import { MIN_SEALED_BUTTON, PILL_CARD_TOKENS, mockSealedKit, SealedKitContext } from "../src/ui/sealed";
import { emptyDraft } from "../src/model/cards";
import { hoverScale } from "../src/model/metrics";
import { APPROVAL, LINK, SEALED } from "../src/fixtures";

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

function card(c: typeof APPROVAL | typeof LINK, size = { width: 440, height: 180 }, target = size, visibility = 1, hoverGrow = false): ReactElement {
  return withKit(
    <div className="clp-stack" style={hoverGrow ? { transform: `scale(${hoverScale(size.width)})` } : undefined}>
      <Shell size={size} target={target} visibility={visibility}>
        <CardBody card={c} draft={emptyDraft()} />
      </Shell>
    </div>,
  );
}

describe("sealed parts stay visible at rest", () => {
  test("on an approval and a link card, resting and under the pointer", () => {
    for (const c of [APPROVAL, LINK]) {
      for (const hoverGrow of [false, true]) {
        const { container, unmount } = render(card(c, undefined, undefined, 1, hoverGrow));
        const parts = container.querySelectorAll("[data-sealed]");
        expect(parts.length).toBeGreaterThan(0);
        for (const part of parts) expect(hidingEffects(part)).toEqual([]);
        for (const button of container.querySelectorAll('[data-sealed="approve"], [data-sealed="deny"]')) {
          const style = (button as HTMLElement).style;
          expect(parseFloat(style.width)).toBeGreaterThanOrEqual(MIN_SEALED_BUTTON);
          expect(parseFloat(style.height)).toBeGreaterThanOrEqual(MIN_SEALED_BUTTON);
        }
        unmount();
      }
    }
  });

  test("but not while the shape still moves or the card fades (its clicks do not count yet)", () => {
    const moving = render(card(APPROVAL, { width: 380, height: 100 }, { width: 440, height: 180 }));
    expect(hidingEffects(moving.container.querySelector("[data-sealed]")!).length).toBeGreaterThan(0);
    moving.unmount();
    const fading = render(card(APPROVAL, undefined, undefined, 0.5));
    expect(hidingEffects(fading.container.querySelector("[data-sealed]")!).length).toBeGreaterThan(0);
  });

  test("the pill hands its frames card tokens only", () => {
    for (const name of Object.keys(PILL_CARD_TOKENS)) expect(name.startsWith("card.")).toBe(true);
  });
});
