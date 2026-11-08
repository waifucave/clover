// `buildPluginForShipping` (registry/ship.ts): a plugin folder, children included, into the built tree an install
// carries, through the registry's own builder; natives with their prebuilt binary per target.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, validateManifest } from "@waifucave/clover-plugin-sdk";
import { PluginBuildError } from "../build";
import { buildPluginForShipping, hostShipTarget, SHIP_TARGETS, untarGz, type ShipTarget } from "../ship";

const write = (root: string, files: Record<string, string | Uint8Array>) => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
};
const json = (v: unknown) => JSON.stringify(v, null, 2);
const pkg = (name: string, extra: Record<string, unknown> = {}) => json({ name, version: "1.0.0", type: "module", main: "index.js", ...extra });

/** The platforms the fake native has prebuilt packages for, as npm and bun.lock name them. */
const PLATFORMS: Record<string, { os: string; cpu: string; libc?: string }> = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "linux-x64-gnu": { os: "linux", cpu: "x64", libc: "glibc" },
  "linux-x64-musl": { os: "linux", cpu: "x64", libc: "musl" },
  "linux-arm64-gnu": { os: "linux", cpu: "arm64", libc: "glibc" },
  "win32-x64-msvc": { os: "win32", cpu: "x64" },
};

async function tarball(name: string, files: Record<string, string>, pkgJson?: string): Promise<Uint8Array> {
  const entries: Record<string, string> = { "package/package.json": pkgJson ?? json({ name, version: "1.0.0" }) };
  for (const [k, v] of Object.entries(files)) entries[`package/${k}`] = v;
  return new Bun.Archive(entries, { compress: "gzip" }).bytes();
}
const sri = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** A checkout: a lockfile, installed packages (one native among them) and the `demo` plugin with a child. */
const NATIVE_PKG = () => pkg("fake-native", {
  dependencies: { "fake-dep": "1.0.0" },
  optionalDependencies: Object.fromEntries(Object.keys(PLATFORMS).map((p) => [`@fake-native/${p}`, "1.0.0"])),
});
const NATIVE_JS = `import { dep } from "fake-dep";\nexport const native = () => dep;\n`;

async function checkout(o: { plugin?: Record<string, string>; tamper?: string; misnamed?: boolean; lock?: Record<string, unknown[]> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "clover-b-ship-"));
  const tarballs = new Map<string, Uint8Array>();
  const lock: Record<string, unknown[]> = { "fake-lib": ["fake-lib@1.0.0", "", {}, "sha512-AAAA"], ...o.lock };
  // The native and its dependency, as the registry serves them: what a release ships, checked against the lockfile.
  for (const [name, files, pkgJson] of [["fake-native", { "index.js": NATIVE_JS }, NATIVE_PKG()], ["fake-dep", { "index.js": "export const dep = 1;\n" }, pkg("fake-dep")]] as const) {
    const bytes = await tarball(name, files, o.misnamed && name === "fake-dep" ? pkg("fake-dep", { version: "2.0.0" }) : pkgJson);
    tarballs.set(`https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, bytes);
    lock[name] = [`${name}@1.0.0`, "", {}, sri(bytes)];
  }
  for (const [plat, meta] of Object.entries(PLATFORMS)) {
    const name = `@fake-native/${plat}`;
    const bytes = await tarball(name, { "fake.node": `binary for ${plat}` });
    tarballs.set(`https://registry.npmjs.org/${name}/-/${plat}-1.0.0.tgz`, o.tamper === plat ? await tarball(name, { "fake.node": "swapped" }) : bytes);
    lock[name] = [`${name}@1.0.0`, "", meta, sri(bytes)];
  }
  write(root, {
    "bun.lock": `{\n  "lockfileVersion": 1,\n  "workspaces": {},\n  "packages": ${json(lock)},\n}\n`,
    "node_modules/fake-lib/package.json": pkg("fake-lib"),
    "node_modules/fake-lib/index.js": `export const lib = () => "lib";\n`,
    "node_modules/fake-ui/package.json": pkg("fake-ui"),
    "node_modules/fake-ui/index.js": `export const ui = () => "ui";\n`,
    "node_modules/fake-dep/package.json": pkg("fake-dep"),
    "node_modules/fake-dep/index.js": `export const dep = 1;\n`,
    "node_modules/fake-native/package.json": NATIVE_PKG(),
    "node_modules/fake-native/index.js": NATIVE_JS,
    // The one platform package this checkout has installed: shipped from here, never downloaded.
    "node_modules/@fake-native/linux-arm64-gnu/package.json": json({ name: "@fake-native/linux-arm64-gnu", version: "1.0.0" }),
    "node_modules/@fake-native/linux-arm64-gnu/fake.node": "installed binary for linux-arm64-gnu",
  });
  const plugin = join(root, "plugins", "demo");
  write(plugin, {
    "clover.json": `// the demo plugin\n${json({
      manifest: 1, id: "demo", name: "Demo", version: "1.0.0", icon: "assets/icon.svg", engines: { clover: `^${PLUGIN_API_VERSION}` },
      host: { entry: "host/index.ts" },
      client: { entry: "./client/index.tsx" },
      contributes: { mcpServers: { tools: { type: "stdio", command: "bun", args: ["--smol", "server/main.ts", "--port", "1"] }, other: { type: "stdio", command: "uvx", args: ["tool.py"] } } },
    })}`,
    "package.json": json({ name: "@x/demo", version: "1.0.0", license: "MIT", type: "module", scripts: { test: "bun test" }, dependencies: { "fake-lib": "1.0.0", "fake-native": "1.0.0", "fake-ui": "1.0.0" }, devDependencies: { typescript: "5" } }),
    "host/index.ts": `import { lib } from "fake-lib";\nimport { native } from "fake-native";\nimport { helper } from "../src/helper";\nexport const start = (): unknown[] => [lib(), native(), helper()];\n`,
    "src/helper.ts": `export const helper = (): string => "helper";\n`,
    "client/index.tsx": `import "./style.css";\nimport { ui } from "fake-ui";\nexport function Card() {\n  return <div className="card">{ui()}</div>;\n}\n`,
    "client/style.css": `.card { color: red; }\n`,
    "server/main.ts": `import { lib } from "fake-lib";\nconsole.log(lib());\n`,
    "assets/icon.svg": `<svg xmlns="http://www.w3.org/2000/svg"/>`,
    "README.md": "# Demo\n",
    "test/host.test.ts": `test("x", () => {});\n`,
    "host/index.test.ts": `test("x", () => {});\n`,
    "tsconfig.json": "{}",
    "bunfig.toml": "",
    ".env": "X=1\n",
    "plugins/kid/clover.json": json({ manifest: 1, name: "Kid", client: { entry: "client/index.tsx" } }),
    "plugins/kid/client/index.tsx": `export const Kid = () => <b>kid</b>;\n`,
    "plugins/kid/notes.md": "kid\n",
    ...o.plugin,
  });
  const downloads: string[] = [];
  const download = async (url: string) => {
    downloads.push(url);
    const bytes = tarballs.get(url);
    if (bytes === undefined) throw new Error(`no such tarball: ${url}`);
    return bytes;
  };
  return { root, plugin, download, downloads };
}

const read = (dir: string, rel: string) => readFileSync(join(dir, ...rel.split("/")), "utf8");

describe("buildPluginForShipping", () => {
  test("builds every entry of the tree, rewrites the manifests, and ships the native's prebuilt binary for the target", async () => {
    const c = await checkout();
    const r = await buildPluginForShipping(c.plugin, { target: "linux-x64", download: c.download, out: join(c.root, "out"), bundled: true });
    expect(r.dir).toBe(realpathSync(join(c.root, "out")));
    expect(r.files).toEqual([
      "README.md",
      "assets/icon.svg",
      "client/index.css",
      "client/index.js",
      "client/style.css",
      "clover.json",
      "host/index.js",
      "node_modules/@fake-native/linux-x64-gnu/fake.node",
      "node_modules/@fake-native/linux-x64-gnu/package.json",
      "node_modules/fake-dep/index.js",
      "node_modules/fake-dep/package.json",
      "node_modules/fake-native/index.js",
      "node_modules/fake-native/package.json",
      "package.json",
      "plugins/kid/client/index.js",
      "plugins/kid/clover.json",
      "plugins/kid/notes.md",
      "plugins/kid/package.json",
      "server/main.js",
    ]);
    // The native, its dependency and only the target's prebuilt package came down, each checked against the lockfile.
    expect(c.downloads).toEqual([
      "https://registry.npmjs.org/fake-native/-/fake-native-1.0.0.tgz",
      "https://registry.npmjs.org/fake-dep/-/fake-dep-1.0.0.tgz",
      "https://registry.npmjs.org/@fake-native/linux-x64-gnu/-/linux-x64-gnu-1.0.0.tgz",
    ]);
    expect(read(r.dir, "node_modules/@fake-native/linux-x64-gnu/fake.node")).toBe("binary for linux-x64-gnu");
    expect(r.natives).toEqual([{ file: "node_modules/@fake-native/linux-x64-gnu/fake.node", package: "fake-native", target: "linux-x64" }]);

    const top = JSON.parse(read(r.dir, "clover.json"));
    expect(top.built).toBe(true);
    expect(top.host).toEqual({ entry: "host/index.js" });
    expect(top.client).toEqual({ entry: "client/index.js", css: ["client/index.css"] });
    expect(top.contributes.mcpServers.tools.args).toEqual(["--smol", "server/main.js", "--port", "1"]);
    expect(top.contributes.mcpServers.other.args).toEqual(["tool.py"]);
    expect(validateManifest(read(r.dir, "clover.json"), { folderName: "demo", bundled: true }).issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(JSON.parse(read(r.dir, "plugins/kid/clover.json"))).toEqual({ manifest: 1, name: "Kid", client: { entry: "client/index.js" }, built: true });
    expect(JSON.parse(read(r.dir, "package.json"))).toEqual({ name: "@x/demo", version: "1.0.0", license: "MIT", private: true, type: "module", dependencies: { "fake-native": "1.0.0" } });

    const mod = (file: string) => r.modules.find((m) => m.file === file)!;
    expect(r.modules.map((m) => [m.file, m.kind])).toEqual([["client/index.js", "client"], ["host/index.js", "host"], ["plugins/kid/client/index.js", "client"], ["server/main.js", "host"]]);
    // The host bundles its own code and pure dependencies, and keeps only the native as an import.
    const host = new Bun.Transpiler({ loader: "js", ...({ macro: false } as object) }).scanImports(mod("host/index.js").source).map((i) => i.path);
    expect(host).toEqual(["fake-native"]);
    expect(mod("host/index.js").source).toContain(`"helper"`);
    expect(mod("host/index.js").source).toContain(`"lib"`);
    // The client keeps only the layer's imports, for production React, and its CSS moved out.
    const client = mod("client/index.js").source;
    expect(new Bun.Transpiler({ loader: "js", ...({ macro: false } as object) }).scanImports(client).map((i) => i.path)).toEqual(["react/jsx-runtime"]);
    expect(client).not.toContain("jsx-dev-runtime");
    expect(client).toContain(`"ui"`);
    expect(read(r.dir, "client/index.css")).toContain("red");
    expect(mod("client/index.js").source).toBe(read(r.dir, "client/index.js"));
    // A bundle never names where its inputs were on the computer that built it.
    for (const m of r.modules) expect([m.file, m.source.includes(realpathSync(tmpdir())) || m.source.includes("fake-lib/index.js") || m.source.includes("../")]).toEqual([m.file, false]);
    // The built host runs from the built tree, its native resolved from the plugin's own node_modules.
    const loaded = await import(join(r.dir, "host", "index.js"));
    expect(loaded.start()).toEqual(["lib", 1, "helper"]);
  });

  test("a release always ships the lockfile's download; only a dev build takes this checkout's installed copy", async () => {
    const c = await checkout();
    const release = await buildPluginForShipping(c.plugin, { target: "linux-arm64", download: c.download, bundled: true });
    expect(c.downloads.length).toBe(3);
    expect(read(release.dir, "node_modules/@fake-native/linux-arm64-gnu/fake.node")).toBe("binary for linux-arm64-gnu");
    expect(JSON.parse(read(release.dir, "clover.json")).built).toBe(true);
    c.downloads.length = 0;
    const dev = await buildPluginForShipping(c.plugin, { target: "linux-arm64", download: c.download, dev: true });
    expect(c.downloads).toEqual([]);
    expect(read(dev.dir, "node_modules/@fake-native/linux-arm64-gnu/fake.node")).toBe("installed binary for linux-arm64-gnu");
    expect(dev.natives).toEqual([{ file: "node_modules/@fake-native/linux-arm64-gnu/fake.node", package: "fake-native", target: "linux-arm64" }]);
    // Only a bundled tree is marked built (#271's L2).
    expect(JSON.parse(read(dev.dir, "clover.json")).built).toBeUndefined();
  });

  test("a download whose package isn't the lockfile's exact name and version is refused", async () => {
    const c = await checkout({ misnamed: true });
    const e = await buildPluginForShipping(c.plugin, { target: "linux-x64", download: c.download }).catch((x) => x);
    expect(e).toBeInstanceOf(PluginBuildError);
    expect(e.message).toContain("fake-dep@1.0.0: its tarball is fake-dep@2.0.0, not the package the lockfile pins");
  });

  test("every target takes its own platform's package, glibc's on Linux", async () => {
    const c = await checkout();
    const want: Record<ShipTarget, string> = { "darwin-arm64": "darwin-arm64", "linux-x64": "linux-x64-gnu", "linux-arm64": "linux-arm64-gnu", "windows-x64": "win32-x64-msvc" };
    for (const target of SHIP_TARGETS) {
      const r = await buildPluginForShipping(c.plugin, { target, download: c.download });
      expect([target, r.natives.map((n) => n.file)]).toEqual([target, [`node_modules/@fake-native/${want[target]}/fake.node`]]);
    }
  });

  test("a download that isn't what the lockfile pins fails the build, and leaves no tree behind", async () => {
    const c = await checkout({ tamper: "win32-x64-msvc" });
    const out = join(c.root, "out");
    const e = await buildPluginForShipping(c.plugin, { target: "windows-x64", download: c.download, out }).catch((x) => x);
    expect(e).toBeInstanceOf(PluginBuildError);
    expect(String(e.message)).toContain("isn't what the lockfile pins");
    expect(existsSync(out)).toBe(false);
  });

  test("a client importing what nothing provides, or a host importing a file outside, fails with the bundler's message", async () => {
    const c = await checkout({ plugin: { "client/index.tsx": `import { nope } from "not-installed";\nexport const X = () => nope;\n` } });
    const e = await buildPluginForShipping(c.plugin, { target: "linux-arm64", download: c.download }).catch((x) => x);
    expect(e).toBeInstanceOf(PluginBuildError);
    expect(e.problems.some((p: string) => p.startsWith("clover.json: ") && p.includes("not-installed"))).toBe(true);
    // No folder of the computer that built it in the error (#271's L5).
    expect(e.message).not.toContain(c.root);
    expect(e.message).not.toContain(realpathSync(c.root));
  });

  test("a file the manifest names that doesn't ship fails the build (the built tree is validated)", async () => {
    const c = await checkout();
    const e = await buildPluginForShipping(c.plugin, { target: "linux-arm64", download: c.download, include: (rel) => rel !== "assets/icon.svg" }).catch((x) => x);
    expect(e).toBeInstanceOf(PluginBuildError);
    expect(e.problems.join("\n")).toContain("file_missing");
  });

  test("only `include`d files are copied; a symlink is refused", async () => {
    const c = await checkout();
    const r = await buildPluginForShipping(c.plugin, { target: "linux-arm64", download: c.download, include: (rel) => rel !== "README.md" });
    expect(r.files).not.toContain("README.md");
    if (process.platform === "win32") return; // a symlink needs a privilege there; lane M's staging refuses them anyway
    const { symlinkSync } = await import("node:fs");
    symlinkSync("README.md", join(c.plugin, "linked.md"));
    const e = await buildPluginForShipping(c.plugin, { target: "linux-arm64", download: c.download }).catch((x) => x);
    expect(e).toBeInstanceOf(PluginBuildError);
    expect(e.message).toContain("linked.md is a symlink");
  });

  test("a native built on this computer (a .node of its own) ships only for this computer's target", async () => {
    const c = await checkout({ plugin: { "host/index.ts": `import { own } from "own-native";\nexport const start = () => own;\n` }, lock: { "own-native": ["own-native@1.0.0", "", {}, "sha512-AAAA"] } });
    write(c.root, { "node_modules/own-native/package.json": pkg("own-native"), "node_modules/own-native/index.js": "export const own = 1;\n", "node_modules/own-native/build/Release/own.node": "bin" });
    const here = hostShipTarget();
    for (const target of SHIP_TARGETS) {
      const r = await buildPluginForShipping(c.plugin, { target, download: c.download, dev: true }).catch((x) => x);
      if (target === here) expect(r.natives).toEqual([{ file: "node_modules/own-native/build/Release/own.node", package: "own-native", target }]);
      else expect([target, r instanceof PluginBuildError && r.message.includes("built on this computer")]).toEqual([target, true]);
    }
    // A release never ships one, whatever the target.
    const release = await buildPluginForShipping(c.plugin, { target: here ?? "linux-x64", download: c.download }).catch((x) => x);
    expect(release instanceof PluginBuildError && release.message.includes("built on this computer")).toBe(true);
  });

  test("a CommonJS dependency's __dirname and __filename are the module's own at run time, never the builder's path", async () => {
    const c = await checkout({ plugin: { "host/index.ts": `import where from "cjs-where";\nexport const start = () => where;\n` } });
    write(c.root, {
      "node_modules/cjs-where/package.json": json({ name: "cjs-where", version: "1.0.0", main: "index.js" }),
      "node_modules/cjs-where/index.js": `module.exports = { dir: __dirname, file: __filename };\n`,
    });
    const r = await buildPluginForShipping(c.plugin, { target: "linux-arm64", download: c.download });
    const host = read(r.dir, "host/index.js");
    expect(host).not.toContain(c.root);
    expect(host).not.toContain(realpathSync(c.root));
    const loaded = await import(join(r.dir, "host", "index.js"));
    expect(loaded.start()).toEqual({ dir: join(r.dir, "host"), file: join(r.dir, "host", "index.js") });
  });

  test("a path of the computer that built it, anywhere in what the build writes, fails the build", async () => {
    const c = await checkout();
    write(c.plugin, { "host/index.ts": `export const start = () => ${JSON.stringify(join(realpathSync(c.root), "secret"))};\n` });
    const e = await buildPluginForShipping(c.plugin, { target: "linux-arm64", download: c.download }).catch((x) => x);
    expect(e).toBeInstanceOf(PluginBuildError);
    expect(e.message).toContain("index.js: holds the checkout, a path of the computer that built it");
    write(c.plugin, { "host/index.ts": `export const start = () => "/x/${userInfo().username}/y";\n` });
    const u = await buildPluginForShipping(c.plugin, { target: "linux-arm64", download: c.download }).catch((x) => x);
    expect(u.message).toContain("the user's name in a path");
  });

  test("a load the scan can't check fails the build, in a built module or in JavaScript the folder ships as it is", async () => {
    const forms: [string, string][] = [
      ["computed import()", "export const f = (x: string) => import(x);"],
      ["template import()", "export const f = (x: string) => import(`./${x}.js`);"],
      ["computed require", "declare const require: (s: string) => unknown;\nexport const f = (x: string) => require(x);"],
      ["import.meta.require", "export const f = (x: string) => import.meta.require(x);"],
      ["createRequire", `import { createRequire } from "node:module";\nexport const f = () => createRequire(import.meta.url)("x");`],
      ["getBuiltinModule", `export const f = () => process.getBuiltinModule("module");`],
      ["a Worker", `export const f = () => new Worker("./w.js");`],
      ["Bun.resolveSync", `export const f = () => Bun.resolveSync("x", ".");`],
      ["a literal require of what isn't shipped", `declare const require: (s: string) => unknown;\nexport const f = () => require("left-pad");`],
    ];
    for (const [what, code] of forms) {
      const c = await checkout({ plugin: { "host/index.ts": `${code}\nexport const start = () => 1;\n` } });
      const e = await buildPluginForShipping(c.plugin, { target: "linux-arm64", download: c.download }).catch((x) => x);
      expect([what, e instanceof PluginBuildError && /can't be checked|requires left-pad at run time|takes node:module|Could not resolve: "left-pad"/.test(e.message) ? true : String(e?.message ?? e)]).toEqual([what, true]);
    }
    const client = await checkout({ plugin: { "client/index.tsx": `export const load = (url: string) => import(url);\n` } });
    const ce = await buildPluginForShipping(client.plugin, { target: "linux-arm64", download: client.download }).catch((x) => x);
    expect(ce instanceof PluginBuildError && ce.message.includes("import() of a computed specifier")).toBe(true);
    const copied = await checkout({ plugin: { "assets/helper.js": `export const f = (x) => import(x);\n` } });
    const pe = await buildPluginForShipping(copied.plugin, { target: "linux-arm64", download: copied.download }).catch((x) => x);
    expect(pe instanceof PluginBuildError && pe.message.includes("assets/helper.js: 1 import() of a computed specifier")).toBe(true);
    // The bundler's own shims and a literal require of a built-in pass.
    const ok = await checkout({ plugin: { "host/index.ts": `declare const require: (s: string) => unknown;\nexport const start = () => require("node:path");\n` } });
    expect((await buildPluginForShipping(ok.plugin, { target: "linux-arm64", download: ok.download })).modules.length).toBe(4);
  });

  test("programs: bun run, node --import, and a form it can't build refuses rather than ship unbuilt", async () => {
    const runs = async (args: string[], command = "node", extra: Record<string, string> = {}) => {
      const c = await checkout({ plugin: { ...extra, "plugins/kid/clover.json": json({ manifest: 1, name: "Kid", contributes: { mcpServers: { s: { type: "stdio", command, args } } } }), "plugins/kid/setup.ts": `globalThis.x = 1;\n`, "plugins/kid/main.ts": `console.log(1);\n` } });
      return buildPluginForShipping(c.plugin, { target: "linux-arm64", download: c.download }).then(
        (r) => JSON.parse(read(r.dir, "plugins/kid/clover.json")).contributes.mcpServers.s.args,
        (e) => (e instanceof PluginBuildError ? `refused: ${e.message}` : e),
      );
    };
    expect(await runs(["--import", "setup.ts", "main.ts", "--flag"])).toEqual(["--import", "setup.js", "main.js", "--flag"]);
    expect(await runs(["run", "main.ts"], "bun")).toEqual(["run", "main.js"]);
    expect(await runs(["--smol", "--conditions", "x", "./main.ts"], "bun")).toEqual(["--smol", "--conditions", "x", "main.js"]);
    for (const [args, cmd, why] of [
      [["x", "some-package"], "bun", "isn't a module of the plugin's"],
      [["-e", "console.log(1)"], "node", "a flag the release build doesn't know"],
      [["--weird", "main.ts"], "node", "a flag the release build doesn't know"],
      [["missing.ts"], "node", "isn't a module of the plugin's"],
      [["--import", "some-package", "main.ts"], "node", "isn't a module in the plugin"],
      [["--import=setup.ts", "main.ts"], "node", "two arguments"],
      [[], "bun", "names no program file"],
    ] as const) {
      const r = await runs([...args], cmd);
      expect([args.join(" "), typeof r === "string" && r.startsWith("refused:") && r.includes(why)]).toEqual([args.join(" "), true]);
    }
  });

  test("an output folder that isn't empty is refused; an unknown target is refused", async () => {
    const c = await checkout();
    write(c.root, { "out/x": "x" });
    expect(buildPluginForShipping(c.plugin, { target: "linux-x64", download: c.download, out: join(c.root, "out") })).rejects.toThrow("isn't empty");
    expect(buildPluginForShipping(c.plugin, { target: "darwin-x64" as ShipTarget, download: c.download })).rejects.toThrow("unknown target");
  });
});

describe("untarGz", () => {
  test("drops the top folder and keeps regular files only", async () => {
    const files = untarGz(await tarball("p", { "a/b.txt": "b" }), "p");
    expect(files.map((f) => [f.path, new TextDecoder().decode(f.bytes)])).toEqual([["package.json", json({ name: "p", version: "1.0.0" })], ["a/b.txt", "b"]]);
  });

  test("refuses what isn't gzip, a path with .., and a link", () => {
    expect(() => untarGz(new Uint8Array([1, 2, 3]), "p")).toThrow("isn't gzip");
    const header = (name: string, type: string, body = "") => {
      const h = new Uint8Array(512);
      h.set(new TextEncoder().encode(name), 0);
      h.set(new TextEncoder().encode("0000644\0"), 100);
      h.set(new TextEncoder().encode(`${body.length.toString(8).padStart(11, "0")}\0`), 124);
      h[156] = type.charCodeAt(0);
      h.set(new TextEncoder().encode("ustar\0"), 257);
      const data = new Uint8Array(Math.ceil(body.length / 512) * 512);
      data.set(new TextEncoder().encode(body));
      return [...h, ...data];
    };
    const gz = (...parts: number[][]) => Bun.gzipSync(new Uint8Array([...parts.flat(), ...new Uint8Array(1024)]));
    expect(() => untarGz(gz(header("package/../../evil", "0", "x")), "p")).toThrow("outside its package folder");
    expect(() => untarGz(gz(header("package/link", "2")), "p")).toThrow("isn't a regular file");
    expect(() => untarGz(gz(header("package/c:evil", "0", "x")), "p")).toThrow("outside its package folder");
    expect(() => untarGz(gz(header("package/a/x:y", "0", "x")), "p")).toThrow("outside its package folder");
    expect(untarGz(gz(header("package/ok", "0", "y")), "p").map((f) => f.path)).toEqual(["ok"]);
  });
});

describe("the bundled plugins", () => {
  // The real tree, for this computer's target: every entry builds, every module keeps only what it may import.
  for (const id of readdirSync(join(import.meta.dir, "../../../../../plugins")).sort()) {
    test(`${id} builds for shipping`, async () => {
      const target = hostShipTarget();
      if (target === undefined) return;
      const r = await buildPluginForShipping(join(import.meta.dir, "../../../../../plugins", id), {
        target,
        bundled: true,
        dev: true,
        download: async (url) => {
          throw new Error(`no download in this test: ${url}`);
        },
      });
      const manifest = JSON.parse(read(r.dir, "clover.json"));
      expect(manifest.built).toBe(true);
      for (const m of r.modules) {
        const bare = new Bun.Transpiler({ loader: "js", ...({ macro: false } as object) }).scanImports(m.source).map((i) => i.path).filter((s) => !s.startsWith("node:") && !s.startsWith("bun"));
        if (m.kind === "client") expect([m.file, bare.filter((s) => !["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@waifucave/clover-plugin-sdk/ui"].includes(s))]).toEqual([m.file, []]);
      }
      expect(r.files.some((f) => /\.(?:ts|tsx)$/.test(f))).toBe(false);
    }, 120_000);
  }
});
