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

  test("resolves each url() against the file's own folder inside the plugin", () => {
    expect(checkThemeCss(`.a { background: url(../art/sky.svg) }`, { path: "styles/theme.css" })).toEqual([]);
    expect(checkThemeCss(`.a { background: url(../../sky.svg) }`, { path: "styles/theme.css" })).toHaveLength(1);
    expect(checkThemeCss(`.a { background: url(art/) }`)).toHaveLength(1);
  });

  test("refuses what a raw-string check lets through (the review's cases)", () => {
    for (const css of [
      `.a { background: url(%2e%2e/secret.png) }`,
      `.a { background: url(art/%2e%2e/%2e%2e/x.png) }`,
      `.a { background: url("art\\..\\x.png") }`,
      `.a { background: url(//evil.test/x.png) }`,
      `.a { background: url(" https://evil.test/x.png") }`,
      `.a { background: image-set("https://evil.test/x.png" 1x) }`,
      `.a { background: -webkit-image-set("https://evil.test/x.png" 1x) }`,
      `.a { background: image("https://evil.test/x.png") }`,
      `.a { background: element(#secret) }`,
      `.a { background: cross-fade(url(a.png), url(b.png), 50%) }`,
      `.a { background: src("https://evil.test/x.png") }`,
      `.a { background: attr(data-art type(<url>)) }`,
      `.a { background: u\\72 l(https://evil.test/x.png) }`,
      `.a { fil\\74 er: blur(4px) }`,
    ]) {
      expect(checkThemeCss(css).length, css).toBeGreaterThan(0);
    }
    // An escape inside a string is only text.
    expect(checkThemeCss(`.a::before { content: "\\2713" }`)).toEqual([]);
    expect(checkThemeCss(`.a::before { content: attr(title) }`)).toEqual([]);
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
      expect(checkThemeCss(`.part { ${declaration} }`, { component: true }), declaration).toHaveLength(1);
    }
  });

  test("allows moves and enlargements around a frame (a part's own sheet; a theme may not move elements at all)", () => {
    for (const declaration of ["opacity: 1", "transform: translate(2px, 3px)", "transform: scale(1.03)", "transform: none", "scale: 1.02", "filter: none"]) {
      expect(checkThemeCss(`.part { ${declaration} }`, { component: true }), declaration).toEqual([]);
    }
    for (const declaration of ["transform: scale(1.03)", "transform: none", "scale: 1.02", "visibility: visible", "offset-path: none"]) {
      expect(checkThemeCss(`.part { ${declaration} }`), declaration).toEqual([]);
    }
  });

  test("refuses hiding by visibility, a motion path, content-visibility and reflections", () => {
    for (const declaration of [
      "visibility: hidden",
      "visibility: collapse",
      "offset-path: path('M 0 0 L 100 100')",
      "offset: ray(45deg) 10%",
      "content-visibility: hidden",
      "-webkit-box-reflect: below",
      "-webkit-mask-box-image: linear-gradient(red, blue)",
    ]) {
      expect(checkThemeCss(`.part { ${declaration} }`), declaration).toHaveLength(1);
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

describe("checkThemeCss: nothing is drawn over a sealed frame", () => {
  test("refuses a pseudo-element positioned over its element's content", () => {
    expect(checkThemeCss(`.card::after { content: ""; position: absolute; inset: 0; box-shadow: inset 0 0 0 1px #FFF }`)).toHaveLength(1);
    expect(checkThemeCss(`.card::before { content: ""; position: fixed; inset: 0 }`)).toHaveLength(1);
    expect(checkThemeCss(`.card::before { content: ""; position: absolute; inset: 0; z-index: 0 }`)).toHaveLength(1);
  });

  test("allows one kept beneath the content, or in flow", () => {
    expect(checkThemeCss(`.stage { position: relative; isolation: isolate } .stage::before { content: ""; position: absolute; inset: 0; z-index: -1 }`)).toEqual([]);
    expect(checkThemeCss(`.chip::after { content: "·"; margin-left: 4px }`)).toEqual([]);
  });

  test("refuses elements taken out of flow, shifted, moved or lifted", () => {
    for (const css of [
      `.composer { position: fixed; bottom: 0 }`,
      `.composer { position: absolute; top: 0 }`,
      `.composer { position: sticky; top: 0 }`,
      `.composer { position: relative; top: -40px }`,
      `.composer { position: relative; inset: 0 0 0 -20px }`,
      `.composer { transform: translateY(-40px) }`,
      `.composer { translate: 0 -40px }`,
      `.composer { z-index: 5 }`,
    ]) {
      expect(checkThemeCss(css).length, css).toBeGreaterThan(0);
    }
  });

  test("refuses a margin that could pull an element over its neighbours (the review's pull-over)", () => {
    for (const css of [
      `.card { margin-top: -400px }`,
      `.card { margin: 0 0 -1px }`,
      `.card { margin-inline-start: -.5em }`,
      `.card { margin-block: calc(0px - 40px) }`,
      `.card { margin-top: var(--clover-space-4) }`,
      `.card::after { content: "·"; margin-left: -8px }`,
    ]) {
      expect(checkThemeCss(css).length, css).toBeGreaterThan(0);
    }
    expect(checkThemeCss(`.card { margin: 0 auto 12px; padding: 4px }`)).toEqual([]);
  });

  test("allows an element positioned in place, and anything beneath", () => {
    expect(checkThemeCss(`.stage { position: relative }`)).toEqual([]);
    expect(checkThemeCss(`.stage { position: relative; top: 0; left: auto }`)).toEqual([]);
    expect(checkThemeCss(`.backdrop { position: absolute; inset: 0; z-index: -1 }`)).toEqual([]);
  });

  test("leaves a part's own layout to the check on the rendered part", () => {
    expect(checkThemeCss(`.shell { position: absolute; top: 0 } .shell::after { content: ""; position: absolute; inset: 0 }`, { component: true })).toEqual([]);
  });
});
