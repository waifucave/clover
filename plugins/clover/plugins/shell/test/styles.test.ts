import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssVariable, TOKENS } from "../client/tokens";
import { COLOR_LITERAL, frameUnsafeRules, parseCss, positionedRules } from "./css";

const css = readFileSync(join(import.meta.dir, "../client/styles.css"), "utf8");

/** Leaves that may move or fade: they never hold a sealed frame. The title bar blurs what scrolls under
 *  it, and holds only the title and the panel toggles. */
const LEAVES: string[] = [".cl-window-icon", ".cl-window__bar"];

/** Out of the flow, inside the window:
 *  - the title bar, over the conversation's top: a pending card always scrolls fully below it (the
 *    conversation's `scroll-margin-top`, and its sticky pending cards);
 *  - the dialog layer, which the frame never shows while any card it will draw waits. */
const POSITIONED: string[] = [".cl-window__bar", ".cl-window__dialog"];

describe("the shell stylesheet", () => {
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

describe("the frame's material and its bar", () => {
  const rules = parseCss(css);
  /** A declaration for a selector, alone or in a selector list. */
  const decl = (selector: string, property: string) =>
    rules
      .find((r) => r.context.length === 0 && r.prelude.split(",").map((p) => p.trim().replace(/\s+/g, " ")).includes(selector))
      ?.declarations.find((d) => d.property === property)?.value;

  test("the window root paints nothing; the main column and the panel paint the surface", () => {
    expect(decl(".cl-window", "background")).toBe("transparent");
    expect(decl(".cl-window__main", "background")).toBe("var(--clover-color-surface)");
    expect(decl(".cl-window__panel", "background")).toBe("var(--clover-color-surface)");
  });

  test("the sidebar is a tint over the window's material, and a solid colour without one", () => {
    expect(decl(".cl-window__sidebar", "background")).toBe("var(--clover-plugin-clover-sidebar-solid)");
    expect(decl(".cl-window[data-translucent] .cl-window__sidebar", "background")).toBe("var(--clover-plugin-clover-sidebar-tint)");
  });

  test("the bar is translucent and blurs what passes under it; the bot tab tells the conversation its height", () => {
    expect(decl(".cl-window__bar", "background")).toBe("var(--clover-plugin-clover-bar-tint)");
    expect(decl(".cl-window__bar", "backdrop-filter")).toContain("var(--clover-plugin-clover-bar-blur)");
    expect(decl(".cl-window__bar", "height")).toBe("var(--clover-plugin-clover-bar-height)");
    // Only in main: a bot tab in the panel (an agent opened from a bot's column) has no bar over it.
    expect(decl(".cl-window__content > .cl-bot-tab > .cl-bot-tab__conversation", "--cl-inset-top")).toBe("var(--clover-plugin-clover-bar-height)");
    // An agent's live tab in main runs up under the bar the same way.
    expect(decl(".cl-window__content > .cl-agent-tab > .cl-bot-tab > .cl-bot-tab__conversation", "--cl-inset-top")).toBe("var(--clover-plugin-clover-bar-height)");
    expect(decl(".cl-bot-tab__conversation", "--cl-inset-top")).toBeUndefined();
    // Anything else in main starts below the bar.
    expect(decl(".cl-window__content", "padding-top")).toBe("var(--clover-plugin-clover-bar-height)");
    expect(decl(".cl-window__content:has(> .cl-bot-tab)", "padding-top")).toBe("0");
    // Nothing the bar holds paints below its rule (review round 3).
    expect(decl(".cl-window__bar", "overflow")).toBe("hidden");
  });

  test("the dialog layer never drags the window, and its dialog starts below the bar (review round 3)", () => {
    expect(decl(".cl-window__dialog", "-webkit-app-region")).toBe("no-drag");
    expect(decl(".cl-window__dialog", "padding")).toMatch(/^calc\(var\(--clover-plugin-clover-bar-height\) \+ /);
  });

  test("with the session column showing, the bot tab's column and composer move toward main's middle, as far as it leaves room", () => {
    expect(decl('.cl-window[data-side="open"] .cl-window__content', "--cl-axis-shift")).toBe("clamp(0px, 100cqi - 293px - 768px - 2 * var(--clover-space-xl), 293px)");
    expect(decl(".cl-window__side", "width")).toBe("293px");
    expect(decl(".cl-bot-tab__composer", "padding-left")).toBe("var(--cl-axis-shift, 0px)");
    // Where the column gives way, so does the shift.
    const narrow = parseCss(css).find((r) => r.prelude === '.cl-window[data-side="open"] .cl-window__content' && r.context.some((c) => c.includes("max-width: 720px")));
    expect(narrow?.declarations).toEqual([{ property: "--cl-axis-shift", value: "0px" }]);
  });
});
