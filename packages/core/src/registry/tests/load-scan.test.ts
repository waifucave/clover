// The build's load scan (`runtimeLoadProblems`, #337's review S1): a parse of the module, never a pattern over its
// text. Each hostile form the review listed is caught; the bundler's shims, literal requires of what ships, and prose
// that says "require" pass. It's a lint, not a boundary: the plugin-process fence (2f) is.
import { describe, expect, test } from "bun:test";
import { runtimeLoadProblems } from "../build";

const host = (src: string, builtins: string[] = []) => runtimeLoadProblems(src, "host/index.js", { client: false, allowed: (s) => s.startsWith("node:"), builtins });
const client = (src: string) => runtimeLoadProblems(src, "client/index.js", { client: true, allowed: () => false });

describe("the load scan", () => {
  test("catches each form the review listed, and the ones around them", () => {
    const forms: [string, string][] = [
      ["require after a division the old reading took for a regular expression", "var q = {} / 1 + require(name) / 1;"],
      ["process.mainModule.require", "process.mainModule.require(name);"],
      ["module.require of a literal", 'module.require("child_process");'],
      ["Bun.$ (host-only)", "await Bun.$`rm -rf ${dir}`;"],
      ["eval", "eval(code);"],
      ["indirect eval", "(0, eval)(code);"],
      ["new Function", 'new Function("return 1")();'],
      ["Function by its constructor", '(() => {}).constructor("return 1")();'],
      ["process.binding", 'process.binding("spawn_sync");'],
      ['globalThis["Bun"].spawn (host-only)', 'globalThis["Bun"].spawn(["sh"]);'],
      ["globalThis.Bun.spawnSync (host-only)", "globalThis.Bun.spawnSync(['sh']);"],
      ['Bun["spawn"] (host-only)', 'Bun["spawn"](["sh"]);'],
      ["a template key (host-only)", "Bun[`spawn`](['sh']);"],
      ["Bun destructured (host-only)", "const { spawn } = Bun; spawn(['sh']);"],
      ["Bun from globalThis destructured (host-only)", "const { Bun: B } = globalThis; B.spawn(['sh']);"],
      ["mainModule destructured", "const { mainModule } = process; mainModule.require('x');"],
      ["binding destructured from process", "const { binding: b } = process; b('fs');"],
      ["process.binding by a computed key", 'globalThis.process["binding"]("fs");'],
      ["process from globalThis destructured", "const { process: p } = globalThis; p.binding('fs');"],
      ["Bun passed on (host-only)", "const b = Bun; b.spawn(['sh']);"],
      ["globalThis.Bun passed on (host-only)", "const b = globalThis.Bun; b.spawn(['sh']);"],
      ["computed require", "require(name);"],
      ["require aliased", "const r = require; r('x');"],
      ["__require of a computed name", "__require(name);"],
      ["computed import()", "import(name);"],
      ["import.meta.require computed", "import.meta.require(name);"],
      ["import.meta.resolve", 'import.meta.resolve("x");'],
      ["import.meta passed on", "const m = import.meta; m.require('x');"],
      ["process.dlopen", 'process.dlopen({}, "x.node");'],
      ["dlopen through computed members", 'globalThis["process"]["dlopen"]({}, "x.node");'],
      ["getBuiltinModule", 'process.getBuiltinModule("module");'],
      ["Module._load", 'Module._load("x");'],
      ["createRequire", "createRequire(import.meta.url)('x');"],
      ["a Worker (host-only)", 'new Worker("./w.js");'],
      ["a literal require of what doesn't ship", 'require("left-pad");'],
      ["a code-loading built-in not named", 'require("node:child_process");'],
      ["a code-loading built-in imported", 'import { fork } from "node:child_process"; fork("x");'],
      ["a module that doesn't parse", "var = ;"],
    ];
    for (const [what, src] of forms) expect([what, host(src).length > 0]).toEqual([what, true]);
    expect(host("var q = {} / 1 + require(name) / 1;").join("\n")).toContain("module loader outside a literal require");
    expect(host("await Bun.$`ls`;").join("\n")).toContain("Bun's spawn");
  });

  test("a client gets the loads that reach code, not Bun's or Worker's names", () => {
    expect(client("import(url);").join("\n")).toContain("import() of a computed specifier");
    expect(client('require("node:path");').join("\n")).toContain("a client module never does");
    expect(client("eval(x);").length).toBe(1);
    expect(client("new Worker('w.js'); const b = window.Bun;")).toEqual([]);
  });

  test("passes the bundler's shims, literal requires of what ships, named built-ins, and prose", () => {
    expect(host('var __require = import.meta.require;\nconst p = __require("node:path");\nexport const x = import.meta.url + import.meta.dir;')).toEqual([]);
    expect(host('import { createRequire } from "node:module";\nvar __require = /* @__PURE__ */ createRequire(import.meta.url);\nconst p = __require("node:path");')).toEqual([]);
    expect(host('import { execFileSync } from "node:child_process";\nexport const f = execFileSync;', ["child_process"])).toEqual([]);
    expect(host('// we require nothing; a Worker and Bun.spawn are not used\nexport const note = "you may require(x) a Worker or eval";\nconst re = /require\\(x\\)/;\nexport const t = `Bun.spawn ${re}`;')).toEqual([]);
    expect(host("const o = { require: 1, eval: 2, spawn: 3 }; export const s = Bun.file('x'); export const v = Bun.version;")).toEqual([]);
    // A library's own names: a binding or mainModule that isn't process's, a build or spawn that isn't Bun's.
    expect(host("const binding = this._bindings[0]; binding.mainModule = 1; const { build, spawn, resolve } = options; build(); spawn(); resolve();")).toEqual([]);
    expect(host("process.globalBinding = 1; export const { version } = process;")).toEqual([]);
    // createRequire's shim only with its import; without it, a createRequire is a reference.
    expect(host("var __require = createRequire(import.meta.url);").length).toBeGreaterThan(0);
  });
});
