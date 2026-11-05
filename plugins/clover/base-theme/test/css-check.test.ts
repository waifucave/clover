import { describe, expect, test } from "bun:test";
import { checkThemeCss, hidesFrames } from "../src/css-check";

describe("checkThemeCss: the cleaner's limits", () => {
  test("refuses @import and @property, and at-rules the cleaner drops", () => {
    const problems = checkThemeCss(`@import "x.css"; @property --x { syntax: "<color>"; } @page { margin: 0 }`);
    expect(problems).toContain("@import is not an at-rule the cleaner keeps");
    expect(problems).toContain("@property is not an at-rule the cleaner keeps");
    expect(problems).toContain("@page is not an at-rule the cleaner keeps");
  });

  test("keeps the at-rules it allows", () => {
    const css = `
      @media (min-width: 400px) { .a { color: red } }
      @supports (display: grid) { .b { display: grid } }
      @container (min-width: 1px) { .c { color: blue } }
      @scope (.d) to (.e) { :scope { color: green } }
      @layer base { .f { margin: 0 } }
      @keyframes spin { from { color: red } to { color: blue } }
      @font-face { font-family: X; src: url(fonts/x.woff2); }
      @starting-style { .g { color: red } }`;
    expect(checkThemeCss(css)).toEqual([]);
  });

  test("allows url() only for files inside the plugin", () => {
    expect(checkThemeCss(`.a { background: url(assets/sky.svg) }`)).toEqual([]);
    expect(checkThemeCss(`.a { background: url("assets/sky.svg") }`)).toEqual([]);
    for (const bad of ["https://x.test/a.png", "/abs.png", "../up.png", "data:image/png;base64,AA", "a/../../b.png"]) {
      expect(checkThemeCss(`.a { background: url(${bad}) }`), bad).toHaveLength(1);
    }
  });

  test("ignores what a comment says", () => {
    expect(checkThemeCss(`/* @import "x"; .a { opacity: 0 } url(https://x) */ .a { color: red }`)).toEqual([]);
  });
});

describe("checkThemeCss: sealed frames stay visible", () => {
  test("refuses effects on elements", () => {
    for (const declaration of [
      "opacity: 0.5",
      "opacity: 50%",
      "filter: blur(2px)",
      "backdrop-filter: blur(8px)",
      "transform: rotate(2deg)",
      "transform: scale(0.98)",
      "transform: translateY(2px) skewX(3deg)",
      "scale: 0.9",
      "rotate: 3deg",
      "mask-image: linear-gradient(red, transparent)",
      "clip-path: circle(40%)",
      "mix-blend-mode: multiply",
    ]) {
      expect(checkThemeCss(`.part { ${declaration} }`), declaration).toHaveLength(1);
    }
  });

  test("allows moves and enlargements", () => {
    for (const declaration of ["opacity: 1", "transform: translate(2px, 3px)", "transform: scale(1.03)", "transform: none", "scale: 1.02", "filter: none"]) {
      expect(checkThemeCss(`.part { ${declaration} }`), declaration).toEqual([]);
    }
  });

  test("allows any effect on pseudo-elements, which never hold a frame", () => {
    expect(checkThemeCss(`.part::before { opacity: 0.4; filter: blur(12px); transform: rotate(10deg) }`)).toEqual([]);
    expect(checkThemeCss(`.a::after, .b::before { opacity: 0.2 }`)).toEqual([]);
  });

  test("refuses a rule that reaches an element as well as a pseudo-element", () => {
    expect(checkThemeCss(`.a::after, .b { opacity: 0.2 }`)).toHaveLength(1);
  });

  test("follows nesting", () => {
    expect(checkThemeCss(`.part { color: red; &::before { opacity: 0.3 } }`)).toEqual([]);
    expect(checkThemeCss(`.part { color: red; & .inner { opacity: 0.3 } }`)).toHaveLength(1);
    expect(checkThemeCss(`@media (min-width: 1px) { .part { filter: blur(1px) } }`)).toHaveLength(1);
  });

  test("judges an animation by what its keyframes set", () => {
    const keyframes = `@keyframes twinkle { from { opacity: 0.2 } to { opacity: 1 } }`;
    expect(checkThemeCss(`${keyframes} .part::before { animation: twinkle 2s infinite }`)).toEqual([]);
    expect(checkThemeCss(`${keyframes} .part { animation: twinkle 2s infinite }`)).toHaveLength(1);
    expect(checkThemeCss(`@keyframes shift { to { color: red } } .part { animation: shift 1s }`)).toEqual([]);
  });

  test("hidesFrames reads values the way a browser would", () => {
    expect(hidesFrames({ property: "opacity", value: "1 !important" })).toBe(false);
    expect(hidesFrames({ property: "opacity", value: "0.999" })).toBe(true);
    expect(hidesFrames({ property: "transform", value: "scale(1.2, 1.1)" })).toBe(true);
    expect(hidesFrames({ property: "transform", value: "translate3d(0, 2px, 0) scale(1.05)" })).toBe(false);
    expect(hidesFrames({ property: "color", value: "red" })).toBe(false);
  });
});
