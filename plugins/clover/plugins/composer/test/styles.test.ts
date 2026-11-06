import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssVariable, TOKENS } from "../client/tokens";
import { COLOR_LITERAL, frameUnsafeRules, parseCss, positionedRules } from "./css";

const css = readFileSync(join(import.meta.dir, "../client/styles.css"), "utf8");

describe("the composer stylesheet", () => {
  test("uses exactly the tokens tokens.ts names", () => {
    const used = new Set([...css.matchAll(/var\((--clover-[a-z0-9-]+)/g)].map((m) => m[1]));
    const listed = new Set(TOKENS.map(cssVariable));
    expect([...used].filter((v) => !listed.has(v!))).toEqual([]);
    expect([...listed].filter((v) => !used.has(v))).toEqual([]);
  });

  test("holds no colour literals", () => {
    const offenders = parseCss(css).flatMap((rule) =>
      rule.declarations.filter((d) => COLOR_LITERAL.test(d.value)).map((d) => `${rule.prelude} { ${d.property}: ${d.value} }`),
    );
    expect(offenders).toEqual([]);
  });

  test("fades only its own icons", () => {
    expect(frameUnsafeRules(css, [".cl-composer-icon"])).toEqual([]);
  });

  test("nothing leaves the part: the one positioned element is the drop hint inside the box (review item 1)", () => {
    const positioned = positionedRules(css);
    expect(positioned.map((p) => p.selector)).toEqual([".cl-composer__drop"]);
    expect(positioned.filter((p) => p.escapes)).toEqual([]);
    // The box casts no shadow over the conversation above it.
    const box = parseCss(css).filter((r) => r.prelude.trim().startsWith(".cl-composer__box"));
    expect(box.flatMap((r) => r.declarations).filter((d) => d.property === "box-shadow")).toEqual([]);
  });
});
