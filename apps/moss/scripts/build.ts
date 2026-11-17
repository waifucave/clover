// Builds MOSS into out/ (electron-builder packages out/main and out/renderer, electron-builder.yml):
//
//   out/main/index.js        the main process, one ESM file for Electron's Node (electron stays external)
//   out/main/preload.cjs     the one preload (sandboxed preloads are CommonJS)
//   out/renderer/window/     MOSS's own window: index.html, window.js (its React app, the living-bots kit inside), window.css, pages.css
//   out/main/native/screen.node  macOS: the screen add-on (native/input/macos/screen.mm), the overlap check's window list
//
// `--test-build`: the main process and the window are compiled with the test-build label (scripts/test-build.ts) in
// place of `false`, which turns on the UI test's smoke run, the renders and the test hooks; a real build compiles all of
// it out. `--release`: the release define, as MOSS Code's build passes it.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { releaseBuildDefine, RELEASE_BUILD_BANNER, testBuildDefine } from "../../../scripts/test-build";

const unknown = process.argv.slice(2).filter((a) => a !== "--test-build" && a !== "--release");
if (unknown.length > 0) {
  console.error(`build: unknown argument ${unknown[0]} (usage: build [--test-build | --release])`);
  process.exit(2);
}
const testBuild = process.argv.includes("--test-build");
const releaseBuild = process.argv.includes("--release");
if (testBuild && releaseBuild) {
  console.error("build: --test-build and --release are two different builds");
  process.exit(2);
}
const root = join(import.meta.dir, "..");
const out = join(root, "out");
for (const d of ["main", "renderer"]) rmSync(join(out, d), { recursive: true, force: true });
const windowOut = join(out, "renderer", "window");
mkdirSync(windowOut, { recursive: true });

async function build(config: Parameters<typeof Bun.build>[0], what: string): Promise<void> {
  // Macros off: a `with { type: "macro" }` import would run in this build process (bun-types has no field, hence the spread).
  const result = await Bun.build({ ...config, ...{ macros: false } });
  if (!result.success) {
    console.error(`build: ${what} failed`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

const defines = { ...testBuildDefine(testBuild), ...releaseBuildDefine(releaseBuild) };
await build({ entrypoints: [join(root, "src", "main", "index.ts")], outdir: join(out, "main"), target: "node", format: "esm", external: ["electron"], sourcemap: "linked", define: defines, ...(releaseBuild ? { banner: RELEASE_BUILD_BANNER } : {}) }, "the main process");
await build({ entrypoints: [join(root, "src", "main", "preload.ts")], outdir: join(out, "main"), target: "node", format: "cjs", external: ["electron"], naming: "[name].cjs" }, "the preload");
await build({
  entrypoints: [join(root, "src", "window", "App.tsx")], outdir: windowOut, naming: "window.[ext]", target: "browser", format: "esm", minify: true, sourcemap: "none",
  define: { "process.env.NODE_ENV": '"production"', ...testBuildDefine(testBuild) },
}, "the window");
cpSync(join(root, "src", "window", "index.html"), join(windowOut, "index.html"));
cpSync(join(root, "src", "window", "window.css"), join(windowOut, "window.css"));
// The pages' own styles (lane MA2's: the side panel, Plugins and Settings), after the window's.
cpSync(join(root, "src", "window", "pages.css"), join(windowOut, "pages.css"));

// The screen add-on (macOS; native/input/macos/screen.mm, lane RT's): the overlap check's window list (`windowsAbove`,
// `bundleOf`), built as MOSS Code's build does, with clang alone. Where it can't be built (no Xcode tools) MOSS runs
// without it: the in-page reading stands alone. Its install name is a fixed `@rpath/screen.node`, so no machine's build
// folder is written into the app. (Packaging it, `asarUnpack` and signing, is the packaging lane's.)
if (process.platform === "darwin") {
  const repo = join(root, "..", "..");
  const source = join(repo, "native", "input", "macos", "screen.mm");
  const dest = join(out, "main", "native", "screen.node");
  mkdirSync(dirname(dest), { recursive: true });
  const r = spawnSync("xcrun", ["clang++", "-x", "objective-c++", "-std=c++17", "-fobjc-arc", "-O2", "-arch", "arm64", "-mmacosx-version-min=14.0", "-shared", "-undefined", "dynamic_lookup", "-Wl,-install_name,@rpath/screen.node", "-framework", "AppKit", "-o", dest, source], { encoding: "utf8" });
  if (r.status !== 0) console.warn(`build: the screen add-on wasn't built (${(r.stderr || r.error?.message || "clang failed").trim().split("\n")[0]}); MOSS runs without it`);
}

console.log(`built ${relative(root, join(out, "main"))} and ${relative(root, windowOut)}${testBuild ? " (test build)" : ""}`);
