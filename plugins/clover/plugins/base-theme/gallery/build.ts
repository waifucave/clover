// Builds the gallery into `dist/`: one ES module, the page, and the assets the stories load. Every bare
// import of React, three and three-vrm resolves from this folder's node_modules, so the parts' sources
// (each with its own dev install) share one copy in the bundle.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BunPlugin } from "bun";

const here = import.meta.dir;
const dist = join(here, "dist");
// The repo's plugins/ folder: this gallery is plugins/clover/plugins/base-theme/gallery.
const plugins = join(here, "..", "..", "..", "..");

const SHARED = /^(react|react-dom|three|@pixiv\/three-vrm)(\/.*)?$/;
const dedupe: BunPlugin = {
  name: "one-copy-of-each",
  setup(build) {
    build.onResolve({ filter: SHARED }, (args) => ({ path: Bun.resolveSync(args.path, here) }));
  },
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(here, "src", "main.tsx")],
  outdir: dist,
  target: "browser",
  format: "esm",
  minify: true,
  splitting: false,
  plugins: [dedupe],
  define: { "process.env.NODE_ENV": '"production"' },
  naming: "[name].[ext]",
  // Macros off: a plugin file's `with { type: "macro" }` import would run in this process (bun-types has no field for it).
  // LAST, so nothing after it turns them back on.
  ...{ macros: false },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Assets the stories fetch, at the same paths they have in their plugins.
const assets: [string, string][] = [
  ["alpha/assets", "plugins/alpha/assets"],
  ["alpha/tab", "plugins/alpha/tab"],
];
for (const [from, to] of assets) {
  const source = join(plugins, from);
  if (existsSync(source)) {
    mkdirSync(dirname(join(dist, to)), { recursive: true });
    // Only what a page loads: no tests, no installs.
    cpSync(source, join(dist, to), { recursive: true, filter: (path) => !/node_modules|\/test(\/|$)|package\.json$|bun\.lock$|tsconfig\.json$/.test(path) });
  }
}

writeFileSync(
  join(dist, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clover lane G gallery</title>
<style>
  html, body { margin: 0; background: #E9E9EE; color: #1C1B22; font: 14px system-ui, -apple-system, "Segoe UI", sans-serif; }
  body:not([data-bare]) { padding: 24px 32px 64px; }
  body[data-bare] { background: transparent; }
  .g-h1 { font-weight: 600; font-size: 20px; margin: 0 0 24px; }
  .g-story { margin: 0 0 28px; }
  .g-title { font-size: 13px; font-weight: 500; margin: 0 0 8px; }
  .g-id { color: #676674; font-weight: 400; margin-left: 8px; }
  .g-frame { position: relative; overflow: hidden; box-sizing: border-box; }
  body:not([data-bare]) .g-frame { box-shadow: 0 0 0 1px #0000001A; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="./main.js"></script>
</body>
</html>
`,
);

console.log(`gallery built: ${result.outputs.map((o) => o.path.replace(here + "/", "")).join(", ")}`);
