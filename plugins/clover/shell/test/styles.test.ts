import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssVariable, TOKENS } from "../client/tokens";
import { COLOR_LITERAL, frameUnsafeRules, parseCss } from "./css";

const css = readFileSync(join(import.meta.dir, "../client/styles.css"), "utf8");

describe("the sidebar stylesheet", () => {
  test("uses exactly the tokens tokens.ts names", () => {
    const used = new Set([...css.matchAll(/var\((--clover-[a-z0-9-]+)/g)].map((m) => m[1]));
    const listed = new Set(Object.keys(TOKENS).map(cssVariable));
    expect([...used].filter((v) => !listed.has(v!))).toEqual([]);
    expect([...listed].filter((v) => !used.has(v))).toEqual([]);
  });

  test("holds no colour literals", () => {
    const offenders = parseCss(css).flatMap((rule) =>
      rule.declarations.filter((d) => COLOR_LITERAL.test(d.value)).map((d) => `${rule.prelude} { ${d.property}: ${d.value} }`),
    );
    expect(offenders).toEqual([]);
  });

  test("never fades, filters or transforms", () => {
    expect(frameUnsafeRules(css, [])).toEqual([]);
  });
});
