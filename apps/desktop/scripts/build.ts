// Builds the app into out/ (electron-builder packages out/main and out/renderer, electron-builder.yml):
//
//   out/main/index.js            the main process, one ESM file for Electron's Node (electron stays external)
//   out/main/preload.cjs         the one preload (sandboxed preloads are CommonJS)
//   out/main/tray.png, @2x       the menu-bar and tray icon
//   out/renderer/core/           the window's core root: index.html, root.css, root.js
//   out/renderer/layer/          what every plugin layer serves under /_clover/: React (vendor/), the UI API
//                                (sdk-ui.js), the boot, the base styles, and the `clover` tree's bundle and styles
//
// The `clover` tree's children are found by their manifests under plugins/clover (wherever lane M's layout puts them),
// so no script names a child's path. `bun run dev:app` runs the result unpackaged.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { BunPlugin } from "bun";

const root = join(import.meta.dir, "..");
const repo = join(root, "..", "..");
const out = join(root, "out");
const layerOut = join(out, "renderer", "layer");
const coreOut = join(out, "renderer", "core");
for (const d of ["main", "renderer"]) rmSync(join(out, d), { recursive: true, force: true });
mkdirSync(join(layerOut, "vendor"), { recursive: true });
mkdirSync(coreOut, { recursive: true });

async function build(config: Parameters<typeof Bun.build>[0], what: string): Promise<void> {
  const result = await Bun.build(config);
  if (!result.success) {
    console.error(`build: ${what} failed`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

const browser = { target: "browser" as const, format: "esm" as const, minify: true, sourcemap: "linked" as const, define: { "process.env.NODE_ENV": '"production"' } };
const LAYER_EXTERNALS = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "@waifucave/clover-plugin-sdk/ui"];

// ---- The main process and the preload ----
await build({ entrypoints: [join(root, "src", "main", "index.ts")], outdir: join(out, "main"), target: "node", format: "esm", external: ["electron"], sourcemap: "linked" }, "the main process");
await build({ entrypoints: [join(root, "src", "main", "preload.ts")], outdir: join(out, "main"), target: "node", format: "cjs", external: ["electron"], naming: "[name].cjs" }, "the preload");

// ---- The tray icon: a clover leaf, as a template image (macOS draws it in the menu bar's own colour) ----
const LEAF = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g fill="#000">
<circle cx="11" cy="11" r="6"/><circle cx="21" cy="11" r="6"/><circle cx="11" cy="21" r="6"/><circle cx="21" cy="21" r="6"/>
<rect x="15" y="20" width="2.4" height="11" rx="1.2" transform="rotate(-20 16 26)"/></g></svg>`;
try {
  const { Resvg } = await import("@resvg/resvg-js");
  for (const [name, size] of [["tray.png", 16], ["tray@2x.png", 32]] as const) {
    writeFileSync(join(out, "main", name), new Resvg(LEAF, { fitTo: { mode: "width", value: size } }).render().asPng());
  }
} catch (err) {
  console.error(`build: the tray icon could not be drawn (${String(err)}); the tray will fall back to an empty image`);
}

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
      const child = byName.get(args.path.slice("@clover-child/".length));
      if (child === undefined) throw new Error(`no child plugin named ${args.path} under plugins/clover`);
      return { path: child.entry };
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

console.log(`built ${relative(root, join(out, "main"))} and ${relative(root, join(out, "renderer"))}: ${children.length} clover children found, ${modules.length} bound`);
