// The shell's `gallery` script, run by CI's gallery job (docs/clover-layout.md, "A gallery"): builds the gallery,
// installs Playwright's Chromium and renders every story to PNG, light and dark, under $CLOVER_GALLERY_OUT/shell/
// (`site/`, the page, and `png/<theme>/<part>--<state>.png`). CI only: it downloads and runs a browser.
import { spawnSync } from "node:child_process";
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

const pkg = join(import.meta.dir, "..");
const out = join(root, "shell");
function run(cmd: string[]): void {
  console.log(`$ ${cmd.join(" ")}`);
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: pkg, stdio: "inherit", env: { ...process.env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run(["bun", "gallery/build.ts", join(out, "site")]);
run(["node", "node_modules/playwright/cli.js", "install", "--with-deps", "chromium"]);
run(["node", "gallery/shoot.mjs", join(out, "site"), join(out, "png")]);
