// The base theme gallery's `gallery` script, run by CI's gallery job (docs/clover-layout.md, "A gallery"): builds the
// page, installs Playwright's Chromium, renders every story (render.mjs) and copies the result, `out/`, to
// $CLOVER_GALLERY_OUT/base-theme/. CI only: it downloads and runs a browser (render.mjs refuses to run elsewhere too).
import { spawnSync } from "node:child_process";
import { cpSync } from "node:fs";
import { join } from "node:path";

const root = process.env.CLOVER_GALLERY_OUT;
if (root === undefined || root === "") {
  console.error("gallery: set CLOVER_GALLERY_OUT to the folder the galleries go in (CI's gallery job does)");
  process.exit(2);
}
if (process.env.GITHUB_ACTIONS !== "true") {
  console.error("gallery: renders in CI only (GITHUB_ACTIONS=true), since it downloads and runs Chromium");
  process.exit(2);
}

const here = import.meta.dir;
function run(cmd: string[]): void {
  console.log(`$ ${cmd.join(" ")}`);
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: here, stdio: "inherit", env: { ...process.env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run(["bun", "run", "build.ts"]);
run(["node", "node_modules/playwright/cli.js", "install", "--with-deps", "chromium"]);
run(["node", "render.mjs"]);
cpSync(join(here, "out"), join(root, "base-theme"), { recursive: true });
