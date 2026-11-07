// The static outside-reach check `clover plugin validate` errors on (#234's review, F2 (c)): the cheap cases the
// runtime guard also stops.
import { describe, expect, test } from "bun:test";
import { loaderOutsideIssues, loaderReach } from "../loader-config";

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

  test("a bare imports target is a built-in or a dependency in the plugin's own node_modules (check 3)", () => {
    const tree = {
      "package.json": { imports: { "#a": "dep", "#b": "@s/x/sub", "#c": "node:fs", "#d": "fs/promises", "#e": "elsewhere", "#f": { node: "@s/missing", default: "./x.js" } } },
      "node_modules/dep/package.json": { name: "dep" }, "node_modules/@s/x/sub.js": "", "x.js": "",
    };
    expect(reach(tree).outside.map((o) => [o.field, o.target])).toEqual([["imports.#e", "elsewhere"], ["imports.#f.node", "@s/missing"]]);
    // A nested package finds the plugin's top-level node_modules, never one outside it.
    expect(outsideFields({ "pkg/package.json": { imports: { "#a": "dep" } }, "node_modules/dep/index.js": "" })).toEqual([]);
  });

  test("a dependency a script imports or a package.json declares ships in the plugin's own node_modules (check 4, H1)", () => {
    const missing = (tree: Record<string, unknown>) => reach(tree).missing.map((m) => [m.file, m.field, m.target]);
    const tree = {
      "package.json": { name: "me", dependencies: { dep: "1", absent: "1" }, optionalDependencies: { gone: "1" }, devDependencies: { tooling: "1" } },
      "tsconfig.json": { compilerOptions: { paths: { "lib/*": ["./src/*"] } } }, "src/x.ts": "",
      "node_modules/dep/package.json": { name: "dep", main: "index" }, "node_modules/dep/index": "",
      "node_modules/dep/lib.js": "try { require(\"bufferutil\"); } catch {}\nmodule.exports = require(\"./index\");\n",
      "host/index.ts": [
        "import type { T } from \"types-only\";", "import a from \"dep\";", "import b from \"dep/lib.js\";", "import { z } from \"zod\";",
        "import sdk from \"@waifucave/clover-plugin-sdk/args\";", "import fs from \"node:fs\";", "import p from \"path\";", "import { $ } from \"bun\";",
        "import x from \"lib/x\";", "import self from \"me/thing\";", "import \"./local\";", "const n = await import(\"nowhere\");", "export * from \"also-missing\";",
      ].join("\n"),
    };
    expect(missing(tree)).toEqual([
      ["node_modules/dep/lib.js", "import", "bufferutil"],
      ["host/index.ts", "import", "nowhere"], ["host/index.ts", "import", "also-missing"],
      ["package.json", "dependencies", "absent"], ["package.json", "optionalDependencies", "gone"],
    ]);
    // A path import climbing out of the plugin, an absolute one, or a URL reaches outside.
    expect(reach({ "host/a.ts": "import \"../../outside/noext\";\nimport \"/Users/me/node_modules/evil/index\";\nimport \"file:///x\";\nimport \"./fine\";\n" }).outside.map((o) => o.target))
      .toEqual(["../../outside/noext", "/Users/me/node_modules/evil/index", "file:///x"]);
    // The error names the module and the file that wants it, so the author can ship it.
    const issues = loaderOutsideIssues(reach(tree)).filter((i) => i.code === "dependency_missing").map((i) => [i.file, i.message]);
    expect(issues[0]).toEqual(["node_modules/dep/lib.js", expect.stringContaining("node_modules/dep/lib.js imports \"bufferutil\", which the plugin doesn't ship: add \"bufferutil\"")]);
    expect(issues.at(-1)).toEqual(["package.json", expect.stringContaining("package.json declares \"gone\" in optionalDependencies")]);
    // A script too big to read can't be checked.
    expect(loaderReach(["host/big.js"], () => undefined, () => undefined).missing).toEqual([{ file: "host/big.js", field: "size", target: "" }]);
  });
});
