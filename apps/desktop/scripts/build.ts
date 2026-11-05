// Builds the app into out/: the main process bundled into one ESM file for Electron's Node (electron itself
// stays external), and the renderer's static files copied beside it. electron-builder packages out/ (see
// electron-builder.yml); `bun run dev:app` (scripts/dev-app.ts) runs it unpackaged.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "out");
rmSync(join(out, "main"), { recursive: true, force: true });
rmSync(join(out, "renderer"), { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(root, "src", "main", "index.ts")],
  outdir: join(out, "main"),
  target: "node",
  format: "esm",
  external: ["electron"],
  sourcemap: "linked",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
mkdirSync(join(out, "renderer"), { recursive: true });
cpSync(join(root, "src", "renderer"), join(out, "renderer"), { recursive: true });
console.log(`built ${join("out", "main", "index.js")} and ${join("out", "renderer")}`);
