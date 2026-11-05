// `bun run gallery` (docs/clover-layout.md, "A gallery"): builds lane G's gallery (the base theme, the island, the
// Dispatch pill, the usage views, the notifications, the avatars and Alpha's tab) and, in CI only, renders every story
// to PNGs under $CLOVER_GALLERY_OUT/base-theme/ with the Chromium Playwright installs for itself. Anywhere else it
// stops after the build: the renderer launches a browser, which never runs on someone's desk.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const here = import.meta.dir;

function run(command: string, args: string[], env: Record<string, string> = {}): void {
  const result = spawnSync(command, args, { cwd: here, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [join(here, "build.ts")]);

if (process.env.GITHUB_ACTIONS !== "true") {
  console.log("gallery built in gallery/dist; it renders to PNGs in CI only");
  process.exit(0);
}

const playwright = dirname(Bun.resolveSync("playwright/package.json", here));
run("node", [join(playwright, "cli.js"), "install", "--with-deps", "chromium"]);
const out = join(process.env.CLOVER_GALLERY_OUT ?? join(here, "out"), "base-theme");
run("node", [join(here, "render.mjs")], { GALLERY_OUT: out });
