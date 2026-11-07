// The static outside-reach check `clover plugin validate` errors on (#234's review, F2 (c)): the cheap cases the
// runtime guard also stops.
import { describe, expect, test } from "bun:test";
import { loaderReach } from "../loader-config";

const reach = (tree: Record<string, unknown>) => {
  const text = Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return loaderReach(Object.keys(text), (p) => text[p]);
};
const outsideFields = (tree: Record<string, unknown>) => reach(tree).outside.map((o) => o.field);

describe("loaderReach's outside cases", () => {
  test("a wildcard target with .. after its * reaches outside, in paths and package maps", () => {
    expect(outsideFields({ "tsconfig.json": { compilerOptions: { paths: { "lib/*": ["./host/a/*/../../../../outside/evil.ts"] } } }, "host/a/x/keep.txt": "" })).toEqual(["compilerOptions.paths.lib/*"]);
    expect(outsideFields({ "package.json": { imports: { "#x/*": "./src/*/../../../y.js" }, exports: { "./*": "./a/*/../../z.js" } } })).toEqual(["imports.#x/*", "exports../*"]);
    // `..` before the `*` that stays inside is fine.
    expect(outsideFields({ "tsconfig.json": { compilerOptions: { paths: { "lib/*": ["./a/../src/*"] } } }, "src/x.ts": "" })).toEqual([]);
  });

  test("a path-like jsxImportSource is checked as a path; a package name isn't", () => {
    expect(outsideFields({ "tsconfig.json": { compilerOptions: { jsxImportSource: "../outside/jsx" } } })).toEqual(["compilerOptions.jsxImportSource"]);
    expect(outsideFields({ "tsconfig.json": { compilerOptions: { jsxImportSource: "/abs/jsx" } } })).toEqual(["compilerOptions.jsxImportSource"]);
    const r = reach({ "tsconfig.json": { compilerOptions: { jsxImportSource: "./jsx" } }, "jsx/jsx-runtime.ts": "" });
    expect([r.outside, r.inside]).toEqual([[], ["jsx/jsx-runtime.ts"]]);
    expect(outsideFields({ "tsconfig.json": { compilerOptions: { jsxImportSource: "preact" } } })).toEqual([]);
  });

  test("main, module and a string browser resolve against the package, with or without a leading .", () => {
    expect(outsideFields({ "node_modules/dep/package.json": { main: "lib/../../../../outside/evil.ts", module: "../../../m.js", browser: "x/../../../../b.js" } })).toEqual(["main", "module", "browser"]);
    const r = reach({ "node_modules/dep/package.json": { main: "lib/index.js", browser: { "./a.js": "./b.js", fs: false, events: "events-shim" } } });
    expect([r.outside, r.inside]).toEqual([[], ["node_modules/dep/b.js", "node_modules/dep/lib/index.js"]]);
  });
});
