// Builds the web companion's page into dist/: one bundled, minified script, the HTML and the stylesheet.
//   bun scripts/build.ts [--out <dir>]

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
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
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
copyFileSync(join(root, "src/index.html"), join(out, "index.html"));
copyFileSync(join(root, "src/style.css"), join(out, "style.css"));
console.log(`built the web companion into ${out}`);
