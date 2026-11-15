// The static outside-reach check `clover plugin validate` errors on (#234's review, F2 (c)): the cheap cases the
// runtime guard also stops.
import { describe, expect, test } from "bun:test";
import { CLIENT_BARE_IMPORTS } from "@waifucave/clover-plugin-sdk";
import { loaderOutsideIssues, loaderReach, pluginEntries } from "../loader-config";

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

  test("the reviewer's plugins A, B and E are refused statically, and D is fine (#234's check 6, L4)", () => {
    const missing = (tree: Record<string, unknown>) => reach(tree).missing.map((m) => [m.file, m.target]);
    // A: a `paths` alias whose target doesn't exist stands in for nothing: Bun goes looking for the bare name above.
    expect(missing({ "tsconfig.json": { compilerOptions: { paths: { ghost: ["./missing/ghost"] } } }, "host/index.ts": "import \"ghost\";\n" }))
      .toEqual([["host/index.ts", "ghost"]]);
    expect(missing({ "tsconfig.json": { compilerOptions: { paths: { ghost: ["./lib/ghost"] } } }, "lib/ghost.ts": "", "host/index.ts": "import \"ghost\";\n" })).toEqual([]);
    // B: a package's `main` names a file without an extension; its imports are read all the same.
    expect(missing({ "node_modules/dep/package.json": { name: "dep", main: "lib/index" }, "node_modules/dep/lib/index": "module.exports = require(\"ghost\");\n" }))
      .toEqual([["node_modules/dep/lib/index", "ghost"]]);
    // E: an `exports` condition Bun picks (`bun`) names a file of any extension; read too.
    expect(missing({
      "node_modules/dep/package.json": { name: "dep", exports: { ".": { bun: "./entry.bun", default: "./index.js" } } },
      "node_modules/dep/entry.bun": "export * from \"ghost\";\n", "node_modules/dep/index.js": "",
    })).toEqual([["node_modules/dep/entry.bun", "ghost"]]);
    // D: a plugin that ships what it imports.
    expect(missing({ "node_modules/dep/package.json": { name: "dep", main: "index.js" }, "node_modules/dep/index.js": "", "host/index.ts": "import \"dep\";\n" })).toEqual([]);
  });
});

describe("what a client may import without shipping it (the layer's import map)", () => {
  const withEntries = (tree: Record<string, unknown>) => {
    const text = Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
    const files = Object.keys(text);
    return loaderReach(files, (p) => text[p], (p) => text[p], pluginEntries(files, (p) => text[p]));
  };
  // A JSX file's refusal names the JSX transform's runtime too.
  const jsxRefused = (file: string) => [`${file}: react`, `${file}: react/jsx-dev-runtime`];
  const missingOf = (tree: Record<string, unknown>) => withEntries(tree).missing.map((m) => `${m.file}: ${m.target}`);
  const manifest = (o: Record<string, unknown> = {}) => ({ manifest: 1, id: "tarot", name: "Tarot", client: { entry: "client/index.tsx" }, ...o });
  const jsx = 'import { useState } from "react";\nimport { usePluginApi } from "@waifucave/clover-plugin-sdk/ui";\nexport const Tarot = () => { const [x] = useState(0); return <p>{x}</p>; };\n';

  test("a file only a client reaches imports React, its JSX runtime and the UI SDK without shipping them", () => {
    expect(missingOf({ "clover.json": manifest(), "client/index.tsx": jsx })).toEqual([]);
    // Through the client's own files too.
    expect(missingOf({ "clover.json": manifest(), "client/index.tsx": 'import { Card } from "./card";\nexport const T = Card;\n', "client/card.tsx": jsx })).toEqual([]);
    // Every name the import map serves.
    const all = CLIENT_BARE_IMPORTS.map((n, i) => `import * as m${i} from "${n}";`).join("\n");
    expect(missingOf({ "clover.json": manifest(), "client/index.tsx": all })).toEqual([]);
  });

  test("a client file importing a name the map doesn't serve is refused, naming the file and the import (no prefix wildcard)", () => {
    expect(missingOf({ "clover.json": manifest(), "client/index.tsx": 'import { renderToString } from "react-dom/server";\nimport _ from "lodash";\n' })).toEqual(["client/index.tsx: react-dom/server", "client/index.tsx: lodash"]);
    const r = withEntries({ "clover.json": manifest(), "client/index.tsx": 'import _ from "lodash";\n' });
    expect(loaderOutsideIssues(r).map((i) => i.message)).toEqual(['client/index.tsx imports "lodash", which the plugin doesn\'t ship: add "lodash" to the plugin\'s own node_modules (an optional import in a try/catch counts too, since Bun would look for it in the folders above the plugin)']);
  });

  test("a file a host, a server, a hook or a command also reaches keeps the full check, as does one no entry reaches", () => {
    const shared = 'import { useState } from "react";\nexport const s = useState;\n';
    // Shared by the client and the host.
    expect(missingOf({ "clover.json": manifest({ host: { entry: "host/index.ts" } }), "client/index.tsx": 'import { s } from "../shared/s";\nexport const T = s;\n', "host/index.ts": 'import { s } from "../shared/s";\nexport const x = s;\n', "shared/s.ts": shared })).toEqual(["shared/s.ts: react"]);
    // A host file itself.
    expect(missingOf({ "clover.json": manifest({ host: { entry: "host/index.ts" } }), "client/index.tsx": jsx, "host/index.ts": 'import React from "react";\nexport const x = React;\n' })).toEqual(["host/index.ts: react"]);
    // A stdio server's script named in its args (with ${plugin}/), and a command's.
    expect(missingOf({ "clover.json": manifest({ contributes: { mcpServers: { s: { type: "stdio", command: "bun", args: ["${plugin}/client/index.tsx"] } } } }), "client/index.tsx": jsx })).toEqual(jsxRefused("client/index.tsx"));
    expect(missingOf({ "clover.json": manifest({ contributes: { hooks: [{ id: "h", on: ["turn.start"], command: "bun client/index.tsx" }] } }), "client/index.tsx": jsx })).toEqual(jsxRefused("client/index.tsx"));
    // No entry reaches it.
    expect(missingOf({ "clover.json": manifest(), "client/index.tsx": jsx, "client/stray.tsx": jsx })).toEqual(jsxRefused("client/stray.tsx"));
    // No client at all: a host's React stays refused.
    expect(missingOf({ "clover.json": { manifest: 1, id: "tarot", name: "Tarot", host: { entry: "host/index.ts" } }, "host/index.ts": jsx.replace("<p>{x}</p>", "null") })).toEqual(["host/index.ts: react"]);
  });

  test("a script named after an `=` (`--entry=…`) counts, and so does one the scan can't read as code; a picture doesn't", () => {
    expect(missingOf({ "clover.json": manifest({ contributes: { mcpServers: { s: { type: "stdio", command: "bun", args: ["--entry=${plugin}/client/index.tsx"] } } } }), "client/index.tsx": jsx })).toEqual(jsxRefused("client/index.tsx"));
    expect(missingOf({ "clover.json": manifest({ contributes: { hooks: [{ id: "h", on: ["turn.start"], command: "bun --require=./client/index.tsx x" }] } }), "client/index.tsx": jsx })).toEqual(jsxRefused("client/index.tsx"));
    // A shell script, or a file with no extension: what it runs isn't followed, so no file is the client's only.
    expect(missingOf({ "clover.json": manifest({ contributes: { hooks: [{ id: "h", on: ["turn.start"], command: "sh bin/run" }] } }), "client/index.tsx": jsx, "bin/run": "bun client/index.tsx\n" })).toEqual(jsxRefused("client/index.tsx"));
    expect(missingOf({ "clover.json": manifest({ contributes: { hooks: [{ id: "h", on: ["turn.start"], command: "bin/go.sh" }] } }), "client/index.tsx": jsx, "bin/go.sh": "#!/bin/sh\n" })).toEqual(jsxRefused("client/index.tsx"));
    // A file the manifest names that no program runs (its icon) changes nothing.
    expect(missingOf({ "clover.json": manifest({ icon: "assets/icon.svg" }), "client/index.tsx": jsx, "assets/icon.svg": "<svg/>" })).toEqual([]);
  });

  test("when the other entries' reach can't be followed (an alias, a #import), no file is the client's only", () => {
    const tree = {
      "clover.json": manifest({ host: { entry: "host/index.ts" } }),
      "client/index.tsx": jsx,
      "host/index.ts": 'import x from "#lib";\nexport default x;\n',
      "package.json": { name: "tarot", imports: { "#lib": "./client/index.tsx" } },
    };
    expect(missingOf(tree)).toEqual(jsxRefused("client/index.tsx"));
  });

  test("a child plugin's client counts as a client; the entries come from every manifest in the tree", () => {
    const tree = { "clover.json": { manifest: 1, id: "pack", name: "Pack" }, "plugins/eyes/clover.json": { manifest: 1, name: "Eyes", client: { entry: "client/index.tsx" } }, "plugins/eyes/client/index.tsx": jsx };
    expect(missingOf(tree)).toEqual([]);
    expect(pluginEntries(Object.keys(tree), (p) => JSON.stringify((tree as Record<string, unknown>)[p]))).toEqual({ client: ["plugins/eyes/client/index.tsx"], other: [] });
  });

  test("with no entries known, nothing is exempt", () => {
    expect(reach({ "client/index.tsx": jsx }).missing.map((m) => m.target)).toEqual(["react", "react/jsx-dev-runtime"]);
  });
});
