#!/usr/bin/env bun
// Run the S7 Electron probe (questions 1, 2, 3 and 6) in this OS's Electron. CI only: it opens windows.
//   bun run scripts/probe.ts --checks=move,throttle,capture,cost,stream --out=out/results/electron.json [--label=…]
//                            [-- <extra Electron switches, e.g. --ozone-platform=wayland>]
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// GitHub Actions sets GITHUB_ACTIONS; some agent harnesses set CI=true on a developer's Mac, so CI isn't enough.
if (process.env.GITHUB_ACTIONS !== "true" && process.env.S7_ALLOW_LOCAL !== "1") {
  console.error("probe: refusing to run here: it opens windows. It runs on GitHub Actions.");
  process.exit(2);
}
const ROOT = resolve(import.meta.dir, "..");
const main = join(ROOT, "out", "electron", "main.cjs");
if (!existsSync(main)) {
  console.error("probe: build first (bun run build)");
  process.exit(2);
}
const sep = process.argv.indexOf("--");
const ours = process.argv.slice(2, sep < 0 ? undefined : sep);
const extra = sep < 0 ? [] : process.argv.slice(sep + 1);
// node_modules/electron's index.js answers the binary's path (and fetches the binary if it isn't there yet).
const electron = (await import("electron")).default as unknown as string;
const cmd = [electron, ...extra, main, ...ours];
console.log(`probe: ${cmd.join(" ")}`);
const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", env: { ...process.env, S7_ROOT: ROOT } });
const timer = setTimeout(() => { console.error("probe: 40 minutes passed: killing Electron"); p.kill("SIGKILL"); }, 40 * 60_000);
const code = await p.exited;
clearTimeout(timer);
process.exit(code);
