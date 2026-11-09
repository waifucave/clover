// The plugin host's two bundles (the process's thread and a plugin's worker), each one file with everything it imports.
// From source they're built here; a compiled core carries them prebuilt, since its sources aren't on disk. Either way
// they're written into the run folder beside the load guard (`writeHostBundles`): a worker's guard lets it load from
// there and from its plugin's folder only, never Clover's sources or their node_modules.
//
// Prebuilt (lane M): `compile:core` (packages/cli/package.json) bundles HOST_BUNDLE_ENTRIES with `bun build --target
// bun --no-macros` (the same options as `buildHostBundles`, and every dist step's `__CLOVER_DIST__` define) into
// `.build/<HOST_BUNDLE_FILES>`, and passes both files to the compile, which embeds them (Bun.embeddedFiles, named
// `clover-plugin-host-<bun's hash>.bundle`). They're read from their Blobs once (`loadPrebuiltHostBundles`). The core's
// own signature (macOS) or the signed feed it came from covers the embedded text, as it covers the bundled-plugins
// manifest. It doesn't cover the copies on disk: what runs is <run folder>/plugin-host.js and plugin-worker.js, which a
// plugin (it has node:fs, as the user) could rewrite. So they're written whole, never through a link, and their SHA-256
// is checked against the embedded (or built) text immediately before the host starts, and before each worker
// (run-file.ts; #312's review, S1). What's left is that run-file.ts limit: a same-user process swapping a file in the
// moment between the check and the exec, or the Worker's own read.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompiledBinary } from "../build-kind";
import { sha256Hex, writeRunFile } from "./run-file";

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

/** The embedded files' names in a compiled core (`compile:core`'s `.build/` outputs). */
export const HOST_BUNDLE_FILES = { host: "clover-plugin-host.bundle", worker: "clover-plugin-worker.bundle" } as const;

const EMBEDDED_NAMES = {
  host: /^clover-plugin-host(?:-[a-z0-9]+)?\.bundle$/,
  worker: /^clover-plugin-worker(?:-[a-z0-9]+)?\.bundle$/,
} as const;

/** An embedded file of a compiled core: its name, and its bytes. */
export interface EmbeddedBundleFile { name?: string; bytes(): Promise<Uint8Array> }

export type HostBundleTexts = { host: string; worker: string };

/** The two bundles among a compiled core's embedded files, or undefined when it carries neither. One without the
 *  other, two of either, or one that isn't UTF-8 throws: a core is built with both or none. */
export async function loadEmbeddedHostBundles(files: readonly EmbeddedBundleFile[]): Promise<HostBundleTexts | undefined> {
  const found = { host: files.filter((f) => EMBEDDED_NAMES.host.test(f.name ?? "")), worker: files.filter((f) => EMBEDDED_NAMES.worker.test(f.name ?? "")) };
  if (found.host.length === 0 && found.worker.length === 0) return undefined;
  for (const which of ["host", "worker"] as const) {
    if (found[which].length !== 1) throw new Error(`the core embeds ${found[which].length} ${HOST_BUNDLE_FILES[which]} files, not one`);
  }
  const decode = async (f: EmbeddedBundleFile): Promise<string> => new TextDecoder("utf-8", { fatal: true }).decode(await f.bytes());
  const texts = { host: await decode(found.host[0]!), worker: await decode(found.worker[0]!) };
  for (const which of ["host", "worker"] as const) {
    if (texts[which].length === 0) throw new Error(`the core's ${HOST_BUNDLE_FILES[which]} is empty`);
  }
  return texts;
}

let loading: Promise<HostBundleTexts | undefined> | undefined;
let loaded: HostBundleTexts | undefined;

/** Reads the core's own embedded bundles from their Blobs, once per process (later calls answer the same); undefined
 *  from source. */
export function loadPrebuiltHostBundles(): Promise<HostBundleTexts | undefined> {
  loading ??= loadEmbeddedHostBundles(typeof Bun !== "undefined" ? (Bun.embeddedFiles as unknown as readonly EmbeddedBundleFile[]) : []).then((b) => (loaded = b));
  return loading;
}

/** The bundles this core carries, once `loadPrebuiltHostBundles` has read them; undefined before that and from source. */
export function prebuiltHostBundles(): HostBundleTexts | undefined {
  return loaded;
}


/** Writes both bundles into `dir` (the run folder beside the load guard), prebuilt when the core carries them, built
 *  from source otherwise, and returns their paths and the SHA-256 of the text each must hold. A compiled core without
 *  them refuses (its sources aren't there to build from). Each is written whole (`writeRunFile`): a fresh file renamed
 *  into place, never through a link, and only when its text changed. */
export async function writeHostBundles(dir: string, o: { compiled?: boolean; prebuilt?: () => Promise<HostBundleTexts | undefined> } = {}): Promise<{ host: string; worker: string; sha256: { host: string; worker: string } }> {
  const prebuilt = await (o.prebuilt ?? loadPrebuiltHostBundles)();
  if (prebuilt === undefined && (o.compiled ?? isCompiledBinary())) {
    throw new Error(`this core was built without the plugin host's bundles (${HOST_BUNDLE_FILES.host}, ${HOST_BUNDLE_FILES.worker}), so it can't start plugins: rebuild it with compile:core`);
  }
  const texts = prebuilt ?? await buildHostBundles();
  const out = { host: join(dir, "plugin-host.js"), worker: join(dir, "plugin-worker.js") };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const which of ["host", "worker"] as const) writeRunFile(out[which], texts[which]);
  return { ...out, sha256: { host: sha256Hex(texts.host), worker: sha256Hex(texts.worker) } };
}
