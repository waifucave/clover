import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssVariable, TOKENS } from "../client/tokens";
import { COLOR_LITERAL, frameUnsafeRules, parseCss, subjectOf } from "./css";

const css = readFileSync(join(import.meta.dir, "../client/styles.css"), "utf8");

/** Leaf decorations that never hold a sealed frame: icons, the caret, breathing status text. */
const LEAVES = [".cl-conv-icon", ".cl-conv-chevron", "::after", ".cl-conv-thinking__glyph", ".cl-conv-thinking__label", ".cl-conv-working__glyph", ".cl-conv-working__text"];

describe("the conversation stylesheet", () => {
  test("uses exactly the tokens tokens.ts names", () => {
    const used = new Set([...css.matchAll(/var\((--clover-[a-z0-9-]+)/g)].map((m) => m[1]));
    const listed = new Set(Object.keys(TOKENS).map(cssVariable));
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
