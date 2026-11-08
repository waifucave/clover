// The bundled plugins' staging and checks (scripts/release/bundled-plugins.ts): only tracked files ship, no symlink,
// nothing a release leaves out; a plugin's runtime dependencies must ship with it; and the exact import check on a
// built tree.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundledPlugins, builtPluginImportProblems, bundledPluginsProblems, lockedPackageFiles, lockedPackages, lockEntries, tarballUrl, type PluginBuilder, LAYER_PROVIDED_PACKAGES, leftOut, manifestDifferences, repoInputVetter, scanModule, stageBundledPlugins, unshippedPluginDependencies, walkTree, writeStagedManifest, type PluginsSource } from "./bundled-plugins";
import { buildPluginModule } from "../../packages/core/src/registry/build";
import { buildPluginForShipping, hostShipTarget } from "../../packages/core/src/registry/ship";
import { measureBundledTree, parseBundledManifest, type BundledManifest } from "../../packages/core/src/bundled-plugins-dir";

const ROOT = join(import.meta.dir, "..", "..");

/** A throwaway git repository with `files` committed under plugins/. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lane-m-stage-repo-"));
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  git("init", "-q");
  // A release checkout has its lockfile (the inputs check reads it).
  if (files["bun.lock"] === undefined) files = { ...files, "bun.lock": '{\n  "lockfileVersion": 1,\n  "packages": {},\n}\n' };
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), body); }
  for (const f of Object.keys(files).filter((f) => f.endsWith(".sh"))) chmodSync(join(dir, f), 0o755);
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

  test.skipIf(process.platform === "win32")("a 100755 file stays executable (0755), a 100644 one doesn't (0644)", () => {
    const dir = repo({ ...committed, "plugins/clover/bin/run.sh": "#!/bin/sh\n" });
    const dest = join(dir, "out", "plugins");
    stageBundledPlugins(dir, dest);
    expect(statSync(join(dest, "clover", "bin", "run.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(dest, "clover", "host.js")).mode & 0o777).toBe(0o644);
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
    // The manifest built from HEAD's stage is the one the core embeds, and the packaged check holds the tree to it.
    const file = join(dest, "..", "clover-bundled-plugins.manifest");
    const manifest = writeStagedManifest(dest, file);
    expect(parseBundledManifest(readFileSync(file, "utf8"))).toEqual(manifest);
    expect(Object.keys(manifest.files).sort()).toEqual([...staged].sort());
    expect(bundledPluginsProblems(join(dest, ".."), manifest, existsSync, walkTree)).toEqual([]);
  });
});

describe("what ships is exactly the manifest's tree", () => {
  const build = () => {
    const res = mkdtempSync(join(tmpdir(), "lane-m-res-manifest-"));
    for (const f of ["clover/clover.json", "alpha/clover.json", "alpha/host.js"]) { mkdirSync(join(res, "plugins", f, ".."), { recursive: true }); writeFileSync(join(res, "plugins", f), `${f}\n`); }
    return { res, manifest: measureBundledTree(join(res, "plugins")) };
  };

  test("a swapped file, a size change, an extra file and a missing one are each a problem", () => {
    const swapped = build();
    writeFileSync(join(swapped.res, "plugins", "alpha", "host.js"), "alpha/host.jZ\n");
    expect(bundledPluginsProblems(swapped.res, swapped.manifest, existsSync, walkTree)[0]).toContain("alpha/host.js isn't the bytes");
    const grown = build();
    writeFileSync(join(grown.res, "plugins", "alpha", "host.js"), "alpha/host.js\n// more\n");
    expect(bundledPluginsProblems(grown.res, grown.manifest, existsSync, walkTree)[0]).toContain("alpha/host.js isn't the bytes");
    const extra = build();
    writeFileSync(join(extra.res, "plugins", "alpha", "extra.js"), "x");
    expect(bundledPluginsProblems(extra.res, extra.manifest, existsSync, walkTree)[0]).toContain("alpha/extra.js isn't in the core's manifest");
    const missing = build();
    rmSync(join(missing.res, "plugins", "alpha", "host.js"));
    expect(bundledPluginsProblems(missing.res, missing.manifest, existsSync, walkTree)[0]).toContain("alpha/host.js is missing");
  });

  test("manifestDifferences compares path, hash and size", () => {
    const a: BundledManifest = { files: { "x/a": { sha256: "0".repeat(64), size: 1 }, "x/b": { sha256: "1".repeat(64), size: 2 } } };
    expect(manifestDifferences(a, a)).toEqual([]);
    expect(manifestDifferences(a, { files: { "x/a": { sha256: "0".repeat(64), size: 3 }, "x/c": { sha256: "2".repeat(64), size: 1 } } }))
      .toEqual(["x/a isn't the bytes the core's manifest names", "x/b is missing", "x/c isn't in the core's manifest"]);
  });
});

describe("the packaged app's bundled plugins", () => {
  test("each manifest there; nothing left out; no symlink, never followed (a cycle ends)", () => {
    const res = mkdtempSync(join(tmpdir(), "lane-m-res-"));
    const dir = join(res, "plugins");
    for (const f of ["clover/clover.json", "alpha/clover.json", "alpha/tab/theme.css"]) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), "{}"); }
    const manifest = measureBundledTree(dir);
    expect(bundledPluginsProblems(res, manifest, existsSync, walkTree)).toEqual([]);
    // A symlink loop: walked with lstat, reported, never followed.
    symlinkSync(dir, join(dir, "alpha", "loop"));
    symlinkSync("/etc", join(dir, "clover", "outside"));
    const problems = bundledPluginsProblems(res, manifest, existsSync, walkTree);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("holds symlinks");
    expect(problems[0]).toContain("alpha/loop");
    expect(problems[0]).toContain("clover/outside");
  });

  test("a missing manifest, and an environment file or OS artifact anywhere (a built tree's node_modules is fine), is a problem", () => {
    const ok = [{ rel: "clover/clover.json", link: false }, { rel: "alpha/clover.json", link: false }];
    const files = new Set(["/r/plugins/clover/clover.json", "/r/plugins/alpha/clover.json"]);
    const manifest: BundledManifest = { files: {} };
    const measure = (): BundledManifest => manifest;
    expect(bundledPluginsProblems("/r", manifest, (p) => p !== "/r/plugins/alpha/clover.json", () => ok, measure)).toEqual(["/r/plugins/alpha/clover.json is missing: the alpha plugin isn't bundled"]);
    expect(bundledPluginsProblems("/r", manifest, (p) => files.has(p), () => [...ok, { rel: "clover/node_modules/node-datachannel/build/Release/node_datachannel.node", link: false }], measure)).toEqual([]);
    for (const stray of ["alpha/.env", "alpha/.env.local", "clover/.DS_Store", "clover/node_modules/x/.env"]) {
      expect(bundledPluginsProblems("/r", manifest, (p) => files.has(p), () => [...ok, { rel: stray, link: false }], measure)[0]).toContain(stray);
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

describe("the bundled plugins, built for shipping (lane B's buildPluginForShipping)", () => {
  /** A stand-in builder: copies the files `include` lets through, reporting them, a host module per `.js`, and a
   *  native for `natives`. */
  const fakeBuild = (calls: Array<{ folder: string; target: string; out: string; seen: string[] }>, natives: Record<string, string> = {}): PluginBuilder =>
    async (folder, o) => {
      const seen: string[] = [];
      const walk = (rel: string): void => {
        for (const n of require("node:fs").readdirSync(join(folder, rel))) {
          const r = rel === "" ? n : `${rel}/${n}`;
          if (require("node:fs").statSync(join(folder, r)).isDirectory()) walk(r);
          else if (o.include(r)) seen.push(r);
        }
      };
      walk("");
      calls.push({ folder, target: o.target, out: o.out, seen: [...seen].sort() });
      for (const f of seen) { mkdirSync(join(o.out, f, ".."), { recursive: true }); writeFileSync(join(o.out, f), readFileSync(join(folder, f))); }
      const files = [...seen];
      const extra = natives[folder.split("/").at(-1)!];
      if (extra !== undefined) { mkdirSync(join(o.out, extra, ".."), { recursive: true }); writeFileSync(join(o.out, extra), "native"); files.push(extra); }
      return {
        dir: o.out, files: files.sort(),
        modules: seen.filter((f) => f.endsWith(".js")).map((f) => ({ file: f, kind: "host" as const, source: readFileSync(join(folder, f), "utf8"), inputs: [join(folder, f)] })),
        natives: extra === undefined ? [] : [{ file: extra, package: "node-datachannel", target: o.target }],
      };
    };

  test("each top-level plugin is built from its committed files only, for the target, and the paths come back as <id>/…", async () => {
    const dir = repo({ "plugins/clover/clover.json": "{}", "plugins/clover/host.js": "import x from \"node-datachannel\";\nexport default x;\n", "plugins/alpha/clover.json": "{}", "plugins/alpha/tab/tsconfig.json": "{}" });
    writeFileSync(join(dir, ".gitignore"), "");
    const calls: Array<{ folder: string; target: string; out: string; seen: string[] }> = [];
    const dest = join(dir, "out", "plugins");
    const built = await buildBundledPlugins(dir, dest, "linux-x64", { build: fakeBuild(calls, { clover: "node_modules/node-datachannel/package.json" }) });
    expect(calls.map((c) => [c.folder.split("/").slice(-2).join("/"), c.target, c.out === join(dest, c.folder.split("/").at(-1)!)])).toEqual([["plugins/alpha", "linux-x64", true], ["plugins/clover", "linux-x64", true]]);
    // The staging filter applies to the source: the committed tsconfig is never handed to the build.
    expect(calls[0]!.seen).toEqual(["clover.json"]);
    expect(built.files).toEqual(["alpha/clover.json", "clover/clover.json", "clover/host.js", "clover/node_modules/node-datachannel/package.json"]);
    expect(built.modules.map((m) => m.file)).toEqual(["clover/host.js"]);
    expect(built.natives).toEqual([{ file: "clover/node_modules/node-datachannel/package.json", package: "node-datachannel", target: "linux-x64" }]);
  });

  test("an uncommitted file is never handed to the build: a dirty plugins/ is refused before any build", async () => {
    const dir = repo({ "plugins/clover/clover.json": "{}" });
    writeFileSync(join(dir, "plugins", "clover", "extra.js"), "untracked");
    const calls: Array<{ folder: string; target: string; out: string; seen: string[] }> = [];
    await expect(buildBundledPlugins(dir, join(dir, "out", "plugins"), "darwin-arm64", { build: fakeBuild(calls) })).rejects.toThrow("uncommitted changes");
    expect(calls).toEqual([]);
  });

  test("the release's checks run on the built tree: an import nothing ships fails the build, and the stage is removed", async () => {
    const dir = repo({ "plugins/clover/clover.json": "{}", "plugins/clover/host.js": "import x from \"left-pad\";\nexport default x;\n" });
    const dest = join(dir, "out", "plugins");
    await expect(buildBundledPlugins(dir, dest, "darwin-arm64", { build: fakeBuild([]) })).rejects.toThrow("host code imports left-pad, which nothing in the shipped tree provides");
    expect(existsSync(dest)).toBe(false);
    // A native shipped for another target than the one built for is refused too.
    const other: PluginBuilder = async (folder, o) => ({ ...(await fakeBuild([], { clover: "node_modules/n/x.node" })(folder, o)), natives: [{ file: "node_modules/n/x.node", package: "n", target: "windows-x64" }] });
    const dir2 = repo({ "plugins/clover/clover.json": "{}" });
    await expect(buildBundledPlugins(dir2, join(dir2, "out", "plugins"), "darwin-arm64", { build: other })).rejects.toThrow("a native addon for windows-x64, not darwin-arm64");
  });

  test("a package.json naming a dependency nothing ships fails the build", async () => {
    const dir = repo({ "plugins/clover/clover.json": "{}", "plugins/clover/package.json": "{\"dependencies\":{\"left-pad\":\"1\"}}" });
    await expect(buildBundledPlugins(dir, join(dir, "out", "plugins"), "darwin-arm64", { build: fakeBuild([]) })).rejects.toThrow("clover: left-pad: a dependency nothing ships");
  });
});

describe("what the bundler read: every input tracked at HEAD or in a package bun.lock holds, byte for byte (#244 check 4, #285)", () => {
  /** A minimal npm tarball: ustar under `package/`, gzipped. */
  const tgz = (files: Record<string, string>): Uint8Array => {
    const blocks: Uint8Array[] = [];
    for (const [path, body] of Object.entries(files)) {
      const h = new Uint8Array(512);
      const put = (at: number, text: string) => h.set(new TextEncoder().encode(text), at);
      const bytes = new TextEncoder().encode(body);
      put(0, `package/${path}`);
      put(100, "0000644\0");
      put(108, "0000000\0");
      put(116, "0000000\0");
      put(124, `${bytes.length.toString(8).padStart(11, "0")}\0`);
      put(136, "00000000000\0");
      put(148, "        ");
      h[156] = 0x30;
      put(257, "ustar\0");
      put(263, "00");
      put(148, `${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `);
      blocks.push(h, bytes, new Uint8Array((512 - (bytes.length % 512)) % 512));
    }
    blocks.push(new Uint8Array(1024));
    return Bun.gzipSync(cat(...blocks));
  };
  const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => { const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } return out; };
  const sri = (b: Uint8Array): string => `sha512-${createHash("sha512").update(b).digest("base64")}`;
  /** A bun.lock pinning each package to its tarball (npm's registry unless `registry` says otherwise). */
  const lockFor = (pkgs: Record<string, Uint8Array>, registry = ""): string =>
    `{\n  "lockfileVersion": 1,\n  "packages": {\n${Object.entries(pkgs).map(([id, t]) => `    "${id.replace(/@[^@]*$/, "")}": ["${id}", "${registry}", {}, "${sri(t)}"],\n`).join("")}  },\n}\n`;
  const lock = (ids: string[]): string => lockFor(Object.fromEntries(ids.map((id) => [id, new Uint8Array([1])])));
  /** Installs `files` as node_modules/<dir> (its package.json too). */
  const install = (root: string, dir: string, files: Record<string, string>): void => {
    for (const [f, body] of Object.entries(files)) { mkdirSync(join(root, "node_modules", dir, f, ".."), { recursive: true }); writeFileSync(join(root, "node_modules", dir, f), body); }
  };

  test("bun.lock's packages, read with its trailing commas", () => {
    expect([...lockedPackages(lock(["left-pad@1.3.0", "@scope/pkg@2.0.0"]))].sort()).toEqual(["@scope/pkg@2.0.0", "left-pad@1.3.0"]);
    expect(tarballUrl("left-pad", "1.3.0", "")).toBe("https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz");
    expect(tarballUrl("@s/p", "2.0.0", "https://r.example/")).toBe("https://r.example/@s/p/-/p-2.0.0.tgz");
    expect(tarballUrl("@s/p", "2.0.0", "https://npm.pkg.github.com/download/@s/p/2.0.0/abc")).toBe("https://npm.pkg.github.com/download/@s/p/2.0.0/abc");
  });

  test("the reviewer's probe: an entry importing an ignored file outside its plugin gets it inlined, and the inputs check refuses it by name", async () => {
    const dir = repo({
      ".gitignore": "ignored/\n",
      "plugins/clover/host.ts": "import { gen } from \"../../ignored/gen.ts\";\nexport const x = gen;\n",
    });
    mkdirSync(join(dir, "ignored"));
    writeFileSync(join(dir, "ignored", "gen.ts"), "export const gen = \"generated, never committed\";\n");
    const out = mkdtempSync(join(tmpdir(), "lane-m-inputs-out-"));
    const built = await buildPluginModule({ entry: join(dir, "plugins", "clover", "host.ts"), outFile: join(out, "host.js"), side: "bun" });
    // Inlined: the copy filter never saw it.
    expect(built.source).toContain("generated, never committed");
    expect(built.inputs.map((p) => p.split("/").slice(-2).join("/")).sort()).toEqual(["clover/host.ts", "ignored/gen.ts"]);
    expect(await repoInputVetter(dir)(built.inputs)).toEqual(["ignored/gen.ts: the build read a file that isn't tracked at HEAD"]);
    // Through the release's build: the build fails, naming it, and the stage is removed.
    const dest = join(dir, "out", "plugins");
    const leaking: PluginBuilder = async (folder, o) => {
      mkdirSync(o.out, { recursive: true });
      writeFileSync(join(o.out, "host.js"), built.source);
      return { dir: o.out, files: ["host.js"], modules: [{ file: "host.js", kind: "host", source: built.source, inputs: built.inputs }], natives: [] };
    };
    await expect(buildBundledPlugins(dir, dest, "darwin-arm64", { build: leaking })).rejects.toThrow("ignored/gen.ts: the build read a file that isn't tracked at HEAD");
    expect(existsSync(dest)).toBe(false);
  });

  test("a node_modules file passes only when it is byte for byte its package's file in the tarball bun.lock pins", async () => {
    const leftPad = { "package.json": JSON.stringify({ name: "left-pad", version: "1.3.0" }), "index.js": "module.exports = 1;" };
    const react = { "package.json": JSON.stringify({ name: "react", version: "19.0.0" }), "index.js": "export const r = 1;" };
    const tarballs: Record<string, Uint8Array> = { "left-pad@1.3.0": tgz(leftPad), "react@19.0.0": tgz(react) };
    const dir = repo({ "bun.lock": lockFor(tarballs), "plugins/clover/host.ts": "x" });
    install(dir, "left-pad", leftPad);
    install(dir, "react", react);
    const fetched: string[] = [];
    const download = async (url: string): Promise<Uint8Array> => {
      fetched.push(url);
      const id = /\/-\/(.+)-(\d+\.\d+\.\d+)\.tgz$/.exec(url)!;
      return tarballs[`${id[1]}@${id[2]}`]!;
    };
    const vet = repoInputVetter(dir, { download });
    const nm = (p: string): string => join(dir, "node_modules", ...p.split("/"));
    expect(await vet([nm("left-pad/index.js"), nm("react/index.js"), join(dir, "plugins", "clover", "host.ts")])).toEqual([]);
    // Each package's tarball is fetched once, from npm's registry.
    expect(fetched.sort()).toEqual(["https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", "https://registry.npmjs.org/react/-/react-19.0.0.tgz"]);
    // The reviewer's probes: a file added to an installed, locked package ...
    writeFileSync(nm("react/evil.js"), "steal();");
    expect(await vet([nm("react/evil.js")])).toEqual(["node_modules/react/evil.js: not in react@19.0.0's tarball (a file added to the installed package)"]);
    // ... and a fake nested package claiming a locked name and version.
    install(dir, "react/node_modules/left-pad", { "package.json": JSON.stringify({ name: "left-pad", version: "1.3.0" }), "index.js": "steal();" });
    expect(await vet([nm("react/node_modules/left-pad/index.js")])).toEqual(["node_modules/react/node_modules/left-pad/index.js: differs from left-pad@1.3.0's tarball"]);
    // An edited file of a locked package.
    writeFileSync(nm("left-pad/index.js"), "module.exports = 2;");
    expect(await vet([nm("left-pad/index.js")])).toEqual(["node_modules/left-pad/index.js: differs from left-pad@1.3.0's tarball"]);
    // Identity first: a version bun.lock doesn't hold, a misnamed package.
    install(dir, "left-pad", { "package.json": JSON.stringify({ name: "left-pad", version: "1.3.1" }) });
    expect(await vet([nm("left-pad/index.js")])).toEqual(["node_modules/left-pad/index.js: in left-pad@1.3.1, which bun.lock doesn't hold"]);
    install(dir, "left-pad", { "package.json": JSON.stringify({ name: "right-pad", version: "1.3.0" }) });
    expect(await vet([nm("left-pad/index.js")])).toEqual(["node_modules/left-pad/index.js: in node_modules/left-pad, whose package.json doesn't name left-pad with a version"]);
    // Outside the checkout, and not a file at all.
    const outside = join(mkdtempSync(join(tmpdir(), "lane-m-outside-")), "x.ts");
    writeFileSync(outside, "x");
    expect(await vet([outside])).toEqual([`${realpathSync(outside)}: the build read a file outside the checkout`]);
    expect(await vet([join(dir, "gone.ts")])).toEqual([`${join(dir, "gone.ts")}: the build read it, and it isn't a file here`]);
  });

  test("a tarball is trusted only on bun.lock's integrity, and GitHub Packages needs NODE_AUTH_TOKEN, sent only there", async () => {
    const good = tgz({ "package.json": JSON.stringify({ name: "left-pad", version: "1.3.0" }), "index.js": "1" });
    const entries = lockEntries(lockFor({ "left-pad@1.3.0": good }));
    const swapped = lockedPackageFiles(entries, { download: async () => tgz({ "package.json": JSON.stringify({ name: "left-pad", version: "1.3.0" }), "index.js": "evil" }) });
    await expect(swapped("left-pad@1.3.0")).rejects.toThrow("isn't what bun.lock pins (sha512 differs)");
    const gh = lockEntries(lockFor({ "@waifucave/x@1.0.0": good }, "https://npm.pkg.github.com/download/@waifucave/x/1.0.0/abc"));
    await expect(lockedPackageFiles(gh, { download: async () => good })("@waifucave/x@1.0.0")).rejects.toThrow("needs NODE_AUTH_TOKEN");
    const sent: Array<Record<string, string>> = [];
    const files = lockedPackageFiles(gh, { token: "tok-123", download: async (_url, headers) => { sent.push(headers); return good; } });
    // The tarball says left-pad, not @waifucave/x: refused, and the token never shows in the message.
    const err = await files("@waifucave/x@1.0.0").catch((e: Error) => e.message);
    expect(err).toContain("its tarball is left-pad@1.3.0");
    expect(err).not.toContain("tok-123");
    expect(sent).toEqual([{ Authorization: "Bearer tok-123" }]);
    // Never over plain http.
    const plain = lockEntries(lockFor({ "@waifucave/x@1.0.0": good }, "http://npm.pkg.github.com/download/@waifucave/x/1.0.0/abc"));
    const leaked: Array<Record<string, string>> = [];
    await expect(lockedPackageFiles(plain, { token: "tok-123", download: async (_u, h) => { leaked.push(h); return good; } })("@waifucave/x@1.0.0")).rejects.toThrow("the token goes only over https");
    expect(leaked).toEqual([]);
    // npm's registry gets no token.
    const npm: Array<Record<string, string>> = [];
    await lockedPackageFiles(entries, { token: "tok-123", download: async (_u, h) => { npm.push(h); return good; } })("left-pad@1.3.0");
    expect(npm).toEqual([{}]);
  });

  test("today's bundled plugins pass: every file the real build reads is tracked at HEAD or a locked package's own file", async () => {
    const target = hostShipTarget();
    if (target === undefined) return;
    const dest = join(mkdtempSync(join(tmpdir(), "lane-m-inputs-real-")), "plugins");
    const seen: string[] = [];
    // No download in a test: each package's files come from this checkout's install, read through the same check (a
    // release build fetches the tarballs bun.lock pins instead). Every input is still classified: tracked, or a
    // locked package's file by name, version and path.
    const installed = new Map<string, string>();
    const vet = repoInputVetter(ROOT, {
      packageFiles: async (id) => {
        const dir = installed.get(id);
        if (dir === undefined) throw new Error(`${id}: not installed here`);
        const files = new Map<string, Uint8Array>();
        const walk = (rel: string): void => {
          for (const n of readdirSync(join(dir, rel), { withFileTypes: true })) {
            const r = rel === "" ? n.name : `${rel}/${n.name}`;
            if (n.isDirectory()) { if (n.name !== "node_modules") walk(r); } else files.set(r, new Uint8Array(readFileSync(join(dir, r))));
          }
        };
        walk("");
        return files;
      },
    });
    const built = await buildBundledPlugins(ROOT, dest, target, {
      build: (folder, o) => buildPluginForShipping(folder, { ...o, dev: true }),
      vet: async (inputs) => {
        seen.push(...inputs);
        for (const i of inputs) {
          const m = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(realpathSync(i));
          if (m) { const p = JSON.parse(readFileSync(join(m[1]!, "package.json"), "utf8")); installed.set(`${p.name}@${p.version}`, m[1]!); }
        }
        return vet(inputs);
      },
    });
    expect(built.modules.length).toBeGreaterThan(0);
    expect(seen.some((p) => p.includes("/node_modules/"))).toBe(true);
    expect(await vet(seen)).toEqual([]);
    rmSync(join(dest, ".."), { recursive: true, force: true });
  }, 120_000);
});
