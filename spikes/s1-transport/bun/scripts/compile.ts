// Builds every check as a standalone `bun build --compile` executable in out/.
//
//   bun scripts/compile.ts
//
// @number0/iroh's napi-rs loader requires its platform package by a literal name, so the
// bundler embeds the right .node on its own. node-datachannel picks its platform package with a
// computed require(), which the bundler cannot follow; this plugin swaps that loader for a
// literal require of this platform's .node file, so it is embedded too.

import { statSync } from "node:fs";
import type { BunPlugin } from "bun";
import { emit, round } from "../src/lib/report.ts";

const platformPackage: Record<string, string> = {
  "darwin-arm64": "darwin-arm64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
};
const plat = platformPackage[`${process.platform}-${process.arch}`];
if (!plat) throw new Error(`no node-datachannel package for ${process.platform}-${process.arch}`);

const staticDatachannelBinding: BunPlugin = {
  name: "node-datachannel-static-binding",
  setup(build) {
    build.onLoad({ filter: /node-datachannel[\\/]dist[\\/]esm[\\/]lib[\\/]node-datachannel\.mjs$/ }, () => ({
      contents: `const binding = require("@node-datachannel/${plat}/node_datachannel.node");\nexport default binding;\n`,
      loader: "js",
    }));
  },
};

const entries = process.argv.slice(2).length ? process.argv.slice(2) : ["iroh-napi", "webrtc-dc", "webrtc-browser", "sidecar-ipc"];
const binaries: Record<string, { ms: number; MB: number }> = {};
for (const entry of entries) {
  const outfile = `out/${entry}${process.platform === "win32" ? ".exe" : ""}`;
  const t = performance.now();
  const result = await Bun.build({
    ...{ macros: false },
    entrypoints: [`src/${entry}.ts`],
    compile: { outfile },
    plugins: [staticDatachannelBinding],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    emit("compile", { ok: false, entry, error: result.logs.map(String).join("; ").slice(0, 500) });
    process.exit(1);
  }
  binaries[entry] = { ms: Math.round(performance.now() - t), MB: round(statSync(outfile).size / 1e6, 1) };
  console.log(`compiled ${outfile} in ${binaries[entry].ms} ms`);
}
emit("compile", { ok: true, binaries });
