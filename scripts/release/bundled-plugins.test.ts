// The bundled plugins' staging and checks (scripts/release/bundled-plugins.ts): only tracked files ship, no symlink,
// nothing a release leaves out; a plugin's runtime dependencies must ship with it; and the exact import check on a
// built tree.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtPluginImportProblems, bundledPluginsProblems, LAYER_PROVIDED_PACKAGES, leftOut, scanModule, stageBundledPlugins, unshippedPluginDependencies, walkTree, type PluginsSource } from "./bundled-plugins";

const ROOT = join(import.meta.dir, "..", "..");

/** A throwaway git repository with `files` committed under plugins/. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lane-m-stage-repo-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  git("init", "-q");
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), body); }
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "plugins");
  return dir;
}

describe("staging: only committed files", () => {
  const committed = { "plugins/clover/clover.json": `{"id":"clover"}`, "plugins/clover/host.js": "export {};\n", "plugins/alpha/clover.json": `{"id":"alpha"}`, "plugins/alpha/tab/test/tab.test.ts": "x", "plugins/alpha/tab/tsconfig.json": "{}" };

  test("writes HEAD's blobs under plugins/, less what a release leaves out", () => {
    const dir = repo(committed);
    const dest = join(dir, "out", "plugins");
    expect(stageBundledPlugins(dir, dest).sort()).toEqual(["alpha/clover.json", "clover/clover.json", "clover/host.js"]);
    expect(readFileSync(join(dest, "clover", "clover.json"), "utf8")).toBe(`{"id":"clover"}`);
    expect(existsSync(join(dest, "alpha", "tab", "tsconfig.json"))).toBe(false);
  });

  test("a committed file swapped locally for a symlink to an outside file never ships: the build is refused", () => {
    const dir = repo(committed);
    const secret = join(dir, "..", `${dir.split("/").pop()}-secret.txt`);
    writeFileSync(secret, "TOP SECRET");
    rmSync(join(dir, "plugins", "clover", "host.js"));
    symlinkSync(secret, join(dir, "plugins", "clover", "host.js"));
    const dest = join(dir, "out", "plugins");
    expect(() => stageBundledPlugins(dir, dest)).toThrow("uncommitted changes");
    expect(existsSync(dest)).toBe(false);
  });

  test("a locally edited clover.json, or an untracked file, never ships: the build is refused", () => {
    const edited = repo(committed);
    writeFileSync(join(edited, "plugins", "clover", "clover.json"), `{"id":"clover","evil":true}`);
    expect(() => stageBundledPlugins(edited, join(edited, "out", "plugins"))).toThrow("uncommitted changes");
    const untracked = repo(committed);
    writeFileSync(join(untracked, "plugins", "alpha", ".env"), "KEY=x");
    expect(() => stageBundledPlugins(untracked, join(untracked, "out", "plugins"))).toThrow("uncommitted changes");
  });

  test("a committed symlink, submodule or odd mode is refused, and a failed stage leaves nothing", () => {
    const entry = (mode: string, path: string) => `${mode} blob 0123456789abcdef0123456789abcdef01234567\t${path}`;
    const source = (tree: string, blobs: () => Map<string, Uint8Array> = () => new Map()): PluginsSource => ({ tree: () => tree, status: () => "", blobs });
    const dest = join(mkdtempSync(join(tmpdir(), "lane-m-stage-")), "plugins");
    expect(() => stageBundledPlugins("/nowhere", dest, source(entry("120000", "plugins/alpha/link") + "\0"))).toThrow("is a symlink");
    expect(() => stageBundledPlugins("/nowhere", dest, source(entry("160000", "plugins/alpha/sub") + "\0"))).toThrow("is a submodule");
    expect(() => stageBundledPlugins("/nowhere", dest, source(entry("040000", "plugins/alpha/x") + "\0"))).toThrow("regular files only");
    expect(() => stageBundledPlugins("/nowhere", dest, source(entry("100644", "plugins/alpha/x.js") + "\0", () => { throw new Error("cat-file died"); }))).toThrow("cat-file died");
    expect(existsSync(dest)).toBe(false);
  });

  test("the real tree stages: both top-level manifests, nothing left out, and the packaged check passes", () => {
    const dest = join(mkdtempSync(join(tmpdir(), "lane-m-stage-real-")), "plugins");
    const staged = stageBundledPlugins(ROOT, dest);
    expect(staged).toContain("clover/clover.json");
    expect(staged).toContain("alpha/clover.json");
    expect(staged.filter((f) => leftOut(f) !== undefined)).toEqual([]);
    expect(bundledPluginsProblems(join(dest, ".."), existsSync, walkTree)).toEqual([]);
  });
});

describe("the packaged app's bundled plugins", () => {
  test("each manifest there; nothing left out; no symlink, never followed (a cycle ends)", () => {
    const res = mkdtempSync(join(tmpdir(), "lane-m-res-"));
    const dir = join(res, "plugins");
    for (const f of ["clover/clover.json", "alpha/clover.json", "alpha/tab/theme.css"]) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), "{}"); }
    expect(bundledPluginsProblems(res, existsSync, walkTree)).toEqual([]);
    // A symlink loop: walked with lstat, reported, never followed.
    symlinkSync(dir, join(dir, "alpha", "loop"));
    symlinkSync("/etc", join(dir, "clover", "outside"));
    const problems = bundledPluginsProblems(res, existsSync, walkTree);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("holds symlinks");
    expect(problems[0]).toContain("alpha/loop");
    expect(problems[0]).toContain("clover/outside");
  });

  test("a missing manifest, and each kind of file a release leaves out, is a problem", () => {
    const ok = [{ rel: "clover/clover.json", link: false }, { rel: "alpha/clover.json", link: false }];
    const files = new Set(["/r/plugins/clover/clover.json", "/r/plugins/alpha/clover.json"]);
    expect(bundledPluginsProblems("/r", (p) => p !== "/r/plugins/alpha/clover.json", () => ok)).toEqual(["/r/plugins/alpha/clover.json is missing: the alpha plugin isn't bundled"]);
    for (const stray of ["alpha/tab/test/x.ts", "clover/x/tests/a.ts", "clover/node_modules/x/index.js", "alpha/tsconfig.json", "clover/a.test.tsx", "alpha/.env", "alpha/.env.local", "clover/.DS_Store"]) {
      expect(bundledPluginsProblems("/r", (p) => files.has(p), () => [...ok, { rel: stray, link: false }])[0]).toContain(stray);
    }
  });
});

describe("a bundled plugin's runtime dependencies", () => {
  test("must ship with it (in its node_modules or one above it in the tree); React and React DOM come from the layer, the SDK doesn't", () => {
    expect([...LAYER_PROVIDED_PACKAGES].sort()).toEqual(["react", "react-dom"]);
    const pkgs: Record<string, string> = {
      "clover/plugins/ui/package.json": JSON.stringify({ dependencies: { react: "19.3.1", "lucide-react": "1.61.0", "@waifucave/clover-plugin-sdk": "workspace:*" }, peerDependencies: { "react-dom": "^19" }, devDependencies: { typescript: "5" } }),
      "clover/plugins/host/package.json": JSON.stringify({ dependencies: { "@waifucave/clover-provider-runtime": "0.0.71" }, optionalDependencies: { fflate: "0.8.3" }, peerDependencies: { three: "*" } }),
      "clover/plugins/host/node_modules/fflate/package.json": "{}",
      // Above it in the tree: found by Node's lookup.
      "clover/node_modules/three/package.json": "{}",
      "clover/plugins/none/package.json": JSON.stringify({ devDependencies: { typescript: "5" } }),
    };
    expect(unshippedPluginDependencies(Object.keys(pkgs), (rel) => pkgs[rel]!)).toEqual([
      "clover/plugins/host: @waifucave/clover-provider-runtime",
      "clover/plugins/ui: @waifucave/clover-plugin-sdk", "clover/plugins/ui: lucide-react",
    ]);
  });
});

describe("the exact import check on a built tree", () => {
  const tree = ["ui/entry.js", "ui/chunk.js", "host/index.js", "host/node_modules/@waifucave/clover-provider-runtime/package.json", "host/node_modules/ws/package.json", "host/natives/node_datachannel.node", "other/lib.js"];

  test("Bun's transpiler reads the imports, plus a bundle's __require and import.meta.require; computed ones are counted", () => {
    expect(scanModule(`import a from "react"; export { b } from './x.js'; import "./side.js"; const c = await import("lucide-react"); require("node:fs");`).specifiers)
      .toEqual(["./side.js", "./x.js", "lucide-react", "node:fs", "react"]);
    // `bun build --target bun`'s own spelling for an external.
    expect(scanModule(`var __require = import.meta.require; var ws = __require("ws"); var fs = __require("fs");`).specifiers).toEqual(["fs", "ws"]);
    expect(scanModule(`const x = import.meta.require("y");`).specifiers).toEqual(["y"]);
    expect(scanModule(`await import(name); require(path); __require(p); import.meta.require(q); require("a" + b);`).computed).toBe(5);
    expect(scanModule(`import("ok"); require("ok2"); foo.require(bar); my_require(x);`).computed).toBe(0);
    // createRequire's function and native loading can't be verified either.
    expect(scanModule(`import { createRequire } from "node:module"; const r = createRequire(import.meta.url); r("x");`).computed).toBe(1);
    expect(scanModule(`createRequire(import.meta.url)("x");`).computed).toBe(1);
    expect(scanModule(`process.dlopen(module, "/tmp/x.node");`).computed).toBe(1);
  });

  test("a correct tree passes: client bare imports within the layer's, host ones builtin or shipped (at or above), natives for the target", () => {
    const ok = [
      { file: "ui/entry.js", kind: "client" as const, source: `import { jsx } from "react/jsx-runtime"; import { useUi } from "@waifucave/clover-plugin-sdk/ui"; import "./chunk.js";` },
      { file: "host/index.js", kind: "host" as const, source: `import { run } from "@waifucave/clover-provider-runtime"; import fs from "node:fs"; import path from "path"; import { $ } from "bun"; var __require = import.meta.require; __require("ws"); __require("node-datachannel");` },
    ];
    expect(builtPluginImportProblems(ok, tree, { target: "linux-x64", natives: [{ file: "host/natives/node_datachannel.node", package: "node-datachannel", target: "linux-x64" }] })).toEqual([]);
  });

  test("everything else is refused", () => {
    const one = (kind: "client" | "host", source: string, o = {}) => builtPluginImportProblems([{ file: kind === "client" ? "ui/entry.js" : "host/index.js", kind, source }], tree, o);
    expect(one("client", `import { X } from "lucide-react";`)[0]).toContain("a client module imports lucide-react");
    expect(one("client", `import "@waifucave/clover-plugin-sdk";`)[0]).toContain("a client module imports @waifucave/clover-plugin-sdk");
    expect(one("host", `var __require = import.meta.require; __require("left-pad");`)).toEqual(["host/index.js: host code imports left-pad, which nothing in the shipped tree provides"]);
    expect(one("host", `const m = await import(name);`)[0]).toContain("computed specifier");
    for (const spec of ["/etc/passwd", "file:///etc/passwd", "data:text/javascript,x", "https://example.com/x.js", "http://example.com/x.js"]) {
      expect(one("host", `import x from "${spec}";`)[0]).toContain("an absolute path or URL");
    }
    expect(one("client", `import "./missing.js";`)).toEqual(["ui/entry.js: imports ./missing.js, which isn't in its own plugin's shipped files"]);
    expect(one("client", `import "../../outside.js";`)).toEqual(["ui/entry.js: imports ../../outside.js, which isn't in its own plugin's shipped files"]);
    // Another top-level plugin's file, though shipped, is out of reach.
    expect(one("client", `import "../other/lib.js";`)).toEqual(["ui/entry.js: imports ../other/lib.js, which isn't in its own plugin's shipped files"]);
    // A native for another target, or one the build reported but didn't ship.
    expect(one("host", `__require("node-datachannel");`.replace("__require", "import.meta.require"), { target: "linux-arm64", natives: [{ file: "host/natives/node_datachannel.node", package: "node-datachannel", target: "linux-x64" }] }))
      .toEqual(["host/natives/node_datachannel.node: a native addon for linux-x64, not linux-arm64", "host/index.js: host code imports node-datachannel, which nothing in the shipped tree provides"]);
    expect(builtPluginImportProblems([], tree, { natives: [{ file: "host/natives/gone.node", package: "x", target: "linux-x64" }] })).toEqual(["host/natives/gone.node: a native addon the build reported isn't in the shipped tree"]);
  });
});
