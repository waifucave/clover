// Builds the app into out/ (electron-builder packages out/main and out/renderer, electron-builder.yml):
//
//   out/main/index.js            the main process, one ESM file for Electron's Node (electron stays external)
//   out/main/preload.cjs         the one preload (sandboxed preloads are CommonJS)
//   out/main/browser-viewport-preload.cjs, out/renderer/browser-viewport.html
//                                the Clover Browser's viewport page and its preload (lane L's `BROWSER_ASSETS`)
//   out/main/icons/              the tray's and Clover Dev's icons (resources/icons, drawn by scripts/brand-icons.ts)
//   out/main/native/screen.node  macOS: the screen add-on (native/input/macos/screen.mm), built with clang alone
//   out/renderer/core/           the window's core root: index.html, root.css, root.js
//   out/renderer/layer/          what every plugin layer serves under /_clover/: React (vendor/), the UI API
//                                (sdk-ui.js), the boot, the base styles, and the `clover` tree's bundle and styles
//
// The `clover` tree's children are found by their manifests under plugins/clover (wherever lane M's layout puts them),
// so no script names a child's path. `bun run dev:app` runs the result unpackaged.
//
// `--test-build` (scripts/release/build.ts --test-build only): the main process is compiled with the test-build label
// (scripts/test-build.ts) in place of `false`, so it uses Chromium's mock keychain and an answer key in memory. The
// define is compile-time only: nothing at run time can set it.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import type { BunPlugin } from "bun";
import { testBuildDefine } from "../../../scripts/test-build";

const unknown = process.argv.slice(2).filter((a) => a !== "--test-build");
if (unknown.length > 0) {
  console.error(`build: unknown argument ${unknown[0]} (usage: build [--test-build])`);
  process.exit(2);
}
const testBuild = process.argv.includes("--test-build");
const root = join(import.meta.dir, "..");
const repo = join(root, "..", "..");
const out = join(root, "out");
const layerOut = join(out, "renderer", "layer");
const coreOut = join(out, "renderer", "core");
for (const d of ["main", "renderer"]) rmSync(join(out, d), { recursive: true, force: true });
mkdirSync(join(layerOut, "vendor"), { recursive: true });
mkdirSync(coreOut, { recursive: true });

async function build(config: Parameters<typeof Bun.build>[0], what: string): Promise<void> {
  // Macros off: a `with { type: "macro" }` import would run in this build process (bun-types has no field, hence the spread).
  const result = await Bun.build({ ...config, ...{ macros: false } });
  if (!result.success) {
    console.error(`build: ${what} failed`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

const browser = { target: "browser" as const, format: "esm" as const, minify: true, sourcemap: "none" as const, define: { "process.env.NODE_ENV": '"production"' } };
const LAYER_EXTERNALS = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "@waifucave/clover-plugin-sdk/ui"];

// ---- The main process and the preload ----
await build({ entrypoints: [join(root, "src", "main", "index.ts")], outdir: join(out, "main"), target: "node", format: "esm", external: ["electron"], sourcemap: "linked", define: testBuildDefine(testBuild) }, "the main process");
await build({ entrypoints: [join(root, "src", "main", "preload.ts")], outdir: join(out, "main"), target: "node", format: "cjs", external: ["electron"], naming: "[name].cjs" }, "the preload");

// ---- The Clover Browser's viewport page and its preload (lane L's `BROWSER_ASSETS`) ----
{
  const { BROWSER_ASSETS } = await import("../src/main/browser/assets");
  const preloadOut = join(root, BROWSER_ASSETS.preload.out);
  const built = await Bun.build({ entrypoints: [join(root, BROWSER_ASSETS.preload.entry)], target: "node", format: "cjs", external: ["electron"], minify: false, ...{ macros: false } });
  if (!built.success || built.outputs.length !== 1) {
    for (const l of built.logs) console.error(l);
    console.error("build: the browser viewport's preload failed");
    process.exit(1);
  }
  mkdirSync(dirname(preloadOut), { recursive: true });
  writeFileSync(preloadOut, await built.outputs[0]!.text());
  const htmlOut = join(root, BROWSER_ASSETS.html.out);
  mkdirSync(dirname(htmlOut), { recursive: true });
  cpSync(join(root, BROWSER_ASSETS.html.from), htmlOut);
}

// ---- The app's own icons: the tray's (macOS's template, the Windows and Linux themes') and Clover Dev's ----
// Drawn from assets/brand/clover/ by scripts/brand-icons.ts and committed; copied as they are.
cpSync(join(root, "resources", "icons"), join(out, "main", "icons"), { recursive: true });

// ---- The core root ----
for (const f of ["index.html", "root.css"]) cpSync(join(root, "src", "core", f), join(coreOut, f));
await build({ ...browser, entrypoints: [join(root, "src", "core", "root.ts")], outdir: coreOut }, "the core root");

// ---- React, once per layer: one bundle, and a module per specifier with React's own export names ----
const vendorTmp = join(out, "vendor-src");
mkdirSync(vendorTmp, { recursive: true });
writeFileSync(join(vendorTmp, "react-all.ts"), [
  'import * as React from "react";',
  'import * as JSX from "react/jsx-runtime";',
  'import * as ReactDOM from "react-dom";',
  'import * as Client from "react-dom/client";',
  "export { React, JSX, ReactDOM, Client };",
].join("\n"));
await build({ ...browser, entrypoints: [join(vendorTmp, "react-all.ts")], outdir: join(layerOut, "vendor"), root: vendorTmp }, "React");
const require = (await import("node:module")).createRequire(join(root, "package.json"));
const VENDOR: Record<string, [string, string]> = {
  "react.js": ["React", "react"],
  "react-jsx-runtime.js": ["JSX", "react/jsx-runtime"],
  "react-dom.js": ["ReactDOM", "react-dom"],
  "react-dom-client.js": ["Client", "react-dom/client"],
};
for (const [file, [name, spec]] of Object.entries(VENDOR)) {
  process.env.NODE_ENV = "production";
  const keys = Object.keys(require(spec) as object).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== "default");
  writeFileSync(join(layerOut, "vendor", file), [
    `import { ${name} as M } from "./react-all.js";`,
    "const R = M.default ?? M;",
    "export default R;",
    `export const { ${keys.join(", ")} } = R;`,
  ].join("\n") + "\n");
}
rmSync(vendorTmp, { recursive: true, force: true });

// ---- The UI API, the boot and the base styles ----
const sdkUi = join(repo, "packages", "plugin-sdk", "src", "ui", "index.tsx");
await build({ ...browser, entrypoints: [sdkUi], outdir: layerOut, naming: "sdk-ui.[ext]", external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"] }, "the UI API");
await build({ ...browser, entrypoints: [join(root, "src", "layer", "boot.tsx")], outdir: layerOut, external: LAYER_EXTERNALS }, "the layer boot");
cpSync(join(root, "src", "layer", "layer.css"), join(layerOut, "layer.css"));

// ---- The `clover` tree: every child's client entry, found by its manifest ----
interface Child {
  name: string;
  dir: string;
  entry: string;
  css: string[];
}
function findChildren(dir: string, depth = 0): Child[] {
  const found: Child[] = [];
  if (depth > 3 || !existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const sub = join(dir, name);
    if (!statSync(sub).isDirectory()) continue;
    const manifest = join(sub, "clover.json");
    if (existsSync(manifest)) {
      const m = JSON.parse(readFileSync(manifest, "utf8")) as { client?: { entry?: string; css?: string[] } };
      if (m.client?.entry !== undefined) found.push({ name, dir: sub, entry: join(sub, m.client.entry), css: (m.client.css ?? []).map((c) => join(sub, c)) });
    }
    found.push(...findChildren(sub, depth + 1));
  }
  return found;
}
const children = findChildren(join(repo, "plugins", "clover"));
const byName = new Map(children.map((c) => [c.name, c]));
const childAlias: BunPlugin = {
  name: "clover-child",
  setup(b) {
    b.onResolve({ filter: /^@clover-child\// }, (args) => {
      // `@clover-child/<name>` is the child's client entry; `@clover-child/<name>/<path>` a file in its folder.
      const [name, ...rest] = args.path.slice("@clover-child/".length).split("/");
      const child = byName.get(name ?? "");
      if (child === undefined) throw new Error(`no child plugin named ${args.path} under plugins/clover`);
      if (rest.length === 0) return { path: child.entry };
      const base = join(child.dir, ...rest);
      const file = [base, `${base}.ts`, `${base}.tsx`].find((f) => existsSync(f) && statSync(f).isFile());
      if (file === undefined) throw new Error(`no file ${args.path}`);
      return { path: file };
    });
    // Each part's own UI API stand-in (lane F's \`client/sdk.ts\`) is the app's runtime in the \`clover\` layer.
    b.onResolve({ filter: /^\.\.?\/sdk(\.tsx?)?$/ }, (args) => {
      const dir = dirname(args.importer);
      if (!children.some((c) => dir.startsWith(join(c.dir, "client")))) return undefined;
      return { path: join(root, "src", "layer", "clover", "sdk.ts") };
    });
  },
};
await build({ ...browser, entrypoints: [join(root, "src", "layer", "clover", "index.ts")], outdir: layerOut, naming: "clover.[ext]", external: LAYER_EXTERNALS, plugins: [childAlias] }, "the clover tree");
// Its styles: each child's `client.css`, in the bindings' order (lane E-M2's cleaner wraps them in @scope).
const { modules } = (await import(join(root, "src", "layer", "clover", "ids.ts"))) as { modules: readonly string[] };
const css: string[] = [];
for (const id of modules) {
  const child = byName.get(id.slice("clover/".length));
  for (const file of child?.css ?? []) css.push(`/* ${relative(repo, file)} */\n${readFileSync(file, "utf8")}`);
}
writeFileSync(join(layerOut, "clover.css"), css.join("\n"));

// ---- The screen add-on (macOS; native/input) ----
// Built with clang alone: the few Node-API calls it makes are declared in its own source. Where it can't be built (no
// Xcode tools), the app does without it: no housing is known, as on Windows and Linux. Its install name is a fixed
// `@rpath/screen.node`: by default a shared library's is the path it was linked to, which would put this machine's
// build folder (and the account name in it) into every shipped app (the release's identity scan refuses that).
if (process.platform === "darwin") {
  const source = join(repo, "native", "input", "macos", "screen.mm");
  const dest = join(out, "main", "native", "screen.node");
  mkdirSync(dirname(dest), { recursive: true });
  const r = spawnSync("xcrun", ["clang++", "-x", "objective-c++", "-std=c++17", "-fobjc-arc", "-O2", "-arch", "arm64", "-mmacosx-version-min=14.0", "-shared", "-undefined", "dynamic_lookup", "-Wl,-install_name,@rpath/screen.node", "-framework", "AppKit", "-o", dest, source], { encoding: "utf8" });
  if (r.status !== 0) console.warn(`build: the screen add-on wasn't built (${(r.stderr || r.error?.message || "clang failed").trim().split("\n")[0]}); the app runs without it`);
}

console.log(`built ${relative(root, join(out, "main"))} and ${relative(root, join(out, "renderer"))}: ${children.length} clover children found, ${modules.length} bound`);
