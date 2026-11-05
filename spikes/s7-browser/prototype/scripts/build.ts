#!/usr/bin/env bun
// Build the spike's pieces into out/ (launches nothing):
//   out/pages/       the probe, viewer and streamer pages (browser bundles + HTML)
//   out/electron/    the S7 Electron probe's main process (CommonJS), and the viewport's preload (round twelve)
//   out/pair/app/    the pair's Electron app (main.cjs + package.json)
//   out/pair/clover-core-s7[.exe]   the pair's daemon, compiled (only with --daemon)
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const out = join(ROOT, "out");

async function bundle(opts: Parameters<typeof Bun.build>[0], what: string): Promise<void> {
  const r = await Bun.build(opts);
  if (!r.success) {
    for (const l of r.logs) console.error(l);
    throw new Error(`build failed: ${what}`);
  }
  console.log(`built ${what}`);
}

mkdirSync(join(out, "pages"), { recursive: true });
await bundle({
  entrypoints: ["probe", "viewer", "streamer", "vp-page"].map((p) => join(ROOT, "src", "pages", `${p}.ts`)),
  outdir: join(out, "pages"),
  target: "browser",
  format: "iife",
  minify: false,
}, "pages");
for (const f of readdirSync(join(ROOT, "src", "pages"))) if (f.endsWith(".html")) copyFileSync(join(ROOT, "src", "pages", f), join(out, "pages", f));

const external = ["electron", "bufferutil", "utf-8-validate"];
await bundle({ entrypoints: [join(ROOT, "src", "electron", "main.ts")], outdir: join(out, "electron"), naming: "main.cjs", target: "node", format: "cjs", external }, "electron probe");
// a sandboxed preload: one file, `electron` left to the preload's own require
await bundle({ entrypoints: [join(ROOT, "src", "pages", "vp-preload.ts")], outdir: join(out, "electron"), naming: "vp-preload.cjs", target: "node", format: "cjs", external: ["electron"] }, "viewport preload");

mkdirSync(join(out, "pair", "app"), { recursive: true });
await bundle({ entrypoints: [join(ROOT, "src", "pair", "app-main.ts")], outdir: join(out, "pair", "app"), naming: "main.cjs", target: "node", format: "cjs", external }, "pair app");
writeFileSync(join(out, "pair", "app", "package.json"), JSON.stringify({ name: "clover-s7-pair-app", productName: "Clover S7", version: "0.0.0", main: "main.cjs" }, null, 2));

if (process.argv.includes("--daemon")) {
  const exe = process.platform === "win32" ? ".exe" : "";
  const target = join(out, "pair", `clover-core-s7${exe}`);
  const p = Bun.spawnSync(["bun", "build", "--compile", join(ROOT, "src", "pair", "daemon.ts"), "--outfile", target], { stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error("daemon compile failed");
  console.log(`built ${target}`);
}
