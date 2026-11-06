import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssVariable, TOKENS } from "../client/tokens";
import { COLOR_LITERAL, frameUnsafeRules, parseCss, positionedRules } from "./css";

const css = readFileSync(join(import.meta.dir, "../client/styles.css"), "utf8");

/** Leaves that may move or fade: they never hold a sealed frame. */
const LEAVES: string[] = [];

/** None. */
const POSITIONED: string[] = [];

describe("the panel-files stylesheet", () => {
  test("uses exactly the tokens tokens.ts names", () => {
    const used = new Set([...css.matchAll(/var\((--clover-[a-z0-9_-]+)/g)].map((m) => m[1]));
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

  test("never fades, filters, clips or transforms anything that could hold a sealed frame", () => {
    expect(frameUnsafeRules(css, LEAVES)).toEqual([]);
  });

  test("positions only its listed elements out of the flow, and none reaches outside the part", () => {
    const positioned = positionedRules(css);
    expect(positioned.map((p) => p.selector).sort()).toEqual([...POSITIONED].sort());
    expect(positioned.filter((p) => p.escapes)).toEqual([]);
  });

  test("animations stop for reduced motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
