// The plugin host's two bundles (the process's thread and a plugin's worker), each one file with everything it imports.
// From source they're built here; a compiled core carries them prebuilt (lane M embeds them, `prebuiltHostBundles`),
// since its sources aren't on disk. Either way they're written into the run folder beside the load guard
// (`writeHostBundles`): a worker's guard lets it load from there and from its plugin's folder only, never Clover's
// sources or their node_modules.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** What each bundle is built from. */
export const HOST_BUNDLE_ENTRIES = {
  host: fileURLToPath(new URL("./process-main.ts", import.meta.url)),
  worker: fileURLToPath(new URL("./worker-main.ts", import.meta.url)),
} as const;

/** Builds both bundles and returns their text. `define` passes a build's constants (a dist build's `__CLOVER_DIST__`). */
export async function buildHostBundles(o: { define?: Record<string, string> } = {}): Promise<{ host: string; worker: string }> {
  const result = await Bun.build({
    entrypoints: [HOST_BUNDLE_ENTRIES.host, HOST_BUNDLE_ENTRIES.worker],
    target: "bun", format: "esm", splitting: false, minify: false, sourcemap: "none", throw: false,
    ...(o.define !== undefined ? { define: o.define } : {}),
    // Macros off (#289): an import `with { type: "macro" }` would run in this process. Last, so nothing turns them on.
    ...{ macros: false },
  });
  if (!result.success) throw new Error(`the plugin host's bundles didn't build: ${result.logs.map(String).join("; ")}`);
  const out: { host?: string; worker?: string } = {};
  for (const o of result.outputs) out[o.path.includes("worker-main") ? "worker" : "host"] = await o.text();
  if (out.host === undefined || out.worker === undefined) throw new Error("the plugin host's bundles didn't build: an output is missing");
  return { host: out.host, worker: out.worker };
}

/** The bundles a compiled core carries, or undefined from source (lane M fills this in with the embedded files). */
export function prebuiltHostBundles(): { host: string; worker: string } | undefined {
  return undefined;
}

/** Writes both bundles into `dir` (the run folder beside the load guard), prebuilt when the core carries them, built
 *  otherwise. Each file is rewritten only when its text changes. */
export async function writeHostBundles(dir: string): Promise<{ host: string; worker: string }> {
  const texts = prebuiltHostBundles() ?? await buildHostBundles();
  const out = { host: join(dir, "plugin-host.js"), worker: join(dir, "plugin-worker.js") };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const which of ["host", "worker"] as const) {
    let current: string | undefined;
    try {
      current = readFileSync(out[which], "utf8");
    } catch {
      current = undefined;
    }
    if (current !== texts[which]) writeFileSync(out[which], texts[which], { mode: 0o600 });
  }
  return out;
}
