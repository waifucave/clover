// Builds the web companion's page into dist/: one bundled, minified script, the HTML, the stylesheet, the manifest and
// its icons.
//   bun scripts/build.ts [--out <dir>]

import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? process.argv[outIndex + 1]! : join(root, "dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "src/main.ts")],
  outdir: out,
  target: "browser",
  format: "esm",
  minify: true,
  naming: "main.js",
  // Macros off: a `with { type: "macro" }` import would run in this build process (bun-types has no field for it).
  // LAST, so nothing after it turns them back on.
  ...{ macros: false },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
copyFileSync(join(root, "src/index.html"), join(out, "index.html"));
copyFileSync(join(root, "src/style.css"), join(out, "style.css"));
// The manifest, and the favicon and app icons it and the page name (src/icons, drawn by scripts/brand-icons.ts).
copyFileSync(join(root, "src/manifest.webmanifest"), join(out, "manifest.webmanifest"));
cpSync(join(root, "src/icons"), join(out, "icons"), { recursive: true });
console.log(`built the web companion into ${out}`);
