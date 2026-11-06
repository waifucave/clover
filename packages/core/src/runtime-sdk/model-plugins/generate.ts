// The bundled model plugins, generated from the SDK's catalog (`bundled.ts` says what each holds). Owner: lane A.
//
//   scripts/pinned-bun packages/core/src/runtime-sdk/model-plugins/generate.ts          # check: exit 1 on a difference
//   scripts/pinned-bun packages/core/src/runtime-sdk/model-plugins/generate.ts --write  # rewrite the folders
//
// `test/runtime-sdk/model-plugins/bundled.test.ts` runs the check in the core suite, so CI fails while the committed plugins and the catalog
// disagree. Only `clover.json` and `catalog.json` are generated; a code plugin's `host/`, `package.json` and the
// rest are hand-written and left alone. A provider that leaves the catalog leaves a folder the check reports as
// stale; `--write` removes its two generated files.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GENERIC_ENDPOINT_ADAPTERS, loadCatalog, modelPluginForProvider, settingKeysOfTemplate, type WinterCatalog } from "@waifucave/clover-provider-catalog";
import { API_KEY_SECRET, BUNDLED_CHILDREN_DIR, CODE_PLUGINS, keyPlacementFor, modelPluginFolder, type AuthEntry } from "./bundled";

/** The files one provider's plugin holds, by path inside its folder. */
export type GeneratedFiles = Record<"clover.json" | "catalog.json", string>;

/**
 * Characters a reader can't see (bidi controls, zero-width ones, tags, variation selectors, the shell gallery's own
 * list): written as `\u` escapes, which parse to the same string, so no committed file holds one raw. The catalog's
 * vendor text carries some (an emoji's variation selector).
 */
const HIDDEN = /[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const escapeHidden = (text: string): string =>
  text.replace(HIDDEN, (c) => [...c].map((ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0xffff) return `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    const v = cp - 0x10000;
    return `\\u${(0xd800 + (v >> 10)).toString(16).toUpperCase()}\\u${(0xdc00 + (v & 0x3ff)).toString(16).toUpperCase()}`;
  }).join(""));
const json = (value: unknown): string => `${escapeHidden(JSON.stringify(value, null, 2))}\n`;

/** The `auth` a declarative provider declares: its API key, or nothing for a sign-in the core runs by a flow of its own. */
function declarativeAuth(authKinds: readonly string[], protocol: keyof typeof GENERIC_ENDPOINT_ADAPTERS, name: string): AuthEntry[] {
  if (!authKinds.includes("api-key")) return [];
  const placement = keyPlacementFor(protocol);
  return [{ method: "api-key", secret: API_KEY_SECRET, help: `Your ${name} API key. Clover keeps it in your credential store and adds it to ${name}'s requests itself.`, ...(placement !== undefined ? { placement } : {}) }];
}

/** One provider's plugin files. */
export function modelPluginFiles(catalog: WinterCatalog, providerId: string): GeneratedFiles {
  const provider = catalog.providers.find((p) => p.id === providerId);
  if (provider === undefined) throw new Error(`no provider ${providerId}`);
  const { entry, file } = modelPluginForProvider(catalog, providerId);
  const name = provider.displayName;
  const code = CODE_PLUGINS[providerId];
  let manifest: Record<string, unknown>;
  if (entry.endpoint !== undefined) {
    if (code !== undefined) throw new Error(`${providerId} is on a generic adapter, so it is no code plugin`);
    const keys = provider.endpointTemplate !== undefined && provider.defaultEndpoints["api"] === undefined ? settingKeysOfTemplate(provider.endpointTemplate) : [];
    manifest = {
      manifest: 1,
      name,
      description: `${name}'s models, on its ${entry.endpoint.protocol} endpoint. Generated from the SDK's catalog.`,
      ...(keys.length > 0
        ? { settings: Object.fromEntries(keys.map((k) => [k, { type: "string", title: k, description: `Your ${name} ${k}, as its endpoint names it (${provider.endpointTemplate}).`, required: true }])) }
        : {}),
      contributes: { models: [{ provider: providerId, name, catalog: "catalog.json", auth: declarativeAuth(provider.authKinds, entry.endpoint.protocol, name), endpoint: entry.endpoint }] },
    };
  } else {
    if (code === undefined) throw new Error(`${providerId} runs on ${provider.adapterId}, a code plugin's adapter, and bundled.ts has no template for it`);
    manifest = {
      manifest: 1,
      name,
      description: `${name}'s models, through its own adapter. Generated from the SDK's catalog; its host module is hand-written.`,
      engines: { clover: "^1.0.0" },
      host: { entry: "host/index.ts", runtime: code.runtime },
      capabilities: code.capabilities,
      contributes: { models: [{ provider: providerId, name, catalog: "catalog.json", auth: code.auth, adapter: entry.adapter }] },
    };
  }
  return { "clover.json": json(manifest), "catalog.json": json(file) };
}

/** Every provider's plugin files, by folder name. */
export function generateModelPlugins(catalog: WinterCatalog = loadCatalog()): Map<string, GeneratedFiles> {
  const out = new Map<string, GeneratedFiles>();
  for (const p of catalog.providers) out.set(modelPluginFolder(p.id), modelPluginFiles(catalog, p.id));
  return out;
}

export interface ModelPluginDrift {
  folder: string;
  file: string;
  problem: "missing" | "differs" | "stale";
}

/** How the folders under `dir` differ from what the catalog generates. Empty when they match. */
export function checkModelPlugins(dir: string = BUNDLED_CHILDREN_DIR, catalog: WinterCatalog = loadCatalog()): ModelPluginDrift[] {
  const drift: ModelPluginDrift[] = [];
  const generated = generateModelPlugins(catalog);
  for (const [folder, files] of generated) {
    for (const [file, content] of Object.entries(files)) {
      const path = join(dir, folder, file);
      if (!existsSync(path)) drift.push({ folder, file, problem: "missing" });
      else if (readFileSync(path, "utf8") !== content) drift.push({ folder, file, problem: "differs" });
    }
  }
  for (const folder of existsSync(dir) ? readdirSync(dir) : []) {
    if (!folder.startsWith("model-") || generated.has(folder)) continue;
    for (const file of ["clover.json", "catalog.json"]) if (existsSync(join(dir, folder, file))) drift.push({ folder, file, problem: "stale" });
  }
  return drift;
}

/** Rewrites the generated files under `dir`; returns what changed. */
export function writeModelPlugins(dir: string = BUNDLED_CHILDREN_DIR, catalog: WinterCatalog = loadCatalog()): ModelPluginDrift[] {
  const drift = checkModelPlugins(dir, catalog);
  const generated = generateModelPlugins(catalog);
  for (const d of drift) {
    const path = join(dir, d.folder, d.file);
    if (d.problem === "stale") {
      rmSync(path, { force: true });
      continue;
    }
    mkdirSync(join(dir, d.folder), { recursive: true });
    writeFileSync(path, generated.get(d.folder)![d.file as keyof GeneratedFiles]);
  }
  return drift;
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const drift = write ? writeModelPlugins() : checkModelPlugins();
  for (const d of drift) console.log(`${write ? "wrote" : d.problem}: ${d.folder}/${d.file}${write ? ` (${d.problem})` : ""}`);
  if (!write && drift.length > 0) {
    console.error(`${drift.length} generated file(s) differ from the SDK's catalog: run with --write`);
    process.exit(1);
  }
  console.log(write ? `${drift.length} file(s) written` : "the bundled model plugins match the SDK's catalog");
}
