import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssVariable, TOKENS } from "../client/tokens";
import { COLOR_LITERAL, frameUnsafeRules, parseCss, positionedRules, subjectOf } from "./css";

const css = readFileSync(join(import.meta.dir, "../client/styles.css"), "utf8");

/** Leaf decorations that never hold a sealed frame: icons, the caret, breathing status text. */
/** Leaf decorations that never hold a sealed frame: icons, the caret (a pseudo-element, which can hold
 *  nothing), breathing status text, a copy button's label. Overlap is the positioned check's business. */
const LEAVES = [
  ".cl-conv-icon", ".cl-conv-chevron", ".cl-conv-thinking__glyph", ".cl-conv-thinking__label", ".cl-conv-working__glyph",
  ".cl-conv-working__text", ".cl-conv-copy__label", "::after",
];

/** The only out-of-flow elements, each a leaf inside its own box: a copied label over its button,
 *  and the screen-reader line (1 by 1 pixels). */
const POSITIONED = [".cl-conv-bot__actions .cl-conv-copy__label", ".cl-conv__announce"];

describe("the conversation stylesheet", () => {
  test("uses exactly the tokens tokens.ts names", () => {
    const used = new Set([...css.matchAll(/var\((--clover-[a-z0-9-]+)/g)].map((m) => m[1]));
    const listed = new Set(TOKENS.map(cssVariable));
    expect([...used].filter((v) => !listed.has(v!))).toEqual([]);
    expect([...listed].filter((v) => !used.has(v))).toEqual([]);
  });

  test("holds no colour literals: every colour is a token", () => {
    const offenders = parseCss(css).flatMap((rule) =>
      rule.declarations.filter((d) => COLOR_LITERAL.test(d.value)).map((d) => `${rule.prelude} { ${d.property}: ${d.value} }`),
    );
    expect(offenders).toEqual([]);
  });

  test("never fades, filters or transforms anything that could hold a sealed frame", () => {
    expect(frameUnsafeRules(css, LEAVES)).toEqual([]);
  });

  test("the guard itself catches a fade around a card", () => {
    expect(frameUnsafeRules(".cl-conv-approval { opacity: 0.9; }", LEAVES)).toEqual([".cl-conv-approval"]);
    expect(frameUnsafeRules(".cl-conv__column { transform: scale(0.98); }", LEAVES)).toEqual([".cl-conv__column"]);
    expect(frameUnsafeRules("@keyframes f { to { opacity: 0 } } .cl-conv__unit { animation: f 1s; }", LEAVES)).toEqual([".cl-conv__unit"]);
    expect(frameUnsafeRules(".cl-conv__unit { transform: translateY(4px); opacity: 1; filter: none; }", LEAVES)).toEqual([]);
  });

  test("positions nothing out of the flow but its listed leaves, and nothing reaches outside the part", () => {
    const positioned = positionedRules(css);
    expect(positioned.map((p) => p.selector).sort()).toEqual([...POSITIONED].sort());
    expect(positioned.filter((p) => p.escapes)).toEqual([]);
  });

  test("the overlap guard catches a menu that leaves its part", () => {
    expect(positionedRules(".m { position: absolute; bottom: 100%; }")[0]?.escapes).toBe(true);
    expect(positionedRules(".m { position: fixed; }")[0]?.escapes).toBe(true);
    expect(positionedRules(".m { position: absolute; top: -4px; }")[0]?.escapes).toBe(true);
    expect(positionedRules(".m { position: absolute; top: 2px; right: 0; }")[0]?.escapes).toBe(false);
  });

  test("clip and mask count as hiding too", () => {
    expect(frameUnsafeRules(".cl-conv__unit { clip-path: inset(0 0 4px 0); }", LEAVES)).toEqual([".cl-conv__unit"]);
    expect(frameUnsafeRules(".cl-conv__unit { mask-image: linear-gradient(transparent, black); }", LEAVES)).toEqual([".cl-conv__unit"]);
  });

  test("only a disclosure chevron turns (a status mark never does)", () => {
    const turning = parseCss(css).filter((r) => r.declarations.some((d) => d.property === "transform" && /rotate/.test(d.value)));
    expect(turning.length).toBeGreaterThan(0);
    for (const rule of turning) {
      for (const selector of rule.prelude.split(",")) expect(subjectOf(selector)).toBe(".cl-conv-chevron");
    }
  });

  test("animations stop for reduced motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

describe("the window's title bar over the view", () => {
  const rules = parseCss(css);
  const decl = (selector: string, property: string) =>
    rules.find((r) => r.prelude === selector && r.context.length === 0)?.declarations.find((d) => d.property === property)?.value ?? "";

  test("the reading column and the jump button follow the frame's axis shift, inside the scrolling area", () => {
    expect(decl(".cl-conv__viewport", "padding-left")).toBe("var(--cl-axis-shift, 0px)");
    expect(decl(".cl-conv__footer", "padding-left")).toBe("var(--cl-axis-shift, 0px)");
  });

  test("the content starts below the bar, and anything scrolled into view stops below it", () => {
    expect(decl(".cl-conv__column", "padding")).toMatch(/^calc\(var\(--cl-inset-top, 0px\) \+/);
    expect(decl(".cl-conv__viewport", "scroll-padding-top")).toBe("var(--cl-inset-top, 0px)");
  });

  test("a pending card pins below the bar, never under it, and a jump to it keeps a margin (scroll-margin-top)", () => {
    expect(decl(".cl-conv__unit[data-pending]", "position")).toBe("sticky");
    expect(decl(".cl-conv__unit[data-pending]", "top")).toMatch(/^calc\(var\(--cl-inset-top, 0px\) \+ var\(--clover-space-xs\)\)$/);
    expect(decl(".cl-conv__unit[data-pending]", "scroll-margin-top")).toBe("var(--clover-space-s)");
    // Over what scrolls under it, inside the viewport's own stacking context (review round 3, B).
    expect(decl(".cl-conv__unit[data-pending]", "z-index")).toBe("1");
    expect(decl(".cl-conv__viewport", "isolation")).toBe("isolate");
    // The view's own padding is 0, so the pin and the jump both measure from the scrollport's top edge, the
    // bar's top: the inset is on the column, never on the viewport.
    expect(decl(".cl-conv__viewport", "padding-top")).toBe("");
  });
});
