// The CSS cleaner (spec §5.5): kept and dropped at-rules, prefixed names and their uses, URLs by lane B's rule
// rewritten to the core's asset URLs, dropped functions and dynamic URLs, the scope wrapper, and a layout's classes.
import { describe, expect, test } from "bun:test";
import { cleanCss, namePrefix, prefixedClass, renameFontValue, tokenize } from "../src/main/ui/css";

const asset = (path: string) => `/_t/luna/${path}`;
const clean = (css: string, extra: Partial<Parameters<typeof cleanCss>[1]> = {}) => cleanCss(css, { pluginId: "luna", file: "tab/theme.css", assetUrl: asset, ...extra });

describe("the tokenizer", () => {
  test("escapes and comments hide nothing", () => {
    const t = tokenize("u\\72 l(a.png) /* x */ @\\69mport 'b';");
    expect(t.find((x) => x.kind === "url")?.value).toBe("a.png");
    expect(t.find((x) => x.kind === "at")?.value).toBe("import");
    expect(t.some((x) => x.raw.includes("/*"))).toBe(false);
  });
});

describe("at-rules", () => {
  test("only the named ones stay; @import, @charset, @namespace, @property and @page go, however they're spelled", () => {
    const r = clean(`@import "x.css"; @\\69mport url(y.css); @charset "utf-8"; @namespace svg url(x); @property --x { syntax: "*"; inherits: false; } @page { margin: 0 } .a { color: red }`);
    expect(r.css).not.toMatch(/@import|@charset|@namespace|@property|@page/);
    expect(r.css).toContain(".a{color:red}");
    expect(r.dropped).toEqual(expect.arrayContaining(["@import", "@charset", "@namespace", "@property", "@page"]));
  });

  test("@media, @supports, @container, @layer, @starting-style stay, their style rules in the scope", () => {
    const r = clean(`@media (prefers-color-scheme: dark) { .a { color: white } } @supports (display: grid) { .b { display: grid } }`, { scope: { root: '[data-clover-part="m1"]', limit: "[data-clover-styled]:not(:scope)" } });
    expect(r.css).toBe(`@media (prefers-color-scheme: dark){@scope ([data-clover-part="m1"]) to ([data-clover-styled]:not(:scope)){.a{color:white}}}\n@supports (display: grid){@scope ([data-clover-part="m1"]) to ([data-clover-styled]:not(:scope)){.b{display:grid}}}`);
  });

  test("a plugin's own @scope stays inside the core's", () => {
    const r = clean(`@scope (body) { * { color: red } }`, { scope: { root: "#r" } });
    expect(r.css).toBe("@scope (#r){@scope (body){*{color:red}}}");
  });
});

describe("names it defines", () => {
  test("keyframes, fonts, counter styles, palettes and layers are prefixed, and so are the plugin's own uses", () => {
    const r = clean(`
      @keyframes spin { from { transform: rotate(0) } to { transform: rotate(1turn) } }
      @font-face { font-family: "Luna Sans"; src: url(fonts/luna.woff2) format("woff2"); }
      @counter-style petals { system: cyclic; symbols: "*"; }
      @font-palette-values --warm { font-family: "Luna Sans"; }
      @layer base, tweaks;
      .a { animation: spin 1s linear; font-family: "Luna Sans", system-ui; list-style: petals; font-palette: --warm; }
      .b { animation-name: fade; font: 12px/1.4 "Luna Sans"; counter-reset: x; content: counter(x, petals); }`);
    const p = namePrefix("luna");
    expect(r.css).toContain(`@keyframes ${p}spin{`);
    expect(r.css).toContain(`@font-face{font-family:"${p}Luna Sans";src:url("/_t/luna/tab/fonts/luna.woff2") format("woff2")}`);
    expect(r.css).toContain(`@counter-style ${p}petals{`);
    expect(r.css).toContain(`@font-palette-values --${p}warm{`);
    expect(r.css).toContain(`@layer ${p}base, ${p}tweaks;`);
    expect(r.css).toContain(`animation:${p}spin 1s linear`);
    expect(r.css).toContain(`font-family:"${p}Luna Sans", system-ui`);
    expect(r.css).toContain(`list-style:${p}petals`);
    expect(r.css).toContain(`font-palette:--${p}warm`);
    // Names it didn't define stay.
    expect(r.css).toContain("animation-name:fade");
    expect(r.css).toContain(`font:12px/1.4 "${p}Luna Sans"`);
    expect(r.css).toContain(`counter(x, ${p}petals)`);
  });

  test("two plugins' names never meet: a child's id is written with _, which no id has", () => {
    expect(namePrefix("clover/base-theme")).toBe("clv-clover_base-theme__");
    expect(prefixedClass("alpha", "card")).toBe("clv-alpha__card");
  });

  test("a theme's fonts rename its font tokens", () => {
    expect(renameFontValue(`"Luna Sans", system-ui, sans-serif`, "luna", new Set(["Luna Sans"]))).toBe(`"clv-luna__Luna Sans", system-ui, sans-serif`);
    expect(renameFontValue("system-ui", "luna", new Set(["Luna Sans"]))).toBe("system-ui");
  });
});

describe("URLs (lane B's rule)", () => {
  test("files inside the folder become the core's asset URLs; the rest drop their declaration", () => {
    const r = clean(`.a { background: url(bg.png) } .b { background: url("../../etc/passwd") } .c { background: url(https://x.example/a.png) } .d { background: u\\72 l(%2e%2e/x.png) } .e { background-image: image-set("a.png" 1x, "https://x.example/b.png" 2x) } .f { mask: image(x.png) } .g { --u: url(data:image/png;base64,AA); }`);
    expect(r.css).toContain('.a{background:url("/_t/luna/tab/bg.png")}');
    // `%2e%2e` is `..`, resolved as a browser would: still inside the folder, at its top.
    expect(r.css).toContain('.d{background:url("/_t/luna/x.png")}');
    for (const c of [".b{", ".c{", ".e{", ".f{", ".g{"]) expect(r.css).toContain(`${c}}`);
  });

  test("a URL built from var(), env() or attr() drops its declaration", () => {
    const r = clean(`.a { --u: "x.png"; background: image-set(var(--u) 1x); } .b { background: url(ok.png) }`);
    expect(r.css).toContain('.a{--u:"x.png"}');
    expect(r.css).toContain('.b{background:url("/_t/luna/tab/ok.png")}');
  });

  test("the user's own CSS may load nothing at all", () => {
    const r = cleanCss(`.a { background: url(bg.png); color: red }`, { pluginId: "user" });
    expect(r.css).toBe(".a{color:red}");
  });
});

describe("a layout's CSS", () => {
  test("its classes are prefixed like its nodes'", () => {
    const r = clean(`.card > .title:hover, .card:not(.wide) { padding: 4px }`, { prefixClasses: true });
    expect(r.css).toBe(".clv-luna__card > .clv-luna__title:hover, .clv-luna__card:not(.clv-luna__wide){padding:4px}");
  });
});

describe("nesting", () => {
  test("nested rules and a nested @media keep their declarations", () => {
    const r = clean(`.a { color: red; &:hover { color: blue } @media (width > 600px) { color: green } }`);
    expect(r.css).toBe(".a{color:red;&:hover{color:blue}@media (width > 600px){color:green}}");
  });
});
